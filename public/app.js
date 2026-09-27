// Wraps fetch() for API calls: if the session cookie expired mid-use, bounce to login
// instead of leaving the page silently broken.
async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
  }
  return res;
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await apiFetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---------- Tab switching ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'inventory') loadInventory();
    if (btn.dataset.tab === 'dealers') loadDealersTab();
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
    const res = await apiFetch(`/api/products/search?q=${encodeURIComponent(q)}`);
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

  const batchRes = await apiFetch(`/api/products/${product.id}/batches`);
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
          ${escapeHtml(b.batch_number || 'no #')} — ₹${Number(b.unit_price).toFixed(2)} (${b.qty_remaining} left${b.expiry_date ? ', exp ' + b.expiry_date : ''}${b.dealer_name ? ', ' + escapeHtml(b.dealer_name) : ''})
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
    const res = await apiFetch('/api/sales', {
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
const inventorySearch = document.getElementById('inventory-search');
const inventoryCategoryFilter = document.getElementById('inventory-category-filter');
const inventoryLowStockFilter = document.getElementById('inventory-lowstock-filter');
const inventoryRxFilter = document.getElementById('inventory-rx-filter');

let allProducts = [];
let inventorySort = { key: 'name', dir: 'asc' };

async function loadInventory() {
  const res = await apiFetch('/api/products');
  allProducts = await res.json();
  renderInventory();
}

function renderInventory() {
  const q = inventorySearch.value.trim().toLowerCase();
  const category = inventoryCategoryFilter.value;
  const lowStockOnly = inventoryLowStockFilter.checked;
  const rxOnly = inventoryRxFilter.checked;

  let rows = allProducts.filter(p => {
    if (category && p.category !== category) return false;
    if (lowStockOnly && !p.low_stock) return false;
    if (rxOnly && !p.prescription_required) return false;
    if (q) {
      const haystack = `${p.name} ${p.manufacturer || ''} ${p.rack_location || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const { key, dir } = inventorySort;
  rows = rows.slice().sort((a, b) => {
    let av = a[key], bv = b[key];
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string') { av = av.toLowerCase(); bv = String(bv).toLowerCase(); }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  document.querySelectorAll('#inventory-table th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === key) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  inventoryBody.innerHTML = rows.map(p => `
    <tr class="${p.low_stock ? 'low-stock-row' : ''}">
      <td>${escapeHtml(p.name)} ${p.low_stock ? '<span class="badge-low">LOW</span>' : ''} ${p.prescription_required ? '<span class="badge-rx">Rx</span>' : ''}</td>
      <td>${escapeHtml(p.category)}</td>
      <td>${escapeHtml(p.manufacturer || '')}</td>
      <td>${escapeHtml(p.rack_location || '')}</td>
      <td>${p.unit_price != null ? '₹' + Number(p.unit_price).toFixed(2) : '—'}</td>
      <td>${p.stock_qty}</td>
      <td>${p.low_stock_threshold}</td>
      <td><button class="add-batch-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-category="${escapeHtml(p.category)}">+ Add stock</button></td>
    </tr>
  `).join('');

  inventoryBody.querySelectorAll('.add-batch-btn').forEach(btn => {
    btn.addEventListener('click', () => openBatchModal(btn.dataset.id, btn.dataset.name, btn.dataset.category));
  });
}

inventorySearch.addEventListener('input', renderInventory);
[inventoryCategoryFilter, inventoryLowStockFilter, inventoryRxFilter].forEach(el => el.addEventListener('change', renderInventory));

document.querySelectorAll('#inventory-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (inventorySort.key === key) {
      inventorySort.dir = inventorySort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      inventorySort = { key, dir: 'asc' };
    }
    renderInventory();
  });
});

// A new product is created together with its first batch in one submit —
// there's no point in a product that exists but has zero stock and no price.
const addProductForm = document.getElementById('add-product-form');
const addProductDetails = addProductForm.closest('details');
const productCategorySelect = document.getElementById('product-category-select');
const productDealerSelect = document.getElementById('product-dealer-select');
const productNewDealerFields = document.getElementById('product-new-dealer-fields');
const productPackSizeLabel = document.getElementById('product-pack-size-label');

function updateProductPackSizeLabel() {
  productPackSizeLabel.firstChild.textContent =
    productCategorySelect.value === 'Tablet' ? 'Tablets per strip' : 'Units per pack';
}
productCategorySelect.addEventListener('change', updateProductPackSizeLabel);
updateProductPackSizeLabel();

productDealerSelect.addEventListener('change', () => {
  productNewDealerFields.hidden = productDealerSelect.value !== '__new__';
});

addProductDetails.addEventListener('toggle', () => {
  if (addProductDetails.open) populateDealerSelect(productDealerSelect);
});

addProductForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;

  const dealerId = await resolveDealerId(productDealerSelect, 'product-new-dealer');
  if (!dealerId) return;

  const productPayload = {
    name: form.name.value,
    category: form.category.value,
    manufacturer: form.manufacturer.value || null,
    rack_location: form.rack_location.value || null,
    prescription_required: form.prescription_required.checked,
    low_stock_threshold: parseInt(form.low_stock_threshold.value) || 10,
  };
  const productRes = await apiFetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(productPayload),
  });
  const product = await productRes.json();
  if (!productRes.ok) {
    alert(product.error || 'Failed to add product');
    return;
  }

  const batchPayload = {
    batch_number: form.batch_number.value || null,
    dealer_id: Number(dealerId),
    expiry_date: form.expiry_date.value,
    pack_size: parseInt(form.pack_size.value) || 1,
    mrp_amount: parseFloat(form.mrp_amount.value),
    cost_amount: parseFloat(form.cost_amount.value),
    price_unit: form.price_unit.value,
    qty: parseInt(form.qty.value),
  };
  const batchRes = await apiFetch(`/api/products/${product.id}/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchPayload),
  });
  if (!batchRes.ok) {
    const batchError = await batchRes.json();
    alert(`Product "${product.name}" was added, but stock wasn't: ${batchError.error || 'unknown error'}. Use "+ Add stock" on it to try again.`);
    await loadInventory();
    return;
  }

  form.reset();
  addProductDetails.open = false;
  await loadInventory();
});

// ---------- Dealers ----------
const dealersBody = document.getElementById('dealers-body');
const dealerModal = document.getElementById('dealer-modal');
const dealerEditForm = document.getElementById('edit-dealer-form');

async function loadDealersTab() {
  const res = await apiFetch('/api/dealers');
  const dealers = await res.json();
  dealersBody.innerHTML = dealers.map(d => `
    <tr>
      <td>${escapeHtml(d.name)}</td>
      <td>${escapeHtml(d.phone || '')}</td>
      <td>${escapeHtml(d.gstin || '')}</td>
      <td>${escapeHtml(d.address || '')}</td>
      <td>${escapeHtml(d.notes || '')}</td>
      <td><button class="edit-dealer-btn secondary-btn" data-id="${d.id}">Edit</button></td>
    </tr>
  `).join('');

  dealersBody.querySelectorAll('.edit-dealer-btn').forEach(btn => {
    const dealer = dealers.find(d => String(d.id) === btn.dataset.id);
    btn.addEventListener('click', () => openDealerModal(dealer));
  });
}

document.getElementById('add-dealer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    name: form.name.value,
    phone: form.phone.value || null,
    gstin: form.gstin.value || null,
    address: form.address.value || null,
    notes: form.notes.value || null,
  };
  const res = await apiFetch('/api/dealers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    form.reset();
    loadDealersTab();
  } else {
    const data = await res.json();
    alert(data.error || 'Failed to add dealer');
  }
});

function openDealerModal(dealer) {
  dealerEditForm.dealer_id.value = dealer.id;
  dealerEditForm.name.value = dealer.name || '';
  dealerEditForm.phone.value = dealer.phone || '';
  dealerEditForm.gstin.value = dealer.gstin || '';
  dealerEditForm.address.value = dealer.address || '';
  dealerEditForm.notes.value = dealer.notes || '';
  dealerModal.classList.add('open');
}

document.getElementById('dealer-cancel-btn').addEventListener('click', () => {
  dealerModal.classList.remove('open');
});
dealerModal.addEventListener('click', (e) => {
  if (e.target === dealerModal) dealerModal.classList.remove('open');
});

dealerEditForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    name: form.name.value,
    phone: form.phone.value || null,
    gstin: form.gstin.value || null,
    address: form.address.value || null,
    notes: form.notes.value || null,
  };
  const res = await apiFetch(`/api/dealers/${form.dealer_id.value}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    dealerModal.classList.remove('open');
    loadDealersTab();
  } else {
    const data = await res.json();
    alert(data.error || 'Failed to update dealer');
  }
});

// ---------- Batch modal ----------
const batchModal = document.getElementById('batch-modal');
const batchForm = document.getElementById('add-batch-form');
const batchModalTitle = document.getElementById('batch-modal-title');
const dealerSelect = document.getElementById('dealer-select');
const newDealerFields = document.getElementById('new-dealer-fields');
const packSizeLabel = document.getElementById('pack-size-label');

async function populateDealerSelect(selectEl, selected) {
  const res = await apiFetch('/api/dealers');
  const dealers = await res.json();
  selectEl.innerHTML = '<option value="">Select dealer...</option>'
    + dealers.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')
    + '<option value="__new__">+ Add new dealer</option>';
  if (selected) selectEl.value = selected;
}

async function loadDealers(selected) {
  await populateDealerSelect(dealerSelect, selected);
}

// Resolves a dealer <select>'s value to a real dealer id, creating a new
// dealer first if "+ Add new dealer" was picked. `prefix` scopes the inline
// new-dealer input ids (e.g. 'new-dealer' or 'product-new-dealer').
async function resolveDealerId(selectEl, prefix) {
  let dealerId = selectEl.value;
  if (!dealerId) {
    alert('Dealer is required');
    return null;
  }
  if (dealerId !== '__new__') return dealerId;

  const name = document.getElementById(`${prefix}-name`).value.trim();
  if (!name) {
    alert('Dealer name is required');
    return null;
  }
  const res = await apiFetch('/api/dealers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      phone: document.getElementById(`${prefix}-phone`).value || null,
      gstin: document.getElementById(`${prefix}-gstin`).value || null,
      address: document.getElementById(`${prefix}-address`).value || null,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to add dealer');
    return null;
  }
  return data.id;
}

dealerSelect.addEventListener('change', () => {
  newDealerFields.hidden = dealerSelect.value !== '__new__';
});

function openBatchModal(productId, productName, category) {
  batchForm.reset();
  batchForm.product_id.value = productId;
  batchForm.pack_size.value = 1;
  packSizeLabel.firstChild.textContent = category === 'Tablet' ? 'Tablets per strip' : 'Units per pack';
  newDealerFields.hidden = true;
  batchModalTitle.textContent = `Add stock — ${productName}`;
  batchModal.classList.add('open');
  loadDealers();
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

  const dealerId = await resolveDealerId(dealerSelect, 'new-dealer');
  if (!dealerId) return;

  const payload = {
    batch_number: form.batch_number.value || null,
    dealer_id: Number(dealerId),
    expiry_date: form.expiry_date.value,
    pack_size: parseInt(form.pack_size.value) || 1,
    mrp_amount: parseFloat(form.mrp_amount.value),
    cost_amount: parseFloat(form.cost_amount.value),
    price_unit: form.price_unit.value,
    qty: parseInt(form.qty.value),
  };
  const res = await apiFetch(`/api/products/${productId}/batches`, {
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
  const res = await apiFetch('/api/sales');
  const sales = await res.json();
  if (!sales.length) {
    historyList.innerHTML = '<p>No sales yet.</p>';
    return;
  }
  historyList.innerHTML = sales.map(s => {
    const profit = Number(s.total) - Number(s.total_cost || 0);
    return `
    <div class="history-card">
      <div class="meta">
        <span>Sale #${s.id} — ${new Date(s.created_at).toLocaleString()}</span>
        <span>₹${Number(s.total).toFixed(2)} <span class="profit">(profit ₹${profit.toFixed(2)})</span></span>
      </div>
      <ul>
        ${s.items.map(i => `<li>${escapeHtml(i.product_name)}${i.batch_number ? ' (batch ' + escapeHtml(i.batch_number) + ')' : ''} × ${i.qty} = ₹${Number(i.line_total).toFixed(2)}</li>`).join('')}
      </ul>
    </div>
  `;
  }).join('');
}
