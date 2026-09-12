// ---------- Tab switching ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'inventory') loadInventory();
    if (btn.dataset.tab === 'history') loadHistory();
  });
});

// ---------- Sales: autocomplete + cart ----------
const searchInput = document.getElementById('product-search');
const resultsBox = document.getElementById('search-results');
const cartBody = document.getElementById('cart-body');
const cartTotalEl = document.getElementById('cart-total');
const checkoutBtn = document.getElementById('checkout-btn');
const saleMessage = document.getElementById('sale-message');

let cart = []; // { product_id, name, unit_price, qty, stock_qty }
let debounceTimer;

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  if (!q) { resultsBox.classList.remove('open'); resultsBox.innerHTML = ''; return; }
  debounceTimer = setTimeout(async () => {
    const res = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`);
    const products = await res.json();
    renderResults(products);
  }, 200);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) resultsBox.classList.remove('open');
});

function renderResults(products) {
  if (!products.length) {
    resultsBox.innerHTML = '<div class="dropdown-item">No matches</div>';
    resultsBox.classList.add('open');
    return;
  }
  resultsBox.innerHTML = products.map(p => `
    <div class="dropdown-item" data-id="${p.id}">
      <span>${escapeHtml(p.name)} — $${Number(p.unit_price).toFixed(2)}</span>
      <span>${p.stock_qty <= p.low_stock_threshold ? `<span class="low">low stock (${p.stock_qty})</span>` : `stock: ${p.stock_qty}`}</span>
    </div>
  `).join('');
  resultsBox.classList.add('open');

  resultsBox.querySelectorAll('.dropdown-item[data-id]').forEach((el, i) => {
    el.addEventListener('click', () => addToCart(products[i]));
  });
}

function addToCart(product) {
  const existing = cart.find(c => c.product_id === product.id);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({
      product_id: product.id,
      name: product.name,
      unit_price: Number(product.unit_price),
      qty: 1,
      stock_qty: product.stock_qty,
    });
  }
  searchInput.value = '';
  resultsBox.classList.remove('open');
  resultsBox.innerHTML = '';
  searchInput.focus();
  renderCart();
}

function renderCart() {
  cartBody.innerHTML = cart.map((item, idx) => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td>$${item.unit_price.toFixed(2)}</td>
      <td><input type="number" class="qty-input" min="1" value="${item.qty}" data-idx="${idx}" /></td>
      <td>$${(item.unit_price * item.qty).toFixed(2)}</td>
      <td><button class="remove-btn" data-idx="${idx}">Remove</button></td>
    </tr>
  `).join('');

  cartBody.querySelectorAll('.qty-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      const val = Math.max(1, parseInt(e.target.value) || 1);
      cart[idx].qty = val;
      renderCart();
    });
  });
  cartBody.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      cart.splice(Number(e.target.dataset.idx), 1);
      renderCart();
    });
  });

  const total = cart.reduce((sum, i) => sum + i.unit_price * i.qty, 0);
  cartTotalEl.textContent = total.toFixed(2);
  checkoutBtn.disabled = cart.length === 0;
}

checkoutBtn.addEventListener('click', async () => {
  checkoutBtn.disabled = true;
  saleMessage.textContent = '';
  saleMessage.className = '';
  try {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart.map(c => ({ product_id: c.product_id, qty: c.qty })) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sale failed');

    saleMessage.textContent = `Sale #${data.id} completed — total $${Number(data.total).toFixed(2)}`;
    saleMessage.className = 'success';
    cart = [];
    renderCart();
  } catch (err) {
    saleMessage.textContent = err.message;
    saleMessage.className = 'error';
    checkoutBtn.disabled = false;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Inventory ----------
const inventoryBody = document.getElementById('inventory-body');

async function loadInventory() {
  const res = await fetch('/api/products');
  const products = await res.json();
  inventoryBody.innerHTML = products.map(p => `
    <tr class="${p.low_stock ? 'low-stock-row' : ''}">
      <td>${escapeHtml(p.name)} ${p.low_stock ? '<span class="badge-low">LOW</span>' : ''}</td>
      <td>${escapeHtml(p.category || '')}</td>
      <td>$${Number(p.unit_price).toFixed(2)}</td>
      <td>${p.stock_qty}</td>
      <td>${p.low_stock_threshold}</td>
      <td>
        <input type="number" min="1" placeholder="qty" class="restock-input" style="width:60px" data-id="${p.id}" />
        <button class="restock-btn" data-id="${p.id}">Add</button>
      </td>
    </tr>
  `).join('');

  inventoryBody.querySelectorAll('.restock-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = inventoryBody.querySelector(`.restock-input[data-id="${id}"]`);
      const addQty = parseInt(input.value);
      if (!addQty || addQty <= 0) return;
      await fetch(`/api/products/${id}/restock`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add_qty: addQty }),
      });
      loadInventory();
    });
  });
}

document.getElementById('add-product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    name: form.name.value,
    category: form.category.value || null,
    unit_price: parseFloat(form.unit_price.value),
    stock_qty: parseInt(form.stock_qty.value) || 0,
    low_stock_threshold: parseInt(form.low_stock_threshold.value) || 10,
  };
  const res = await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    form.reset();
    loadInventory();
  }
});

// ---------- History ----------
const historyList = document.getElementById('history-list');

async function loadHistory() {
  const res = await fetch('/api/sales');
  const sales = await res.json();
  if (!sales.length) {
    historyList.innerHTML = '<p>No sales yet.</p>';
    return;
  }
  historyList.innerHTML = sales.map(s => `
    <div class="history-card">
      <div class="meta">
        <span>Sale #${s.id} — ${new Date(s.created_at).toLocaleString()}</span>
        <span>$${Number(s.total).toFixed(2)}</span>
      </div>
      <ul>
        ${s.items.map(i => `<li>${escapeHtml(i.product_name)} × ${i.qty} = $${Number(i.line_total).toFixed(2)}</li>`).join('')}
      </ul>
    </div>
  `).join('');
}
