// app.js — Wizard controller, order state, DOM rendering

// ============ ORDER STATE ============
const orderState = {
  orderType: null,        // 'delivery' | 'carryout'
  address: null,
  store: null,
  timing: 'now',
  currentCategory: null,
  selectedProduct: null,     // the product being customized
  editingCartIndex: null,
  currentCustomization: {    // customization state (for customizable products)
    size: 'medium',
    crust: 'classic',
    toppings: [],
    quantity: 1
  },
  cart: [],
  contact: {
    firstName: '',
    lastName: '',
    phone: '',
    email: ''
  },
  delivery: {
    leaveAtDoor: false,
    instructions: ''
  },
  confirmation: null
};



let currentStep = 1;

// ============ AGENT MODAL ============
let agentModalTimer;

function showAgentModal(agentName) {
  const overlay = document.getElementById('agentModal');
  const text = document.getElementById('agentModalText');
  text.textContent = `${agentName} is creating your order`;
  overlay.style.display = 'flex';
  clearTimeout(agentModalTimer);
  agentModalTimer = setTimeout(hideAgentModal, 1500);
}

function hideAgentModal() {
  clearTimeout(agentModalTimer);
  document.getElementById('agentModal').style.display = 'none';
}

// ============ STEP NAVIGATION ============
function goToStep(step, skipHistoryUpdate = false) {
  // Hide all steps
  document.querySelectorAll('.step').forEach(s => s.style.display = 'none');
  // Show target step
  document.getElementById(`step-${step}`).style.display = 'block';
  currentStep = step;

  // Render step content
  switch (step) {
    case 1: renderHomeCategoryGrid(); break;
    case 2: renderLocation(); break;
    case 3: renderCategories(); break;
    case 4: renderProductList(); break;
    case 5: renderCustomize(); break;
    case 6: renderCart(); break;
    case 7: renderCheckout(); break;
    case 8: renderConfirmation(); break;
  }

  // Update nav delivery info
  updateNavDeliveryInfo();

  // Update cart badge
  updateCartBadge();

  // Register WebMCP tools for this step
  if (typeof registerToolsForStep === 'function') {
    registerToolsForStep(step);
  }

  // Update URL
  if (!skipHistoryUpdate) {
    updateURL();
  }

  // Scroll to top
  window.scrollTo(0, 0);
}

// ============ STEP 1: ORDER TYPE ============
function selectOrderType(type) {
  orderState.orderType = type;
  goToStep(2);

  // Update location question based on type
  const q = document.getElementById('locationQuestion');
  if (type === 'delivery') {
    q.textContent = 'Where should we deliver to?';
    document.getElementById('addressInput').placeholder = 'Enter delivery address';
  } else {
    q.textContent = 'Find a store near you';
    document.getElementById('addressInput').placeholder = 'Enter city, state, or zip';
  }

  return `Order type set to ${type}. Please provide a ${type === 'delivery' ? 'delivery address' : 'location to find nearby stores'}.`;
}

// ============ STEP 2: LOCATION ============
function renderLocation() {
  // Update location question based on order type
  const q = document.getElementById('locationQuestion');
  if (orderState.orderType === 'delivery') {
    q.textContent = 'Where should we deliver to?';
    document.getElementById('addressInput').placeholder = 'Enter delivery address';
  } else if (orderState.orderType === 'carryout') {
    q.textContent = 'Find a store near you';
    document.getElementById('addressInput').placeholder = 'Enter city, state, or zip';
  }

  // If address already set, show store result
  if (orderState.address && orderState.store) {
    document.getElementById('addressEntry').style.display = 'none';
    const result = document.getElementById('storeResult');
    result.style.display = 'block';
    document.getElementById('storeAddressDisplay').textContent = orderState.address.toUpperCase();
    document.getElementById('storeCityDisplay').textContent = `${orderState.store.city}, ${orderState.store.state} ${orderState.store.zip}`;
    document.getElementById('storeEstimateDisplay').textContent = orderState.orderType === 'delivery'
      ? `Delivery in ${orderState.store.deliveryEstimate}`
      : 'Available for carryout';
    document.getElementById('storePhoneDisplay').textContent = orderState.store.phone;
  } else {
    document.getElementById('addressEntry').style.display = 'block';
    document.getElementById('storeResult').style.display = 'none';
  }
}

function findStore() {
  const address = document.getElementById('addressInput').value.trim();
  return setDeliveryAddress(address);
}

function setDeliveryAddress(address) {
  if (!address) {
    showError('addressError', 'Please enter a delivery address');
    return 'Error: Please enter a delivery address.';
  }
  hideError('addressError');

  orderState.address = address;
  orderState.store = STORE;

  // Show store result
  document.getElementById('addressEntry').style.display = 'none';
  const result = document.getElementById('storeResult');
  result.style.display = 'block';
  document.getElementById('storeAddressDisplay').textContent = address.toUpperCase();
  document.getElementById('storeCityDisplay').textContent = `${STORE.city}, ${STORE.state} ${STORE.zip}`;
  document.getElementById('storeEstimateDisplay').textContent = orderState.orderType === 'delivery'
    ? `Delivery in ${STORE.deliveryEstimate}`
    : 'Available for carryout';
  document.getElementById('storePhoneDisplay').textContent = STORE.phone;

  return `Found nearest store: ${STORE.name} at ${STORE.address}, ${STORE.city}, ${STORE.state} ${STORE.zip}. Delivery estimate: ${STORE.deliveryEstimate}. Phone: ${STORE.phone}. Please confirm location to proceed.`;
}

function setTiming(timing) {
  orderState.timing = timing;
  document.getElementById('timingNow').classList.toggle('active', timing === 'now');
  document.getElementById('timingLater').classList.toggle('active', timing === 'later');
}

function confirmLocation(timing) {
  if (!orderState.address) {
    return 'Error: Please enter a delivery address before confirming location.';
  }
  if (timing) setTiming(timing);

  if (orderState.currentCategory) {
    return selectCategory(orderState.currentCategory);
  }

  goToStep(3);

  const categories = CATEGORIES.map(c => c.name).join(', ');
  const destination = orderState.orderType === 'delivery'
    ? `delivered to ${orderState.address}`
    : `picked up from ${orderState.store.name}`;
  return `Location confirmed. Order will be ${destination}. Showing menu categories: ${categories}. Select a category to browse items.`;
}

// ============ STEP 3: MENU CATEGORIES ============
const CATEGORY_EMOJIS = {
  'build-your-own': '🍕', 'specialty': '🍕', 'breads': '🥖',
  'potato-sides': '🥔', 'chicken': '🍗', 'desserts': '🍫',
  'pastas': '🍝', 'sandwiches': '🥪', 'salads': '🥗',
  'drinks': '🥤', 'extras': '🧂'
};

function renderHomeCategoryGrid() {
  const grid = document.getElementById('homeCategoryGrid');
  if (!grid) return;
  grid.innerHTML = CATEGORIES.map(cat => `
    <button type="button" class="home-cat-card" onclick="startCategoryOrder('${cat.id}')">
      ${cat.badge ? `<span class="home-cat-badge">${cat.badge}</span>` : ''}
      <div class="home-cat-img-placeholder">${CATEGORY_EMOJIS[cat.id] || '🍽️'}</div>
      <div class="home-cat-label">${cat.name}</div>
    </button>
  `).join('');
}

function startCategoryOrder(categoryId) {
  orderState.currentCategory = categoryId;
  return selectOrderType('delivery');
}

function renderCategories() {
  const grid = document.getElementById('categoryGrid');
  grid.innerHTML = CATEGORIES.map(cat => `
    <button type="button" class="category-card" onclick="selectCategoryUI('${cat.id}')">
      ${cat.badge ? `<span class="category-card-badge">${cat.badge}</span>` : ''}
      <div class="category-card-img-placeholder">${CATEGORY_EMOJIS[cat.id] || '🍽️'}</div>
      <div class="category-card-label">${cat.name}</div>
    </button>
  `).join('');
}

function selectCategoryUI(categoryId) {
  return selectCategory(categoryId);
}

function selectCategory(categoryId) {
  orderState.currentCategory = categoryId;
  goToStep(4);

  const cat = CATEGORIES.find(c => c.id === categoryId);
  const items = getProductsByCategory(categoryId);
  const categoryName = cat ? cat.name : categoryId;

  document.getElementById('categoryTitle').textContent = categoryName.toUpperCase();

  return `Showing ${categoryName}. ${items.length} items available: ${items.map(p => p.name).join(', ')}. ${items.some(p => p.customizable) ? 'Select a product to customize.' : 'Select a product to add to your order.'}`;
}

// ============ STEP 4: PRODUCT SELECTION ============
function renderProductList() {
  const grid = document.getElementById('productGrid');
  const items = getProductsByCategory(orderState.currentCategory);
  const defaultSize = SIZES.find(size => size.id === 'medium');
  const defaultCrust = CRUSTS.find(crust => crust.id === 'classic');
  grid.innerHTML = items.map(product => `
    <div class="pizza-card">
      <div class="pizza-card-img-wrap">
        ${product.tag ? `<span class="pizza-card-badge ${product.tag === 'TRENDING' ? 'trending' : ''}">${product.tag}</span>` : ''}
        <div class="pizza-card-img-placeholder">${product.emoji || '🍽️'}</div>
      </div>
      <div class="pizza-card-info">
        <div class="pizza-card-name">${product.name}</div>
        <div class="pizza-card-desc">${product.description}</div>
        <div class="pizza-card-price">${product.customizable ? 'From ' : ''}$${product.basePrice.toFixed(2)}</div>
        ${product.customizable ? `<div class="pizza-card-default">${defaultSize.name} · ${defaultCrust.name} crust</div>` : ''}
        <div class="product-card-actions">
          ${product.customizable ? `
            <button class="product-card-action product-card-action-secondary" onclick="selectProductUI('${product.id}')">CUSTOMIZE</button>
            <button class="product-card-action product-card-action-primary" onclick="quickAddProduct('${product.id}')">ADD</button>
          ` : `
            <button class="product-card-action product-card-action-primary" onclick="selectProductUI('${product.id}')">ADD</button>
          `}
        </div>
      </div>
    </div>
  `).join('');
}

function selectProductUI(productId) {
  return selectProduct(productId);
}

function selectProduct(productId) {
  const product = getProductById(productId);
  if (!product) {
    return `Error: Product "${productId}" not found.`;
  }

  // Non-customizable products go straight to cart
  if (!product.customizable) {
    return addSimpleProduct(product);
  }

  // Customizable products (pizzas) go to the customize step
  orderState.selectedProduct = product;
  orderState.editingCartIndex = null;
  orderState.currentCustomization = {
    size: 'medium',
    crust: 'classic',
    toppings: [...(product.defaultToppings || [])],
    quantity: 1
  };

  goToStep(5);

  const sizesAvail = SIZES.map(s => s.id).join(', ');
  const crustsAvail = CRUSTS.map(c => c.id).join(', ');
  const toppingsAvail = TOPPINGS.map(t => t.id).join(', ');

  return `Selected ${product.name} ($${product.basePrice.toFixed(2)} base). Default toppings: ${(product.defaultToppings || []).join(', ') || 'none'}. Ready to customize. Available sizes: ${sizesAvail}. Available crusts: ${crustsAvail}. Available toppings: ${toppingsAvail}. Use customize-pizza to set options, then add-to-cart.`;
}

// Add a non-customizable product directly to cart
function addSimpleProduct(product, quantity = 1) {
  // Check if already in cart — increment quantity
  const existing = orderState.cart.find(item => item.product.id === product.id && !item.size);
  if (existing) {
    existing.quantity += quantity;
    existing.price = existing.unitPrice * existing.quantity;
  } else {
    orderState.cart.push({
      cartId: generateCartId(),
      product: product,
      quantity: quantity,
      unitPrice: product.basePrice,
      price: product.basePrice * quantity,
      name: product.name,
      calories: product.calories || ''
    });
  }

  if (currentStep === 6) {
    renderCart();
  }
  handleCartChanged();
  showCartToast(product.name);

  const subtotal = getCartSubtotal();
  return `Added ${product.name} ($${product.basePrice.toFixed(2)}) to cart. Subtotal: $${subtotal.toFixed(2)} (${orderState.cart.length} items). You can continue shopping or proceed-to-checkout.`;
}

// Quick add with defaults
function quickAddProduct(productId) {
  const product = getProductById(productId);
  if (!product) return;
  if (product.customizable) {
    selectProduct(productId);
    addToCart();
  } else {
    addSimpleProduct(product);
  }
}

function addSideUI(productId) {
  const product = getProductById(productId);
  if (!product) return;
  addSimpleProduct(product);
}

// ============ STEP 5: CUSTOMIZE PRODUCT ============
function renderCustomize() {
  const product = orderState.selectedProduct;
  if (!product) return;
  const cp = orderState.currentCustomization;
  const isEditing = orderState.editingCartIndex !== null;

  document.getElementById('customizePizzaName').textContent = product.name.toUpperCase();
  document.getElementById('customizePizzaDesc').textContent = product.description;
  document.getElementById('customizeThumbName').textContent = product.name.toUpperCase();
  document.getElementById('customizeBackBtn').textContent = isEditing ? '‹ Back to cart' : '‹ Back to products';
  document.querySelectorAll('.customize-add-btn').forEach(button => {
    button.textContent = isEditing ? 'SAVE CHANGES' : 'ADD TO CART';
  });

  // Quantity
  document.getElementById('qtyValue').textContent = cp.quantity;

  // Crusts
  document.getElementById('crustOptions').innerHTML = CRUSTS.map(crust => `
    <div class="crust-card ${cp.crust === crust.id ? 'selected' : ''}" onclick="setCrust('${crust.id}')">
      <input type="radio" name="crust" class="crust-radio" ${cp.crust === crust.id ? 'checked' : ''} />
      <span class="crust-card-label">${crust.name}${crust.priceModifier > 0 ? ` (+$${crust.priceModifier.toFixed(2)})` : ''}</span>
    </div>
  `).join('');

  // Sizes
  document.getElementById('sizeOptions').innerHTML = SIZES.map(size => `
    <button class="size-btn ${cp.size === size.id ? 'selected' : ''}" onclick="setSize('${size.id}')">${size.name}</button>
  `).join('');

  // Toppings
  document.getElementById('toppingGrid').innerHTML = TOPPINGS.map(topping => `
    <button class="topping-chip ${cp.toppings.includes(topping.id) ? 'selected' : ''}" onclick="toggleTopping('${topping.id}')">${topping.name}</button>
  `).join('');
}

function setCrust(crustId) {
  orderState.currentCustomization.crust = crustId;
  renderCustomize();
}

function setSize(sizeId) {
  orderState.currentCustomization.size = sizeId;
  renderCustomize();
}

function toggleTopping(toppingId) {
  const toppings = orderState.currentCustomization.toppings;
  const idx = toppings.indexOf(toppingId);
  if (idx >= 0) toppings.splice(idx, 1);
  else toppings.push(toppingId);
  renderCustomize();
}

function changeQuantity(delta) {
  orderState.currentCustomization.quantity = Math.max(1, orderState.currentCustomization.quantity + delta);
  document.getElementById('qtyValue').textContent = orderState.currentCustomization.quantity;
}

function customizePizza({ size, crust, toppings, quantity } = {}) {
  if (!orderState.selectedProduct) {
    return 'Error: No product selected. Use select-pizza first.';
  }

  if (size && SIZES.find(s => s.id === size)) orderState.currentCustomization.size = size;
  if (crust && CRUSTS.find(c => c.id === crust)) orderState.currentCustomization.crust = crust;
  if (toppings && Array.isArray(toppings)) orderState.currentCustomization.toppings = toppings;
  if (quantity && quantity >= 1) orderState.currentCustomization.quantity = quantity;

  renderCustomize();

  const price = calculateCustomizedPrice();
  const cp = orderState.currentCustomization;
  const sizeObj = SIZES.find(s => s.id === cp.size);
  const crustObj = CRUSTS.find(c => c.id === cp.crust);

  return `Pizza customized: ${sizeObj.name} ${crustObj.name} ${orderState.selectedProduct.name}. Toppings: ${cp.toppings.join(', ') || 'none'}. Quantity: ${cp.quantity}. Price: $${price.toFixed(2)}. Use add-to-cart to add to cart.`;
}

function calculateCustomizedPrice() {
  const product = orderState.selectedProduct;
  const cp = orderState.currentCustomization;
  if (!product) return 0;

  const sizeObj = SIZES.find(s => s.id === cp.size);
  const crustObj = CRUSTS.find(c => c.id === cp.crust);

  let price = product.basePrice;
  price += sizeObj ? sizeObj.priceModifier : 0;
  price += crustObj ? crustObj.priceModifier : 0;

  // Extra toppings beyond default
  const defaults = product.defaultToppings || [];
  const extraToppings = cp.toppings.filter(t => !defaults.includes(t));
  price += extraToppings.length * EXTRA_TOPPING_PRICE;

  return price * cp.quantity;
}

// ============ ADD TO CART ============
function addToCart() {
  if (!orderState.selectedProduct) {
    return 'Error: No product selected.';
  }

  const cp = orderState.currentCustomization;
  const sizeObj = SIZES.find(s => s.id === cp.size);
  const crustObj = CRUSTS.find(c => c.id === cp.crust);
  const price = calculateCustomizedPrice();
  const unitPrice = cp.quantity > 0 ? price / cp.quantity : price;

  const item = {
    cartId: generateCartId(),
    product: orderState.selectedProduct,
    size: cp.size,
    sizeName: sizeObj.name,
    crust: cp.crust,
    crustName: crustObj.name,
    toppings: [...cp.toppings],
    quantity: cp.quantity,
    unitPrice: unitPrice,
    price: price,
    name: `${sizeObj.name} ${crustObj.name} ${orderState.selectedProduct.name}`,
    calories: orderState.selectedProduct.calories
  };

  const editingIndex = orderState.editingCartIndex;
  if (editingIndex !== null && editingIndex >= 0 && editingIndex < orderState.cart.length) {
    item.cartId = orderState.cart[editingIndex].cartId;
    orderState.cart[editingIndex] = item;
    orderState.editingCartIndex = null;
    goToStep(6);
  } else {
    orderState.editingCartIndex = null;
    orderState.cart.push(item);
    goToStep(4);
    showCartToast(item.name);
  }

  const subtotal = getCartSubtotal();
  return `Added ${item.name} to cart (qty: ${cp.quantity}). Cart total: $${subtotal.toFixed(2)} (${orderState.cart.length} item${orderState.cart.length > 1 ? 's' : ''}). You can add more items or proceed-to-checkout.`;
}

// ============ STEP 6: CART ============
function renderCart() {
  const subtotal = getCartSubtotal();
  document.getElementById('cartSubtotal').textContent = `$${subtotal.toFixed(2)}`;

  // Cart items
  const itemsEl = document.getElementById('cartItems');
  if (orderState.cart.length === 0) {
    itemsEl.innerHTML = '<p style="color:#888; padding:16px 0;">Your cart is empty.</p>';
  } else {
    itemsEl.innerHTML = orderState.cart.map((item, i) => `
      <div class="cart-item">
        <div class="cart-item-img-placeholder">${item.product ? (item.product.emoji || '🍽️') : '🍕'}</div>
        <div class="cart-item-details">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-meta">${item.calories || ''}</div>
          <div class="cart-item-actions">
            <div class="cart-item-qty">
              <button class="qty-btn" onclick="updateCartItemQty(${i}, -1)">−</button>
              <span class="qty-value">${item.quantity}</span>
              <button class="qty-btn qty-plus" onclick="updateCartItemQty(${i}, 1)">+</button>
            </div>
            ${item.product && item.product.customizable ? `<button class="cart-action-link" onclick="editCartItem(${i})">Edit</button>` : ''}
            <button class="cart-action-link" onclick="removeCartItem(${i})">Remove</button>
          </div>
        </div>
        <div class="cart-item-price">$${item.price.toFixed(2)}</div>
      </div>
    `).join('');
  }

  // Sides — show a curated selection of popular non-customizable products
  const sideProducts = PRODUCTS.filter(p => !p.customizable && ['breads', 'potato-sides', 'chicken', 'desserts'].includes(p.category)).slice(0, 6);
  document.getElementById('sidesGrid').innerHTML = sideProducts.map(product => `
    <div class="side-card">
      <div class="side-card-img-placeholder">${product.emoji || '🥖'}</div>
      <button class="side-card-cart-btn" onclick="addSideUI('${product.id}')">🛒</button>
      <div class="side-card-name">${product.name}</div>
    </div>
  `).join('');
}

function updateCartItemQty(index, delta) {
  if (index < 0 || index >= orderState.cart.length) return;
  const item = orderState.cart[index];
  item.quantity = Math.max(0, item.quantity + delta);

  // Recalculate price
  if (item.product && item.product.customizable && item.size) {
    // Customized product (pizza) — recalculate from options
    const sizeObj = SIZES.find(s => s.id === item.size);
    const crustObj = CRUSTS.find(c => c.id === item.crust);
    const defaults = item.product.defaultToppings || [];
    let unitPrice = item.product.basePrice + (sizeObj ? sizeObj.priceModifier : 0) + (crustObj ? crustObj.priceModifier : 0);
    const extraToppings = (item.toppings || []).filter(t => !defaults.includes(t));
    unitPrice += extraToppings.length * EXTRA_TOPPING_PRICE;
    item.unitPrice = unitPrice;
    item.price = unitPrice * item.quantity;
  } else {
    // Simple product
    item.price = item.unitPrice * item.quantity;
  }

  if (item.quantity === 0) orderState.cart.splice(index, 1);
  renderCart();
  handleCartChanged();
}

function removeCartItem(index) {
  orderState.cart.splice(index, 1);
  renderCart();
  handleCartChanged();
}

function editCartItem(index) {
  const item = orderState.cart[index];
  if (item.product && item.product.customizable) {
    orderState.selectedProduct = item.product;
    orderState.editingCartIndex = index;
    orderState.currentCustomization = {
      size: item.size,
      crust: item.crust,
      toppings: [...(item.toppings || [])],
      quantity: item.quantity
    };
    goToStep(5);
  }
}

function cancelCustomization() {
  const returnToCart = orderState.editingCartIndex !== null;
  orderState.editingCartIndex = null;
  goToStep(returnToCart ? 6 : 4);
}

function continueShopping() {
  goToStep(orderState.currentCategory ? 4 : 3);
}

function updateCartItem({ itemIndex, quantity }) {
  if (itemIndex < 0 || itemIndex >= orderState.cart.length) {
    return `Error: Invalid item index ${itemIndex}. Cart has ${orderState.cart.length} items.`;
  }

  if (quantity !== undefined) {
    if (quantity <= 0) {
      orderState.cart.splice(itemIndex, 1);
    } else {
      const delta = quantity - orderState.cart[itemIndex].quantity;
      updateCartItemQty(itemIndex, delta);
    }
  }

  renderCart();
  handleCartChanged();
  const subtotal = getCartSubtotal();
  return `Cart updated. ${orderState.cart.length} item${orderState.cart.length !== 1 ? 's' : ''}, subtotal: $${subtotal.toFixed(2)}.`;
}

function proceedToCheckout() {
  if (orderState.cart.length === 0) {
    showError('cartError', 'Your cart is empty');
    return 'Error: Your cart is empty. Add items before proceeding to checkout.';
  }
  hideError('cartError');
  goToStep(7);

  const totals = calculateTotals();
  return `Proceeding to checkout. Subtotal: $${totals.subtotal.toFixed(2)}, Delivery Fee: $${totals.deliveryFee.toFixed(2)}, Tax: $${totals.tax.toFixed(2)}, Total: $${totals.total.toFixed(2)}. Please set checkout info (firstName, lastName, phone, email) and delivery instructions, then place-order.`;
}

// ============ STEP 7: CHECKOUT ============
function renderCheckout() {
  const totals = calculateTotals();

  // Restore form values from state
  document.getElementById('firstName').value = orderState.contact.firstName;
  document.getElementById('lastName').value = orderState.contact.lastName;
  document.getElementById('phone').value = orderState.contact.phone;
  document.getElementById('email').value = orderState.contact.email;
  document.getElementById('leaveAtDoor').checked = orderState.delivery.leaveAtDoor;
  document.getElementById('deliveryInstructions').value = orderState.delivery.instructions;

  // Summary
  const itemCount = orderState.cart.reduce((sum, item) => sum + item.quantity, 0);
  document.getElementById('summaryItemCount').textContent = `${itemCount} Item${itemCount !== 1 ? 's' : ''}`;
  document.getElementById('summaryItems').innerHTML = orderState.cart.map(item => `
    <div class="summary-line" style="font-size:12px;color:#555;">
      <span>${item.quantity}x ${item.name}</span>
      <span>$${item.price.toFixed(2)}</span>
    </div>
  `).join('');
  document.getElementById('summarySubtotal').textContent = `$${totals.subtotal.toFixed(2)}`;
  document.getElementById('summaryDeliveryFee').textContent = `$${totals.deliveryFee.toFixed(2)}`;
  document.getElementById('summaryTax').textContent = `$${totals.tax.toFixed(2)}`;
  document.getElementById('summaryTotal').textContent = `$${totals.total.toFixed(2)}`;
  document.getElementById('placeOrderTotal').textContent = `$${totals.total.toFixed(2)}`;
}

function updateCheckoutState() {
  orderState.contact.firstName = document.getElementById('firstName').value;
  orderState.contact.lastName = document.getElementById('lastName').value;
  orderState.contact.phone = document.getElementById('phone').value;
  orderState.contact.email = document.getElementById('email').value;
  orderState.delivery.leaveAtDoor = document.getElementById('leaveAtDoor').checked;
  orderState.delivery.instructions = document.getElementById('deliveryInstructions').value;
}

function setCheckoutInfo({ firstName, lastName, phone, email, leaveAtDoor, deliveryInstructions } = {}) {
  const contact = {
    firstName: firstName?.trim() || '',
    lastName: lastName?.trim() || '',
    phone: phone?.trim() || '',
    email: email?.trim() || ''
  };
  const validationErrors = validateCheckoutInfo(contact);

  for (const [field, message] of Object.entries(validationErrors)) {
    const errorId = `${field}Error`;
    if (message) {
      showError(errorId, message);
    } else {
      hideError(errorId);
    }
    document.getElementById(field).setAttribute('aria-invalid', String(Boolean(message)));
  }

  const errors = Object.values(validationErrors).filter(Boolean);
  if (errors.length > 0) {
    return `Validation errors: ${errors.join('. ')}.`;
  }

  orderState.contact = contact;
  if (leaveAtDoor !== undefined) orderState.delivery.leaveAtDoor = leaveAtDoor;
  if (deliveryInstructions !== undefined) orderState.delivery.instructions = deliveryInstructions;

  // Update form
  document.getElementById('firstName').value = contact.firstName;
  document.getElementById('lastName').value = contact.lastName;
  document.getElementById('phone').value = contact.phone;
  document.getElementById('email').value = contact.email;
  document.getElementById('leaveAtDoor').checked = orderState.delivery.leaveAtDoor;
  document.getElementById('deliveryInstructions').value = orderState.delivery.instructions || '';

  const totals = calculateTotals();
  return `Checkout info saved for ${contact.firstName} ${contact.lastName}. Ready to place order. Total: $${totals.total.toFixed(2)}.`;
}

async function placeOrder() {
  updateCheckoutState();
  const infoResult = setCheckoutInfo(orderState.contact);
  if (infoResult.startsWith('Validation')) {
    showError('checkoutError', 'Please correct the highlighted contact fields');
    return `Error: ${infoResult}`;
  }
  if (!orderState.store) {
    showError('checkoutError', 'Please choose a store before placing your order');
    return 'Error: Please choose a store before placing your order.';
  }
  hideError('checkoutError');

  const totals = calculateTotals();
  const confirmed = await requestOrderConfirmation(totals);
  if (!confirmed) return 'Order cancelled by user.';

  // Generate order number
  const orderNumber = `CP-${String(Math.floor(10000 + Math.random() * 90000))}`;
  orderState.confirmation = {
    orderNumber,
    estimatedDelivery: orderState.store.deliveryEstimate,
    totals
  };

  goToStep(8);

  return `Order placed! Order ${orderNumber}. Estimated ${orderState.orderType}: ${orderState.store.deliveryEstimate}. Total charged: $${totals.total.toFixed(2)}.`;
}

function validateCheckoutInfo(contact) {
  return {
    firstName: contact.firstName ? '' : 'First name is required',
    lastName: contact.lastName ? '' : 'Last name is required',
    phone: contact.phone && contact.phone.replace(/\D/g, '').length >= 10 ? '' : 'Please enter a valid phone number',
    email: contact.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) ? '' : 'Please enter a valid email address'
  };
}

function requestOrderConfirmation(totals) {
  const dialog = document.getElementById('orderConfirmationDialog');
  const destination = orderState.orderType === 'delivery'
    ? `Delivery to: ${orderState.address}`
    : `Carryout from: ${orderState.store.name}`;
  document.getElementById('orderConfirmationSummary').textContent = [
    `Total: $${totals.total.toFixed(2)}`,
    destination,
    ...orderState.cart.map(item => `${item.quantity}x ${item.name}`)
  ].join('\n');

  return new Promise(resolve => {
    const finish = confirmed => {
      cancelButton.removeEventListener('click', handleCancelClick);
      confirmButton.removeEventListener('click', handleConfirmClick);
      dialog.removeEventListener('cancel', handleDialogCancel);
      dialog.close();
      resolve(confirmed);
    };
    const cancelButton = dialog.querySelector('[value="cancel"]');
    const confirmButton = dialog.querySelector('[value="confirm"]');
    const handleCancelClick = () => finish(false);
    const handleConfirmClick = () => finish(true);
    const handleDialogCancel = event => {
      event.preventDefault();
      finish(false);
    };
    cancelButton.addEventListener('click', handleCancelClick);
    confirmButton.addEventListener('click', handleConfirmClick);
    dialog.addEventListener('cancel', handleDialogCancel);
    dialog.showModal();
  });
}

// ============ STEP 8: CONFIRMATION ============
function renderConfirmation() {
  const conf = orderState.confirmation;
  if (!conf) return;

  document.getElementById('confirmOrderNumber').textContent = `Order ${conf.orderNumber}`;
  document.getElementById('confirmEstimate').textContent =
    `Estimated ${orderState.orderType}: ${conf.estimatedDelivery}`;

  document.getElementById('confirmSummary').innerHTML = `
    ${orderState.cart.map(item => `
      <div class="confirmation-summary-line">
        <span>${item.quantity}x ${item.name}</span>
        <span>$${item.price.toFixed(2)}</span>
      </div>
    `).join('')}
    <div class="confirmation-summary-line">
      <span>Delivery Fee</span>
      <span>$${conf.totals.deliveryFee.toFixed(2)}</span>
    </div>
    <div class="confirmation-summary-line">
      <span>Tax</span>
      <span>$${conf.totals.tax.toFixed(2)}</span>
    </div>
    <div class="confirmation-summary-line total">
      <span>Total</span>
      <span>$${conf.totals.total.toFixed(2)}</span>
    </div>
  `;
}

function startNewOrder() {
  // Reset state
  orderState.orderType = null;
  orderState.address = null;
  orderState.store = null;
  orderState.timing = 'now';
  orderState.currentCategory = null;
  orderState.selectedProduct = null;
  orderState.editingCartIndex = null;
  orderState.currentCustomization = { size: 'medium', crust: 'classic', toppings: [], quantity: 1 };
  orderState.cart = [];
  orderState.contact = { firstName: '', lastName: '', phone: '', email: '' };
  orderState.delivery = { leaveAtDoor: false, instructions: '' };
  orderState.confirmation = null;

  // Reset UI
  document.getElementById('addressEntry').style.display = 'block';
  document.getElementById('storeResult').style.display = 'none';
  document.getElementById('addressInput').value = '';

  goToStep(1);
}

// ============ HELPERS ============
function generateCartId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateCartMarkdown() {
  const lines = [];
  lines.push('## Cart');
  lines.push('');
  if (orderState.cart.length === 0) {
    lines.push('Cart is empty.');
  } else {
    for (const item of orderState.cart) {
      lines.push(`- \`${item.cartId}\` — ${item.quantity}x ${item.name} — $${item.price.toFixed(2)}`);
    }
  }
  lines.push('');
  const totals = calculateTotals();
  lines.push('## Totals');
  lines.push('');
  lines.push(`- **Subtotal:** $${totals.subtotal.toFixed(2)}`);
  if (totals.deliveryFee > 0) lines.push(`- **Delivery Fee:** $${totals.deliveryFee.toFixed(2)}`);
  lines.push(`- **Tax:** $${totals.tax.toFixed(2)}`);
  lines.push(`- **Total:** $${totals.total.toFixed(2)}`);
  return lines.join('\n');
}

function addItemToCartFromSpec(itemSpec) {
  const validationError = validateItemSpec(itemSpec);
  if (validationError) return { success: false, error: validationError };

  const product = getProductById(itemSpec.productId);
  const qty = itemSpec.quantity || 1;
  const cartId = generateCartId();

  if (product.customizable) {
    const size = itemSpec.size || 'medium';
    const crust = itemSpec.crust || 'classic';
    const toppings = itemSpec.toppings !== undefined ? itemSpec.toppings : [...(product.defaultToppings || [])];

    const sizeObj = SIZES.find(s => s.id === size) || SIZES[1];
    const crustObj = CRUSTS.find(c => c.id === crust) || CRUSTS[0];

    let unitPrice = product.basePrice;
    unitPrice += sizeObj.priceModifier;
    unitPrice += crustObj.priceModifier;

    const defaults = product.defaultToppings || [];
    const extraToppings = toppings.filter(t => !defaults.includes(t));
    unitPrice += extraToppings.length * EXTRA_TOPPING_PRICE;

    orderState.cart.push({
      cartId,
      product,
      size,
      sizeName: sizeObj.name,
      crust,
      crustName: crustObj.name,
      toppings: [...toppings],
      quantity: qty,
      unitPrice,
      price: unitPrice * qty,
      name: `${sizeObj.name} ${crustObj.name} ${product.name}`,
      calories: product.calories
    });

    return { success: true, description: `${qty}x ${sizeObj.name} ${crustObj.name} ${product.name} — $${(unitPrice * qty).toFixed(2)}`, cartId };
  } else {
    orderState.cart.push({
      cartId,
      product,
      quantity: qty,
      unitPrice: product.basePrice,
      price: product.basePrice * qty,
      name: product.name,
      calories: product.calories || ''
    });

    return { success: true, description: `${qty}x ${product.name} — $${(product.basePrice * qty).toFixed(2)}`, cartId };
  }
}

function validateItemSpec(itemSpec) {
  const product = getProductById(itemSpec.productId);
  if (!product) return `Product "${itemSpec.productId}" not found.`;
  if (itemSpec.quantity !== undefined && (!Number.isInteger(itemSpec.quantity) || itemSpec.quantity < 1)) {
    return `Quantity for "${itemSpec.productId}" must be a positive integer.`;
  }
  if (!product.customizable) return '';
  if (itemSpec.size !== undefined && !SIZES.some(size => size.id === itemSpec.size)) {
    return `Size "${itemSpec.size}" is not available for "${itemSpec.productId}".`;
  }
  if (itemSpec.crust !== undefined && !CRUSTS.some(crust => crust.id === itemSpec.crust)) {
    return `Crust "${itemSpec.crust}" is not available for "${itemSpec.productId}".`;
  }
  if (itemSpec.toppings !== undefined) {
    if (!Array.isArray(itemSpec.toppings)) return `Toppings for "${itemSpec.productId}" must be an array.`;
    const availableToppings = new Set(TOPPINGS.map(topping => topping.id));
    const invalidToppings = itemSpec.toppings.filter(topping => !availableToppings.has(topping));
    if (invalidToppings.length > 0) {
      return `Toppings not available for "${itemSpec.productId}": ${[...new Set(invalidToppings)].join(', ')}.`;
    }
    if (new Set(itemSpec.toppings).size !== itemSpec.toppings.length) {
      return `Toppings for "${itemSpec.productId}" must not contain duplicates.`;
    }
  }
  return '';
}

function getCartSubtotal() {
  return orderState.cart.reduce((sum, item) => sum + item.price, 0);
}

function calculateTotals() {
  const subtotal = getCartSubtotal();
  const deliveryFee = orderState.orderType === 'delivery' ? DELIVERY_FEE : 0;
  const tax = Math.round((subtotal + deliveryFee) * TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + deliveryFee + tax) * 100) / 100;
  return { subtotal, deliveryFee, tax, total };
}

function updateNavDeliveryInfo() {
  const el = document.getElementById('navDeliveryInfo');
  const pill = document.getElementById('navLocationPill');
  if (orderState.address && orderState.store && currentStep >= 3) {
    el.hidden = false;
    if (pill) pill.hidden = true;
    const location = orderState.orderType === 'delivery' ? orderState.address : orderState.store.address;
    const fulfillment = orderState.orderType === 'delivery' ? 'Delivery' : 'Carryout';
    document.getElementById('navDeliveryText').textContent =
      `${fulfillment} \u00B7 ${orderState.store.deliveryEstimate} \u00B7 ${location.substring(0, 30)}${location.length > 30 ? '...' : ''}`;
  } else {
    el.hidden = true;
    if (pill) pill.hidden = false;
  }
}

function updateCartBadge() {
  const badge = document.getElementById('cartBadge');
  const count = orderState.cart.reduce((sum, item) => sum + item.quantity, 0);
  if (count > 0) {
    badge.style.display = 'flex';
    badge.textContent = count;
  } else {
    badge.style.display = 'none';
  }
}

function handleCartChanged() {
  updateCartBadge();
  if (typeof registerToolsForStep === 'function') {
    registerToolsForStep(currentStep);
  }
}

let cartToastTimer;

function showCartToast(itemName) {
  const toast = document.getElementById('cartToast');
  const message = document.getElementById('cartToastMessage');
  const viewCartButton = document.getElementById('cartToastViewButton');
  if (!toast || !message || !viewCartButton) return;

  const count = orderState.cart.reduce((sum, item) => sum + item.quantity, 0);
  message.textContent = `${itemName} added to your cart.`;
  viewCartButton.textContent = `VIEW CART (${count})`;
  toast.hidden = false;

  clearTimeout(cartToastTimer);
  cartToastTimer = setTimeout(hideCartToast, 5000);
}

function hideCartToast() {
  clearTimeout(cartToastTimer);
  const toast = document.getElementById('cartToast');
  if (toast) toast.hidden = true;
}

function viewCart() {
  hideCartToast();
  goToStep(6);
}

function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el && message) {
    el.textContent = message;
    el.style.display = 'block';
  }
}

function hideError(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.style.display = 'none';
}

function getStateSnapshot() {
  return {
    orderType: orderState.orderType,
    address: orderState.address,
    timing: orderState.timing
  };
}

// ============ URL STATE MANAGEMENT ============
const BASE_PATH = new URL('.', window.location.href).pathname;
const STEP_SLUGS = {
  1: 'home',
  2: 'location',
  3: 'menu',
  4: 'products',
  5: 'customize',
  6: 'cart',
  7: 'checkout',
  8: 'confirmation'
};

function updateURL() {
  const params = new URLSearchParams();
  params.set('step', STEP_SLUGS[currentStep] || STEP_SLUGS[1]);
  history.pushState({ step: currentStep }, '', `${BASE_PATH}?${params}`);
}

function restoreFromURL() {
  // Order state is intentionally kept in memory, so a fresh document load
  // cannot safely resume a later step from the URL alone.
  goToStep(1, true);
}

// Handle browser back/forward buttons
window.addEventListener('popstate', (event) => {
  if (event.state && event.state.step) {
    goToStep(event.state.step, true);
  } else {
    // No state, restore from URL params
    restoreFromURL();
  }
});

function goToHome() {
  startNewOrder();
}

// ============ INIT ============
// Start on Step 1 — register tools once webmcp-tools.js loads
document.addEventListener('DOMContentLoaded', () => {
  restoreFromURL();
  history.replaceState({ step: currentStep }, '', BASE_PATH);
});
