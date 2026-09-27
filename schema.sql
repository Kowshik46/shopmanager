-- Pharmacy billing & stock management schema
-- Run this once in Supabase's SQL editor.
--
-- This version adds dealers (was a free-text "seller" column), per-batch cost
-- price alongside MRP (for profit tracking), makes expiry required, and adds
-- prescription_required + rack_location to products. If you ran an earlier
-- version of this file, drop the old objects first:
--   drop table if exists sale_items, sales, batches, products, dealers cascade;
--   drop function if exists checkout_sale;
--   drop view if exists product_summary;

create table if not exists dealers (
  id         bigserial primary key,
  name       text not null unique,
  phone      text,
  address    text,
  gstin      text,
  notes      text,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id                     bigserial primary key,
  name                   text not null,
  category               text not null default 'Other' check (category in ('Tablet','Syrup','Ointment','Other')),
  manufacturer           text,
  prescription_required  boolean not null default false,  -- Schedule H/H1/X
  rack_location          text,                             -- shop's own shelf code, e.g. 'A1'
  low_stock_threshold    integer not null default 10,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create extension if not exists pg_trgm;
create index if not exists idx_products_name_trgm on products using gin (name gin_trgm_ops);

-- Each restock creates a new batch. Stock and "current price" are always
-- derived from batches, never stored redundantly on products.
create table if not exists batches (
  id               bigserial primary key,
  product_id       bigint not null references products(id) on delete cascade,
  dealer_id        bigint references dealers(id),
  batch_number     text,
  pack_size        integer not null default 1,     -- e.g. 10 tablets per strip
  mrp_pack_price   numeric(10,2) not null,          -- MRP for one pack (rupees)
  mrp_unit_price   numeric(10,2) not null,          -- what we charge = mrp_pack_price / pack_size
  cost_pack_price  numeric(10,2) not null,          -- what we paid the dealer, per pack
  cost_unit_price  numeric(10,2) not null,          -- cost_pack_price / pack_size
  qty_received     integer not null,
  qty_remaining    integer not null,
  expiry_date      date not null,
  received_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists idx_batches_product on batches(product_id);
create index if not exists idx_batches_fefo on batches(product_id, expiry_date, received_at);

create table if not exists sales (
  id             bigserial primary key,
  total          numeric(10, 2) not null default 0,  -- what the customer paid (MRP side)
  total_cost     numeric(10, 2) not null default 0,   -- what we paid the dealer for what was sold
  patient_name   text,                                -- set only when a bill was generated
  patient_age    integer,
  patient_phone  text,
  created_at     timestamptz not null default now()
);

create table if not exists sale_items (
  id            bigserial primary key,
  sale_id       bigint not null references sales(id) on delete cascade,
  product_id    bigint not null references products(id),
  product_name  text not null,
  batch_id      bigint references batches(id),
  batch_number  text,
  qty           integer not null,
  unit_price    numeric(10, 2) not null,  -- MRP charged, snapshotted from the batch
  cost_price    numeric(10, 2) not null,  -- dealer cost, snapshotted from the batch (for margin)
  line_total    numeric(10, 2) not null
);

-- Computed view: total remaining stock + the price that will actually be
-- charged next (the oldest active batch's price), per product.
create or replace view product_summary as
select
  p.id, p.name, p.category, p.manufacturer, p.prescription_required,
  p.rack_location, p.low_stock_threshold, p.created_at, p.updated_at,
  coalesce((select sum(b.qty_remaining) from batches b where b.product_id = p.id and b.qty_remaining > 0), 0)::int as stock_qty,
  (
    select b2.mrp_unit_price from batches b2
    where b2.product_id = p.id and b2.qty_remaining > 0
    order by b2.expiry_date asc, b2.received_at asc
    limit 1
  ) as unit_price
from products p;

-- RLS is on for all tables. The backend talks to Supabase using the SECRET
-- key (service role), which bypasses RLS entirely, so no policies are
-- needed for this app to work.
alter table dealers enable row level security;
alter table products enable row level security;
alter table batches enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;

-- Sample data so you can try it immediately (delete later)
insert into dealers (name, phone) values
  ('MedSupply Distributors', '9876543210'),
  ('HealthCare Traders', '9876500000')
on conflict do nothing;

insert into products (name, category, manufacturer, prescription_required, rack_location, low_stock_threshold) values
  ('Paracetamol 500mg', 'Tablet', 'Cipla', false, 'A1', 20),
  ('Amoxicillin 250mg', 'Tablet', 'Sun Pharma', true, 'A2', 15),
  ('Cough Syrup 100ml', 'Syrup', 'Dabur', false, 'B1', 10),
  ('Vitamin C 500mg', 'Tablet', 'HealthVit', false, 'A3', 30),
  ('ORS Sachet', 'Other', 'FDC Ltd', false, 'C1', 20)
on conflict do nothing;

insert into batches (product_id, dealer_id, batch_number, pack_size, mrp_pack_price, mrp_unit_price, cost_pack_price, cost_unit_price, qty_received, qty_remaining, expiry_date)
select p.id, d.id, 'B-1001', 10, 25.00, 2.50, 20.00, 2.00, 120, 120, '2027-06-30'::date
from products p, dealers d where p.name = 'Paracetamol 500mg' and d.name = 'MedSupply Distributors'
union all
select p.id, d.id, 'B-2044', 10, 80.00, 8.00, 65.00, 6.50, 45, 45, '2027-01-31'::date
from products p, dealers d where p.name = 'Amoxicillin 250mg' and d.name = 'HealthCare Traders'
union all
select p.id, d.id, 'B-3011', 1, 45.00, 45.00, 36.00, 36.00, 8, 8, '2026-12-15'::date
from products p, dealers d where p.name = 'Cough Syrup 100ml' and d.name = 'MedSupply Distributors'
union all
select p.id, d.id, 'B-4400', 15, 75.00, 5.00, 60.00, 4.00, 200, 200, '2028-03-31'::date
from products p, dealers d where p.name = 'Vitamin C 500mg' and d.name = 'HealthCare Traders'
union all
select p.id, d.id, 'B-5090', 1, 10.00, 10.00, 7.50, 7.50, 5, 5, '2026-10-31'::date
from products p, dealers d where p.name = 'ORS Sachet' and d.name = 'MedSupply Distributors'
on conflict do nothing;

-- ---------- RPC: checkout a sale ----------
-- p_items shape: [{"product_id":1,"qty":2,"batch_id":null}, ...]
-- batch_id null/omitted => auto-deduct oldest batch(es) first (FEFO by expiry, then FIFO by received date)
create or replace function checkout_sale(
  p_items jsonb,
  p_patient_name text default null,
  p_patient_age int default null,
  p_patient_phone text default null
)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  remaining_qty int;
  v_sale_id bigint;
  v_total numeric(10,2) := 0;
  v_total_cost numeric(10,2) := 0;
  v_items jsonb := '[]'::jsonb;
  b record;
  v_take int;
  v_line_total numeric(10,2);
  v_line_cost numeric(10,2);
  prod_name text;
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'No items in sale';
  end if;

  insert into sales (total, total_cost, patient_name, patient_age, patient_phone)
  values (0, 0, p_patient_name, p_patient_age, p_patient_phone)
  returning id into v_sale_id;

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
      v_line_total := b.mrp_unit_price * remaining_qty;
      v_line_cost := b.cost_unit_price * remaining_qty;
      v_total := v_total + v_line_total;
      v_total_cost := v_total_cost + v_line_cost;

      insert into sale_items (sale_id, product_id, product_name, batch_id, batch_number, qty, unit_price, cost_price, line_total)
      values (v_sale_id, b.product_id, prod_name, b.id, b.batch_number, remaining_qty, b.mrp_unit_price, b.cost_unit_price, v_line_total);

      v_items := v_items || jsonb_build_object(
        'product_id', b.product_id, 'product_name', prod_name, 'batch_number', b.batch_number,
        'qty', remaining_qty, 'unit_price', b.mrp_unit_price, 'line_total', v_line_total
      );
    else
      for b in
        select * from batches
        where product_id = (item->>'product_id')::bigint and qty_remaining > 0
        order by expiry_date asc, received_at asc
        for update
      loop
        exit when remaining_qty <= 0;
        v_take := least(b.qty_remaining, remaining_qty);

        update batches set qty_remaining = qty_remaining - v_take where id = b.id;
        v_line_total := b.mrp_unit_price * v_take;
        v_line_cost := b.cost_unit_price * v_take;
        v_total := v_total + v_line_total;
        v_total_cost := v_total_cost + v_line_cost;

        insert into sale_items (sale_id, product_id, product_name, batch_id, batch_number, qty, unit_price, cost_price, line_total)
        values (v_sale_id, b.product_id, prod_name, b.id, b.batch_number, v_take, b.mrp_unit_price, b.cost_unit_price, v_line_total);

        v_items := v_items || jsonb_build_object(
          'product_id', b.product_id, 'product_name', prod_name, 'batch_number', b.batch_number,
          'qty', v_take, 'unit_price', b.mrp_unit_price, 'line_total', v_line_total
        );

        remaining_qty := remaining_qty - v_take;
      end loop;

      if remaining_qty > 0 then
        raise exception 'Not enough total stock for % (short by %)', prod_name, remaining_qty;
      end if;
    end if;
  end loop;

  update sales set total = v_total, total_cost = v_total_cost where id = v_sale_id;

  return jsonb_build_object('id', v_sale_id, 'total', v_total, 'items', v_items, 'created_at', now());
end;
$$;
