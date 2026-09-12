-- Pharmacy billing & stock management schema
-- Run this once in Supabase's SQL editor

create table if not exists products (
  id            bigserial primary key,
  name          text not null,
  category      text,
  unit_price    numeric(10, 2) not null default 0,
  stock_qty     integer not null default 0,
  low_stock_threshold integer not null default 10,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create extension if not exists pg_trgm;
create index if not exists idx_products_name_trgm on products using gin (name gin_trgm_ops);

create table if not exists sales (
  id          bigserial primary key,
  total       numeric(10, 2) not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists sale_items (
  id          bigserial primary key,
  sale_id     bigint not null references sales(id) on delete cascade,
  product_id  bigint not null references products(id),
  product_name text not null,       -- snapshot, in case product is later renamed
  qty         integer not null,
  unit_price  numeric(10, 2) not null,
  line_total  numeric(10, 2) not null
);

-- RLS is on for all tables. The backend talks to Supabase using the SECRET key
-- (service role), which bypasses RLS entirely, so no policies are needed for
-- this app to work. If you ever call these tables directly from the browser
-- with the publishable/anon key, you'd need to add policies here.
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;

-- Sample products so you can try it immediately (delete later)
insert into products (name, category, unit_price, stock_qty, low_stock_threshold) values
  ('Paracetamol 500mg', 'Tablet', 2.50, 120, 20),
  ('Amoxicillin 250mg', 'Capsule', 8.00, 45, 15),
  ('Cough Syrup 100ml', 'Syrup', 45.00, 8, 10),
  ('Vitamin C 500mg', 'Tablet', 5.00, 200, 30),
  ('ORS Sachet', 'Sachet', 10.00, 5, 20)
on conflict do nothing;

-- ---------- RPC: restock (atomic increment) ----------
create or replace function restock_product(p_id bigint, p_qty int)
returns products
language plpgsql
as $$
declare
  updated products;
begin
  update products set stock_qty = stock_qty + p_qty, updated_at = now()
  where id = p_id
  returning * into updated;

  if not found then
    raise exception 'Product % not found', p_id;
  end if;

  return updated;
end;
$$;

-- ---------- RPC: checkout a sale (atomic: stock check, decrement, sale + line items) ----------
-- p_items shape: [{"product_id": 1, "qty": 2}, {"product_id": 3, "qty": 1}]
create or replace function checkout_sale(p_items jsonb)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  prod products%rowtype;
  v_total numeric(10,2) := 0;
  v_sale_id bigint;
  v_line_total numeric(10,2);
  v_items jsonb := '[]'::jsonb;
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'No items in sale';
  end if;

  -- lock every involved row up front so concurrent sales can't oversell
  for item in select * from jsonb_array_elements(p_items)
  loop
    select * into prod from products where id = (item->>'product_id')::bigint for update;
    if not found then
      raise exception 'Product % not found', item->>'product_id';
    end if;
    if prod.stock_qty < (item->>'qty')::int then
      raise exception 'Not enough stock for % (have %, need %)', prod.name, prod.stock_qty, (item->>'qty')::int;
    end if;
  end loop;

  insert into sales (total) values (0) returning id into v_sale_id;

  for item in select * from jsonb_array_elements(p_items)
  loop
    select * into prod from products where id = (item->>'product_id')::bigint;
    v_line_total := prod.unit_price * (item->>'qty')::int;
    v_total := v_total + v_line_total;

    insert into sale_items (sale_id, product_id, product_name, qty, unit_price, line_total)
    values (v_sale_id, prod.id, prod.name, (item->>'qty')::int, prod.unit_price, v_line_total);

    update products set stock_qty = stock_qty - (item->>'qty')::int, updated_at = now()
    where id = prod.id;

    v_items := v_items || jsonb_build_object(
      'product_id', prod.id, 'product_name', prod.name,
      'qty', (item->>'qty')::int, 'unit_price', prod.unit_price, 'line_total', v_line_total
    );
  end loop;

  update sales set total = v_total where id = v_sale_id;

  return jsonb_build_object('id', v_sale_id, 'total', v_total, 'items', v_items, 'created_at', now());
end;
$$;
