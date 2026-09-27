# Pharmacy Billing & Stock Manager

Billing and batch-level inventory app for a pharmacy. Python/Flask backend
using the Supabase Python client (server-side, secret key — bypasses RLS),
plain HTML/JS frontend. Currency: ₹ (rupees), stored as rupees with paise
precision (2 decimals).

## Setup

1. **Database**: open your Supabase project's SQL editor and run `schema.sql`.
   Creates `dealers`, `products`, `batches`, `sales`, `sale_items`, the
   `product_summary` view, RLS, the `checkout_sale` function, and sample data.
   If you're upgrading from an earlier version of this schema (no `dealers`
   table, no cost tracking), the comment at the top of `schema.sql` has the
   `drop table`/`drop function` statements to run first — this is a breaking
   change to `batches` and `sale_items`.
2. **Local run**:
   ```bash
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SECRET_KEY, APP_PASSWORD, SESSION_SECRET
   python app.py
   ```
   Visit http://localhost:3000 — you'll be asked for `APP_PASSWORD` before you can use it.

## Deploy to Render

1. Push this repo to GitHub (done).
2. On Render: New → Web Service → connect this repo.
3. Build command: `pip install -r requirements.txt`, Start command:
   `gunicorn app:app --bind 0.0.0.0:$PORT`.
4. Add environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY` (starts `sb_secret_...`) — keep out of the frontend/browser.
   - `APP_PASSWORD` — the shared password staff use to log in.
   - `SESSION_SECRET` — random string that signs the login cookie (generate with
     `python3 -c "import secrets; print(secrets.token_hex(32))"`).
5. Deploy.

## Data model

- **Dealers**: name (unique), phone, GSTIN — added once, then picked from a
  dropdown when stocking (or created inline from the "Add stock" modal).
- **Products**: identity only — name, category (Tablet / Syrup / Ointment /
  Other), manufacturer, `prescription_required` flag (Schedule H/H1/X),
  `rack_location` (free-text shelf code, e.g. `A1`), low-stock threshold. No
  price or stock stored here.
- **Batches**: one row per restock — batch number, dealer, pack size (e.g.
  tablets per strip), **both** an MRP and a dealer cost price (rupees or
  paise, each converted to a per-unit price on save), quantity received,
  quantity remaining, required expiry date.
- Stock and "current price" shown anywhere are derived live from batches via
  the `product_summary` view — current price = the MRP of the batch that will
  actually be used on the next sale.
- **Sales / sale items**: each sale stores both `total` (MRP charged) and
  `total_cost` (dealer cost of what was sold) so profit is `total -
  total_cost` — computed on the fly in the History tab, not stored separately.

## How selling deducts stock

- If you don't pick a batch on a cart line, `checkout_sale` auto-deducts from
  the oldest active batch first (by expiry date if set, otherwise by date
  received), splitting across batches if one doesn't have enough.
- You can also pin a cart line to a specific batch via the dropdown (shows
  remaining qty + expiry), e.g. to intentionally sell older stock ahead of a
  newer, cheaper batch.
- The whole sale (stock check, decrement, sale + line items) runs in one
  Postgres function, so it's atomic — concurrent sales can't oversell.

## Features

- **Inventory**: product list with category/manufacturer/rack/derived
  price/stock, low-stock and Rx (prescription-required) badges, add new
  products, "+ Add stock" per product to log a new batch (batch #, dealer,
  expiry, MRP + cost, pack size, quantity).
- **Sales**: type a product name, pick from live matches, adjust quantity
  inline, optionally pin a batch (shows dealer + expiry), add more items,
  checkout.
- **History**: list of past sales with line items (including which batch was
  used) and per-sale profit.

## Notes

- RLS is enabled on all tables; the backend uses the secret key so it isn't
  affected. Never expose the secret key to the browser.
- Auth is a single shared password (`APP_PASSWORD`), not per-user accounts —
  fine for one shop's staff sharing a till, but there's no per-user tracking
  of who made a sale. The login cookie is signed with `SESSION_SECRET` and
  lasts 30 days; log out from the header to clear it on a shared machine.
- No frontend build step, to keep the Render deploy trivial.
