require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY // service/secret key — bypasses RLS, server-side only
);

const CATEGORIES = ['Tablet', 'Syrup', 'Ointment', 'Other'];

// ---------- Products ----------

// Autocomplete search for the sales screen
app.get('/api/products/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const { data, error } = await supabase
    .from('product_summary')
    .select('*')
    .ilike('name', `%${q}%`)
    .order('name', { ascending: true })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(p => ({ ...p, low_stock: p.stock_qty < p.low_stock_threshold })));
});

// Full inventory list (derived stock + current price from batches)
app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase.from('product_summary').select('*').order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(p => ({ ...p, low_stock: p.stock_qty < p.low_stock_threshold })));
});

// Add a brand new product (no stock yet — add a batch next to stock it)
app.post('/api/products', async (req, res) => {
  const { name, category, manufacturer, low_stock_threshold } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${CATEGORIES.join(', ')}` });
  }
  const { data, error } = await supabase
    .from('products')
    .insert({
      name,
      category: category || 'Other',
      manufacturer: manufacturer || null,
      low_stock_threshold: low_stock_threshold || 10,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Edit a product's core fields
app.patch('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, category, manufacturer, low_stock_threshold } = req.body;
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${CATEGORIES.join(', ')}` });
  }
  const updates = { updated_at: new Date().toISOString() };
  if (name != null) updates.name = name;
  if (category != null) updates.category = category;
  if (manufacturer != null) updates.manufacturer = manufacturer;
  if (low_stock_threshold != null) updates.low_stock_threshold = low_stock_threshold;

  const { data, error } = await supabase.from('products').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- Batches (stock-in) ----------

// List active batches for a product (used by the sales screen's batch picker)
app.get('/api/products/:id/batches', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('batches')
    .select('*')
    .eq('product_id', id)
    .gt('qty_remaining', 0)
    .order('expiry_date', { ascending: true, nullsFirst: false })
    .order('received_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Add a new batch (i.e. restock). Price entered as a pack price in ₹ or paise;
// unit_price is computed and stored so every downstream calc stays in rupees.
app.post('/api/products/:id/batches', async (req, res) => {
  const { id } = req.params;
  const { batch_number, seller, pack_size, price_amount, price_unit, qty, expiry_date } = req.body;

  const size = Number(pack_size) || 1;
  const amount = Number(price_amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'price_amount must be a positive number' });
  if (!qty || qty <= 0) return res.status(400).json({ error: 'qty must be a positive number' });

  const packPriceRupees = price_unit === 'paise' ? amount / 100 : amount;
  const unitPrice = Math.round((packPriceRupees / size) * 100) / 100;

  const { data, error } = await supabase
    .from('batches')
    .insert({
      product_id: Number(id),
      batch_number: batch_number || null,
      seller: seller || null,
      pack_size: size,
      pack_price: packPriceRupees,
      unit_price: unitPrice,
      qty_received: qty,
      qty_remaining: qty,
      expiry_date: expiry_date || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ---------- Sales ----------

// Create a sale: { items: [{ product_id, qty, batch_id? }, ...] } — atomic via Postgres function
app.post('/api/sales', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }
  const { data, error } = await supabase.rpc('checkout_sale', { p_items: items });
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// Sales history (most recent first)
app.get('/api/sales', async (req, res) => {
  const { data: sales, error } = await supabase
    .from('sales')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  if (!sales.length) return res.json([]);

  const ids = sales.map(s => s.id);
  const { data: items, error: itemsErr } = await supabase.from('sale_items').select('*').in('sale_id', ids);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  const grouped = sales.map(s => ({ ...s, items: items.filter(i => i.sale_id === s.id) }));
  res.json(grouped);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pharmacy app listening on port ${PORT}`));
