-- Pharmacy billing & stock management schema
-- Run this once in Supabase's SQL editor.
-- NOTE: if you already ran the old version of this file, either reset the
-- project's tables first or drop products/sales/sale_items/batches and the
-- functions before re-running (this file uses `create table if not exists`,
-- so it won't rebuild tables that already exist in the old shape).

create table if not exists products (
  id            bigserial primary key,
  name          text not null,
  category      text not null default 'Other' check (category in ('Tablet','Syrup','Ointment','Other')),
  manufacturer  text,
  low_stock_threshold integer not null default 10,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create extension if not exists pg_trgm;
create index if not exists idx_products_name_trgm on products using gin (name gin_trgm_ops);

-- Each restock creates a new batch. Stock and "current price" are always
-- derived from batches, never stored redundantly on products.
create table if not exists batches (
  id            bigserial primary key,
  product_id    bigint not null references products(id) on delete cascade,
  batch_number  text,
  seller        text,                          -- supplier/distributor this batch was bought from
  pack_size     integer not null default 1,     -- e.g. 10 tablets per strip
  pack_price    numeric(10,2),                  -- price for one pack (in rupees), for reference
  unit_price    numeric(10,2) not null,         -- price per single unit = pack_price / pack_size
  qty_received  integer not null,
  qty_remaining integer not null,
  expiry_date   date,                           -- optional
  received_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists idx_batches_product on batches(product_id);
create index if not exists idx_batches_fefo on batches(product_id, expiry_date, received_at);

create table if not exists sales (
  id          bigserial primary key,
  total       numeric(10, 2) not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists sale_items (
  id            bigserial primary key,
  sale_id       bigint not null references sales(id) on delete cascade,
  product_id    bigint not null references products(id),
  product_name  text not null,
  batch_id      bigint references batches(id),
  batch_number  text,
  qty           integer not null,
  unit_price    numeric(10, 2) not null,
  line_total    numeric(10, 2) not null
);

-- Computed view: total remaining stock + the price that will actually be
-- charged next (the oldest active batch's price), per product.
create or replace view product_summary as
select
  p.id, p.name, p.category, p.manufacturer, p.low_stock_threshold, p.created_at, p.updated_at,
  coalesce((select sum(b.qty_remaining) from batches b where b.product_id = p.id and b.qty_remaining > 0), 0)::int as stock_qty,
  (
    select b2.unit_price from batches b2
    where b2.product_id = p.id and b2.qty_remaining > 0
    order by b2.expiry_date asc nulls last, b2.received_at asc
    limit 1
  ) as unit_price
from products p;

-- RLS is on for all tables. The backend talks to Supabase using the SECRET
-- key (service role), which bypasses RLS entirely, so no policies are
-- needed for this app to work.
alter table products enable row level security;
alter table batches enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;

-- Sample data so you can try it immediately (delete later)
insert into products (name, category, manufacturer, low_stock_threshold) values
  ('Paracetamol 500mg', 'Tablet', 'Cipla', 20),
  ('Amoxicillin 250mg', 'Tablet', 'Sun Pharma', 15),
  ('Cough Syrup 100ml', 'Syrup', 'Dabur', 10),
  ('Vitamin C 500mg', 'Tablet', 'HealthVit', 30),
  ('ORS Sachet', 'Other', 'FDC Ltd', 20)
on conflict do nothing;

insert into batches (product_id, batch_number, seller, pack_size, pack_price, unit_price, qty_received, qty_remaining, expiry_date)
select id, 'B-1001', 'MedSupply Distributors', 10, 25.00, 2.50, 120, 120, '2027-06-30' from products where name = 'Paracetamol 500mg'
union all
select id, 'B-2044', 'HealthCare Traders', 10, 80.00, 8.00, 45, 45, '2027-01-31' from products where name = 'Amoxicillin 250mg'
union all
select id, 'B-3011', 'MedSupply Distributors', 1, 45.00, 45.00, 8, 8, '2026-12-15' from products where name = 'Cough Syrup 100ml'
union all
select id, 'B-4400', 'HealthCare Traders', 15, 75.00, 5.00, 200, 200, '2028-03-31' from products where name = 'Vitamin C 500mg'
union all
select id, 'B-5090', 'MedSupply Distributors', 1, 10.00, 10.00, 5, 5, '2026-10-31' from products where name = 'ORS Sachet'
on conflict do nothing;

-- ---------- RPC: checkout a sale ----------
-- p_items shape: [{"product_id":1,"qty":2,"batch_id":null}, ...]
-- batch_id null/omitted => auto-deduct oldest batch(es) first (FEFO by expiry, then FIFO by received date)
create or replace function checkout_sale(p_items jsonb)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  remaining_qty int;
  v_sale_id bigint;
  v_total numeric(10,2) := 0;
  v_items jsonb := '[]'::jsonb;
  b record;
  v_take int;
  v_line_total numeric(10,2);
  prod_name text;
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'No items in sale';
  end if;

  insert into sales (total) values (0) returning id into v_sale_id;

  for item in select * from jsonb_array_elements(p_items)
  loop
    remaining_qty := (item->>'qty')::int;

    select name into prod_name from products where id = (item->>'product_id')::bigint;
    if prod_name is null then
      raise exception 'Product % not found', item->>'product_id';
    end if;

    if (item ? 'batch_id') and (item->>'batch_id') is not null then
      select * into b from batches where id = (item->>'batch_id')::bigint for update;
      if not found then
        raise exception 'Batch % not found', item->>'batch_id';
      end if;
      if b.qty_remaining < remaining_qty then
        raise exception 'Not enough stock in batch % for % (have %, need %)', b.batch_number, prod_name, b.qty_remaining, remaining_qty;
      end if;

      update batches set qty_remaining = qty_remaining - remaining_qty where id = b.id;
      v_line_total := b.unit_price * remaining_qty;
      v_total := v_total + v_line_total;

      insert into sale_items (sale_id, product_id, product_name, batch_id, batch_number, qty, unit_price, line_total)
      values (v_sale_id, b.product_id, prod_name, b.id, b.batch_number, remaining_qty, b.unit_price, v_line_total);

      v_items := v_items || jsonb_build_object(
        'product_id', b.product_id, 'product_name', prod_name, 'batch_number', b.batch_number,
        'qty', remaining_qty, 'unit_price', b.unit_price, 'line_total', v_line_total
      );
    else
      for b in
        select * from batches
        where product_id = (item->>'product_id')::bigint and qty_remaining > 0
        order by expiry_date asc nulls last, received_at asc
        for update
      loop
        exit when remaining_qty <= 0;
        v_take := least(b.qty_remaining, remaining_qty);

        update batches set qty_remaining = qty_remaining - v_take where id = b.id;
        v_line_total := b.unit_price * v_take;
        v_total := v_total + v_line_total;

        insert into sale_items (sale_id, product_id, product_name, batch_id, batch_number, qty, unit_price, line_total)
        values (v_sale_id, b.product_id, prod_name, b.id, b.batch_number, v_take, b.unit_price, v_line_total);

        v_items := v_items || jsonb_build_object(
          'product_id', b.product_id, 'product_name', prod_name, 'batch_number', b.batch_number,
          'qty', v_take, 'unit_price', b.unit_price, 'line_total', v_line_total
        );

        remaining_qty := remaining_qty - v_take;
      end loop;

      if remaining_qty > 0 then
        raise exception 'Not enough total stock for % (short by %)', prod_name, remaining_qty;
      end if;
    end if;
  end loop;

  update sales set total = v_total where id = v_sale_id;

  return jsonb_build_object('id', v_sale_id, 'total', v_total, 'items', v_items, 'created_at', now());
end;
$$;
