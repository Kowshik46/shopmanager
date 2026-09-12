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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

// ---------- Sales: autocomplete + cart ----------
const searchInput = document.getElementById('product-search');
const resultsBox = document.getElementById('search-results');
const cartBody = document.getElementById('cart-body');
const cartTotalEl = document.getElementById('cart-total');
const checkoutBtn = document.getElementById('checkout-btn');
const saleMessage = document.getElementById('sale-message');

let cart = []; // { product_id, name, unit_price, qty, stock_qty, batches: [], batch_id: null }
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
      <span>${escapeHtml(p.name)} — ₹${p.unit_price != null ? Number(p.unit_price).toFixed(2) : '—'}</span>
      <span>${p.low_stock ? `<span class="low">low stock (${p.stock_qty})</span>` : `stock: ${p.stock_qty}`}</span>
    </div>
  `).join('');
  resultsBox.classList.add('open');

  resultsBox.querySelectorAll('.dropdown-item[data-id]').forEach((el, i) => {
    el.addEventListener('click', () => addToCart(products[i]));
  });
}

async function addToCart(product) {
  const existing = cart.find(c => c.product_id === product.id && c.batch_id === null);
  if (existing) {
    existing.qty += 1;
    renderCart();
    searchInput.value = '';
    resultsBox.classList.remove('open');
    searchInput.focus();
    return;
  }

  const batchRes = await fetch(`/api/products/${product.id}/batches`);
  const batches = await batchRes.json();

  cart.push({
    product_id: product.id,
    name: product.name,
    unit_price: Number(product.unit_price || 0),
    qty: 1,
    stock_qty: product.stock_qty,
    batches,
    batch_id: null, // null = auto (oldest first)
  });

  searchInput.value = '';
  resultsBox.classList.remove('open');
  resultsBox.innerHTML = '';
  searchInput.focus();
  renderCart();
}

function renderCart() {
  cartBody.innerHTML = cart.map((item, idx) => {
    const batchOptions = ['<option value="">Auto (oldest first)</option>']
      .concat(item.batches.map(b => `<option value="${b.id}" ${String(item.batch_id) === String(b.id) ? 'selected' : ''}>
          ${escapeHtml(b.batch_number || 'no #')} — ₹${Number(b.unit_price).toFixed(2)} (${b.qty_remaining} left${b.expiry_date ? ', exp ' + b.expiry_date : ''})
        </option>`))
      .join('');

    const priceForRow = currentUnitPrice(item);

    return `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${item.batches.length ? `<select class="batch-select" data-idx="${idx}">${batchOptions}</select>` : '—'}</td>
        <td>₹${priceForRow.toFixed(2)}</td>
        <td><input type="number" class="qty-input" min="1" value="${item.qty}" data-idx="${idx}" /></td>
        <td>₹${(priceForRow * item.qty).toFixed(2)}</td>
        <td><button class="remove-btn" data-idx="${idx}">Remove</button></td>
      </tr>
    `;
  }).join('');

  cartBody.querySelectorAll('.qty-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      const val = Math.max(1, parseInt(e.target.value) || 1);
      cart[idx].qty = val;
      renderCart();
    });
  });
  cartBody.querySelectorAll('.batch-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      cart[idx].batch_id = e.target.value || null;
      renderCart();
    });
  });
  cartBody.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      cart.splice(Number(e.target.dataset.idx), 1);
      renderCart();
    });
  });

  const total = cart.reduce((sum, i) => sum + currentUnitPrice(i) * i.qty, 0);
  cartTotalEl.textContent = total.toFixed(2);
  checkoutBtn.disabled = cart.length === 0;
}

function currentUnitPrice(item) {
  if (item.batch_id) {
    const b = item.batches.find(b => String(b.id) === String(item.batch_id));
    if (b) return Number(b.unit_price);
  }
  return item.unit_price;
}

checkoutBtn.addEventListener('click', async () => {
  checkoutBtn.disabled = true;
  saleMessage.textContent = '';
  saleMessage.className = '';
  try {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map(c => ({
          product_id: c.product_id,
          qty: c.qty,
          batch_id: c.batch_id ? Number(c.batch_id) : null,
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sale failed');

    saleMessage.textContent = `Sale #${data.id} completed — total ₹${Number(data.total).toFixed(2)}`;
    saleMessage.className = 'success';
    cart = [];
    renderCart();
  } catch (err) {
    saleMessage.textContent = err.message;
    saleMessage.className = 'error';
    checkoutBtn.disabled = false;
  }
});

// ---------- Inventory ----------
const inventoryBody = document.getElementById('inventory-body');

async function loadInventory() {
  const res = await fetch('/api/products');
  const products = await res.json();
  inventoryBody.innerHTML = products.map(p => `
    <tr class="${p.low_stock ? 'low-stock-row' : ''}">
      <td>${escapeHtml(p.name)} ${p.low_stock ? '<span class="badge-low">LOW</span>' : ''}</td>
      <td>${escapeHtml(p.category)}</td>
      <td>${escapeHtml(p.manufacturer || '')}</td>
      <td>${p.unit_price != null ? '₹' + Number(p.unit_price).toFixed(2) : '—'}</td>
      <td>${p.stock_qty}</td>
      <td>${p.low_stock_threshold}</td>
      <td><button class="add-batch-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}">+ Add stock</button></td>
    </tr>
  `).join('');

  inventoryBody.querySelectorAll('.add-batch-btn').forEach(btn => {
    btn.addEventListener('click', () => openBatchModal(btn.dataset.id, btn.dataset.name));
  });
}

document.getElementById('add-product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    name: form.name.value,
    category: form.category.value,
    manufacturer: form.manufacturer.value || null,
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
  } else {
    const data = await res.json();
    alert(data.error || 'Failed to add product');
  }
});

// ---------- Batch modal ----------
const batchModal = document.getElementById('batch-modal');
const batchForm = document.getElementById('add-batch-form');
const batchModalTitle = document.getElementById('batch-modal-title');

function openBatchModal(productId, productName) {
  batchForm.reset();
  batchForm.product_id.value = productId;
  batchForm.pack_size.value = 1;
  batchModalTitle.textContent = `Add stock — ${productName}`;
  batchModal.classList.add('open');
}

document.getElementById('batch-cancel-btn').addEventListener('click', () => {
  batchModal.classList.remove('open');
});
batchModal.addEventListener('click', (e) => {
  if (e.target === batchModal) batchModal.classList.remove('open');
});

batchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const productId = form.product_id.value;
  const payload = {
    batch_number: form.batch_number.value || null,
    seller: form.seller.value || null,
    expiry_date: form.expiry_date.value || null,
    pack_size: parseInt(form.pack_size.value) || 1,
    price_amount: parseFloat(form.price_amount.value),
    price_unit: form.price_unit.value,
    qty: parseInt(form.qty.value),
  };
  const res = await fetch(`/api/products/${productId}/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    batchModal.classList.remove('open');
    loadInventory();
  } else {
    const data = await res.json();
    alert(data.error || 'Failed to add stock');
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
        <span>₹${Number(s.total).toFixed(2)}</span>
      </div>
      <ul>
        ${s.items.map(i => `<li>${escapeHtml(i.product_name)}${i.batch_number ? ' (batch ' + escapeHtml(i.batch_number) + ')' : ''} × ${i.qty} = ₹${Number(i.line_total).toFixed(2)}</li>`).join('')}
      </ul>
    </div>
  `).join('');
}
