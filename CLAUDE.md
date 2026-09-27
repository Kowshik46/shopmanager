# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Billing and batch-level inventory app for a single pharmacy. Python/Flask
backend talking to Supabase (Postgres) via the service/secret key — server-side
only, bypasses RLS. Plain HTML/CSS/JS frontend, no build step, no frontend
framework. Currency is ₹ (rupees), stored with paise precision (2 decimals).

## Commands

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SECRET_KEY, APP_PASSWORD, SESSION_SECRET
python app.py          # dev server on :3000 (or $PORT)
```

There is no lint config, no test suite, and no build step in this repo —
`app.py` is run directly. Production runs via `gunicorn app:app --bind
0.0.0.0:$PORT` (see `render.yaml`).

Database schema/migrations are not managed by a migration tool: `schema.sql`
is a single idempotent script (`create table if not exists`, `create or
replace function/view`) run by hand in the Supabase SQL editor. If a table's
*shape* needs to change, the old table has to be dropped manually first — the
comment at the top of `schema.sql` explains this. When editing `schema.sql`,
keep it idempotent and update the comment if the re-run caveat changes.

## Architecture

**Everything server-side lives in `app.py`** (single file, no blueprints/routers
— there are ~10 routes total, splitting it up would be premature). It does
three things in order: auth gate, static file serving, JSON API routes backed
by Supabase.

**Auth is a single shared password, not per-user accounts** (`APP_PASSWORD` env
var, checked with `hmac.compare_digest`). A Flask session cookie (signed with
`SESSION_SECRET`, 30-day lifetime) is the only session state; there is no user
table, no roles, no per-user attribution on sales. `before_request` gates
*every* request — static files and `/api/*` alike — except `/login.html` and
`/api/login`. API paths get a 401 JSON body when unauthenticated; everything
else gets redirected to `/login.html`. When adding a new route, it is
automatically covered by this gate — nothing needs to opt in.

**Stock is never stored on `products`.** The `products` table is identity only
(name, category, manufacturer, `prescription_required`, `rack_location`,
low-stock threshold). Every restock creates a new row in `batches` (dealer,
pack size/MRP/cost, quantity received/remaining, required expiry). Current
stock and "the price that will actually be charged next" are both *derived*,
live, from `batches` via the `product_summary` SQL view — see `schema.sql`.
Never add a `stock_qty` or `price` column to `products`; it would duplicate
what the view already computes and the two would drift.

**Every batch carries two prices, MRP and dealer cost — never conflate them.**
`batches.mrp_pack_price`/`mrp_unit_price` is what the customer is charged
(what `product_summary.unit_price` surfaces); `cost_pack_price`/`cost_unit_price`
is what the shop paid the dealer, entered separately in the same "Add stock"
form. `checkout_sale` snapshots *both* onto `sale_items` (as `unit_price` and
`cost_price`) and rolls them up onto `sales.total`/`sales.total_cost`, so
per-sale profit (`total - total_cost`) is always computable later even if a
dealer's price changes on a subsequent batch. `dealers` is a real table (name
unique, optional phone/GSTIN) picked via `dealer_id` on each batch — not a
free-text column — so purchase history can be traced per dealer.

**Selling stock is FEFO/FIFO and lives entirely in Postgres, not in Flask.**
`POST /api/sales` just forwards `{items: [...]}` to the `checkout_sale`
Postgres function via `supabase.rpc(...)`. That function does the batch
selection (earliest expiry first, then earliest received), locks rows with
`for update`, decrements `qty_remaining`, and writes `sales`/`sale_items` —
all inside one Postgres transaction, so concurrent sales can't oversell a
batch. If a cart line has no `batch_id`, the function auto-splits across
batches to fill the requested quantity; if `batch_id` is given, it charges
that specific batch instead. Any change to sale logic (new discount type, a
return/refund flow, etc.) belongs in `checkout_sale` in `schema.sql`, not in
`app.py` — the atomicity guarantee only holds inside the Postgres function.

**RLS is enabled on every table but does nothing for this app** — the backend
authenticates to Supabase with the secret/service key, which bypasses RLS
entirely. Don't rely on RLS policies as a security boundary here; the
`before_request` password gate in `app.py` is the only thing standing between
the internet and these tables.

**Frontend is one global-state blob, not per-component state.** `public/app.js`
keeps the in-progress sale in a single module-level `cart` array and
re-renders whole sections (`renderCart()`, `loadInventory()`, `loadHistory()`)
from scratch on any change rather than patching the DOM incrementally. All
`fetch` calls to `/api/*` go through the `apiFetch()` wrapper (top of
`app.js`), which redirects to `/login.html` on a 401 — new API calls from the
frontend should use `apiFetch`, not raw `fetch`, so an expired session bounces
to login instead of failing silently.

**Money handling**: both MRP and cost are entered as *pack* prices (in rupees
or paise, one shared toggle for both) and converted once, on insert, into
*unit* prices stored on the `batches` row (`round_rupees()` in `app.py`,
mirroring SQL `numeric(10,2)`). Every downstream calculation (cart totals,
sale line items) reads those already-computed unit prices — never re-derive
price-per-unit from pack price elsewhere.

## Deploy

Render (`render.yaml`), free-tier web service. Build: `pip install -r
requirements.txt`. Start: `gunicorn app:app --bind 0.0.0.0:$PORT`. Required
env vars (set manually in the Render dashboard, not committed):
`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `APP_PASSWORD`, `SESSION_SECRET`. `ENV=production`
is set in `render.yaml` and controls the `Secure` flag on the session cookie.
