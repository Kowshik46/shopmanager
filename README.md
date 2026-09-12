# Pharmacy Billing & Stock Manager

Simple billing and inventory app for a pharmacy. Node/Express backend using the
Supabase JS client (server-side, with the secret key — bypasses RLS), plain
HTML/JS frontend.

## Setup

1. **Database**: open your Supabase project's SQL editor and run `schema.sql`.
   This creates `products`, `sales`, `sale_items`, enables RLS, adds the
   `restock_product` / `checkout_sale` functions, and seeds a few sample products.
2. **Local run**:
   ```bash
   npm install
   cp .env.example .env   # fill in SUPABASE_URL and SUPABASE_SECRET_KEY
   npm start
   ```
   Visit http://localhost:3000

## Deploy to Render

1. Push this repo to GitHub (done).
2. On Render: New → Web Service → connect this repo.
3. Build command: `npm install`, Start command: `npm start`.
4. Add environment variables:
   - `SUPABASE_URL` — from Project Settings → API
   - `SUPABASE_SECRET_KEY` — the secret key (starts `sb_secret_...`). Keep this
     out of the frontend/browser — it bypasses RLS.
5. Deploy. Render gives you a public URL.

## Features

- **Inventory**: view stock, low-stock flag (qty below threshold, shown in red),
  add new products, restock existing ones.
- **Sales**: type a product name, pick from live matches, adjust quantity inline,
  add more items, checkout. Stock is decremented atomically via a Postgres
  function (`checkout_sale`), so concurrent sales can't oversell.
- **History**: list of past sales with line items.

## Notes

- RLS is enabled on all tables; the backend uses the secret key so it isn't
  affected. Don't ever expose the secret key to the browser.
- No login/auth included — add if the pharmacy has multiple staff and you want
  per-user tracking.
- No build step on the frontend (plain JS) to keep the Render deploy trivial.
