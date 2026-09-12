# Pharmacy Billing & Stock Manager

Billing and batch-level inventory app for a pharmacy. Node/Express backend
using the Supabase JS client (server-side, secret key — bypasses RLS), plain
HTML/JS frontend. Currency: ₹ (rupees), stored as rupees with paise precision
(2 decimals).

## Setup

1. **Database**: open your Supabase project's SQL editor and run `schema.sql`.
   Creates `products`, `batches`, `sales`, `sale_items`, the `product_summary`
   view, RLS, the `checkout_sale` function, and sample data.
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
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY` (starts `sb_secret_...`) — keep out of the frontend/browser.
5. Deploy.

## Data model

- **Products**: identity only — name, category (Tablet / Syrup / Ointment /
  Other), manufacturer, low-stock threshold. No price or stock stored here.
- **Batches**: one row per restock — batch number, seller/supplier, pack size,
  pack price (rupees or paise, converted to a per-unit price on save), quantity
  received, quantity remaining, optional expiry date.
- Stock and "current price" shown anywhere are derived live from batches via
  the `product_summary` view — current price = the batch that will actually be
  used on the next sale.

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

- **Inventory**: product list with category/manufacturer/derived price/stock,
  low-stock flag, add new products, "+ Add stock" per product to log a new
  batch (batch #, seller, expiry, pack price/size, quantity).
- **Sales**: type a product name, pick from live matches, adjust quantity
  inline, optionally pin a batch, add more items, checkout.
- **History**: list of past sales with line items (including which batch was
  used).

## Notes

- RLS is enabled on all tables; the backend uses the secret key so it isn't
  affected. Never expose the secret key to the browser.
- No login/auth — add if the pharmacy has multiple staff and you want
  per-user tracking.
- No frontend build step, to keep the Render deploy trivial.
