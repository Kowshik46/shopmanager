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

// ---------- Products ----------

// Autocomplete search for the sales screen: type a name, get matches
app.get('/api/products/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .ilike('name', `%${q}%`)
    .order('name', { ascending: true })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Full inventory list, with a computed low_stock flag
app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const withFlag = data.map(p => ({ ...p, low_stock: p.stock_qty < p.low_stock_threshold }));
  res.json(withFlag);
});

// Add a brand new product
app.post('/api/products', async (req, res) => {
  const { name, category, unit_price, stock_qty, low_stock_threshold } = req.body;
  if (!name || unit_price == null) {
    return res.status(400).json({ error: 'name and unit_price are required' });
  }
  const { data, error } = await supabase
    .from('products')
    .insert({
      name,
      category: category || null,
      unit_price,
      stock_qty: stock_qty || 0,
      low_stock_threshold: low_stock_threshold || 10,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Restock: atomic increment via RPC
app.patch('/api/products/:id/restock', async (req, res) => {
  const { id } = req.params;
  const { add_qty } = req.body;
  if (!add_qty || add_qty <= 0) {
    return res.status(400).json({ error: 'add_qty must be a positive number' });
  }
  const { data, error } = await supabase.rpc('restock_product', { p_id: Number(id), p_qty: add_qty });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Edit a product's core fields (price, threshold, category, name)
app.patch('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, category, unit_price, low_stock_threshold } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (name != null) updates.name = name;
  if (category != null) updates.category = category;
  if (unit_price != null) updates.unit_price = unit_price;
  if (low_stock_threshold != null) updates.low_stock_threshold = low_stock_threshold;

  const { data, error } = await supabase.from('products').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- Sales ----------

// Create a sale: { items: [{ product_id, qty }, ...] } — atomic via Postgres function
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
