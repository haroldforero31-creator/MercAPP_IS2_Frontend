/* ============================================================
   MercAPP — POS JavaScript Engine
   Cart management, barcode scanning, payments, receipts
   ============================================================ */

// ============================================================
// GLOBAL STATE
// ============================================================
const cart = [];
let currentTotal = 0;
let lastSaleId = null;
let lastReceiptNumber = null;
let searchTimeout = null;
let searchAbortController = null;
let currentWeightProduct = null;

// MULTI-TAB POS SYSTEM STATE
let posTabs = [];
let activeTabId = 1;
let tabCounter = 1;

function initTabs() {
    try {
        const savedTabs = localStorage.getItem('mercapp_pos_tabs');
        if (savedTabs) {
            const parsed = JSON.parse(savedTabs);
            if (parsed.tabs && parsed.tabs.length > 0) {
                posTabs = parsed.tabs;
                activeTabId = parsed.active;
                tabCounter = Math.max(...posTabs.map(t => t.id), 0);
            }
        } else {
            // Migrate from old single cart if exists
            const oldCart = localStorage.getItem('mercapp_pos_cart');
            if (oldCart) {
                const parsedCart = JSON.parse(oldCart);
                if (Array.isArray(parsedCart) && parsedCart.length > 0) {
                    posTabs.push({ id: 1, title: 'Venta 1', cart: parsedCart });
                    localStorage.removeItem('mercapp_pos_cart');
                }
            }
        }
    } catch(e) {
        console.error("Error loading tabs", e);
    }

    if (posTabs.length === 0) {
        posTabs.push({ id: 1, title: 'Venta 1', cart: [] });
    }
    
    // Validate activeTabId exists
    if (!posTabs.find(t => t.id === activeTabId)) {
        activeTabId = posTabs[0].id;
    }
    
    loadActiveTabCart();
    renderTabs();
}

function loadActiveTabCart() {
    const activeTab = posTabs.find(t => t.id === activeTabId);
    cart.length = 0; // Clear the const array
    if (activeTab && activeTab.cart) {
        cart.push(...activeTab.cart);
    }
    updateCartDisplay();
}

function saveTabs() {
    const activeTab = posTabs.find(t => t.id === activeTabId);
    if (activeTab) {
        // Deep copy cart to prevent references issues
        activeTab.cart = JSON.parse(JSON.stringify(cart));
    }
    localStorage.setItem('mercapp_pos_tabs', JSON.stringify({ tabs: posTabs, active: activeTabId }));
}

function renderTabs() {
    const container = document.getElementById('posTabs');
    if(!container) return;
    
    container.innerHTML = '';
    posTabs.forEach((tab, index) => {
        const div = document.createElement('div');
        div.className = `pos-tab ${tab.id === activeTabId ? 'active' : ''}`;
        div.onclick = () => switchTab(tab.id);
        
        const titleSpan = document.createElement('span');
        // Dynamic title based on order: Venta 1, Venta 2, etc.
        titleSpan.textContent = `Venta ${index + 1}`;
        div.appendChild(titleSpan);
        
        // Count items
        const itemsCount = tab.cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
        if (itemsCount > 0) {
            const badge = document.createElement('span');
            badge.style.fontSize = '0.75rem';
            badge.style.background = tab.id === activeTabId ? '#fff' : '#333';
            badge.style.color = tab.id === activeTabId ? '#2E7D32' : '#fff';
            badge.style.padding = '2px 6px';
            badge.style.borderRadius = '10px';
            badge.textContent = itemsCount;
            div.appendChild(badge);
        }
        
        // Add close button if there is more than 1 tab
        if (posTabs.length > 1) {
            const closeBtn = document.createElement('span');
            closeBtn.className = 'pos-tab-close';
            closeBtn.innerHTML = '×';
            closeBtn.title = "Cerrar Venta";
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                closeTab(tab.id);
            };
            div.appendChild(closeBtn);
        }
        
        container.appendChild(div);
    });
}

function switchTab(id) {
    if (activeTabId === id) return;
    saveTabs(); // Save current before switching
    activeTabId = id;
    loadActiveTabCart();
    renderTabs();
    saveTabs(); // Save active tab change
    document.getElementById('barcodeInput').focus();
}

function addPosTab() {
    saveTabs();
    tabCounter++;
    const newId = tabCounter;
    posTabs.push({ id: newId, title: 'Venta ' + newId, cart: [] });
    activeTabId = newId;
    loadActiveTabCart();
    renderTabs();
    saveTabs();
    document.getElementById('barcodeInput').focus();
}

function closeTab(id) {
    posTabs = posTabs.filter(t => t.id !== id);
    if (posTabs.length === 0) {
        tabCounter++;
        posTabs.push({ id: tabCounter, title: 'Venta ' + tabCounter, cart: [] });
        activeTabId = tabCounter;
    } else if (activeTabId === id) {
        // If we closed the active tab, switch to the last available
        activeTabId = posTabs[posTabs.length - 1].id;
    }
    loadActiveTabCart();
    renderTabs();
    saveTabs();
}

// Scale mode: 'manual' or 'auto' (set from server-side template)
let scaleMode = 'manual';

// ============================================================
// TEXT-TO-SPEECH (TTS) — Voice Announcements
// ============================================================
function isVoiceEnabled() {
    return localStorage.getItem('mercapp_voice_enabled') === 'true';
}

function setVoiceEnabled(enabled) {
    localStorage.setItem('mercapp_voice_enabled', enabled ? 'true' : 'false');
    const toggle = document.getElementById('chkVoiceAnnounce');
    if (toggle) toggle.checked = enabled;
}

function announceTotal(total) {
    if (!isVoiceEnabled()) return;
    if (!('speechSynthesis' in window)) return;

    // Cancel any ongoing speech
    speechSynthesis.cancel();

    // Format total for natural speech: "15.500" → "quince mil quinientos"
    const totalNum = Math.floor(total);
    const formatted = totalNum.toLocaleString('es-CO');
    const mensaje = new SpeechSynthesisUtterance(
        `El total de su compra es ${formatted} pesos`
    );
    mensaje.lang = 'es-MX';
    mensaje.rate = 0.95;
    mensaje.pitch = 1.0;
    mensaje.volume = 1.0;

    // Try to find a Spanish voice
    const voices = speechSynthesis.getVoices();
    const spanishVoice = voices.find(v => v.lang.startsWith('es'));
    if (spanishVoice) mensaje.voice = spanishVoice;

    speechSynthesis.speak(mensaje);
}

// Smart dropdown state
let dropdownProducts = [];
let dropdownHighlight = -1;

const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

// ============================================================
// INITIALIZATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const barcodeInput = document.getElementById('barcodeInput');
    const dropdown = document.getElementById('smartDropdown');
    
    // Auto-focus barcode input
    barcodeInput.focus();

    // Auto-detect scale on load
    autoDetectScale(true);

    // ─── Live Unified Search as user types ───────────────────
    barcodeInput.addEventListener('input', () => {
        const value = barcodeInput.value.trim();
        if (searchTimeout) clearTimeout(searchTimeout);

        if (value.length === 0) {
            closeDropdown();
            updateSearchIcon('idle');
            return;
        }

        if (value.length < 2) {
            updateSearchIcon(/^\d+$/.test(value) ? 'barcode' : 'name');
            return;
        }

        // For pure numeric input (barcode scanner), DON'T search live — wait for Enter.
        // This prevents partial barcode queries from slowing down the system.
        const isNumeric = /^\d+$/.test(value);
        updateSearchIcon(isNumeric ? 'barcode' : 'name');

        if (isNumeric) {
            // Barcode: skip live search, scanner will send Enter at the end
            closeDropdown();
            return;
        }

        // Name search: debounce at 400ms
        searchTimeout = setTimeout(() => {
            runSmartSearch(value, false);
        }, 400);
    });

    // ─── Keyboard navigation inside dropdown ────────────────
    barcodeInput.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.smart-dropdown-item');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            dropdownHighlight = Math.min(dropdownHighlight + 1, items.length - 1);
            refreshHighlight(items);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            dropdownHighlight = Math.max(dropdownHighlight - 1, 0);
            refreshHighlight(items);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = barcodeInput.value.trim();
            if (!value) return;

            if (dropdownHighlight >= 0 && items[dropdownHighlight]) {
                // Select the highlighted item
                items[dropdownHighlight].click();
            } else {
                // No item highlighted — run committed search (adds immediately if exact barcode)
                runSmartSearch(value, true);
            }
            return;
        }
        if (e.key === 'Escape') {
            closeDropdown();
            return;
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.scanner-input-wrapper')) {
            closeDropdown();
        }
    });
    
    // Re-focus barcode input when clicking anywhere on the cart panel
    document.querySelector('.pos-cart-panel').addEventListener('click', (e) => {
        if (!e.target.closest('button') && !e.target.closest('input') && !e.target.closest('.smart-dropdown')) {
            barcodeInput.focus();
        }
    });

    // Restrict card input to digits only
    if(document.getElementById('cardLast4')) document.getElementById('cardLast4').addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, '').slice(0, 4);
    });

    // Restrict amount received to digits only
    if (document.getElementById('amountReceived')) {
        document.getElementById('amountReceived').addEventListener('input', function() {
            this.value = this.value.replace(/\D/g, '');
            calculateChange();
        });
    }

    // Restrict transfer ref to digits only
    if(document.getElementById('transferRef')) document.getElementById('transferRef').addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, '');
    });

    // Restrict transfer name to letters and spaces only
    if(document.getElementById('transferName')) document.getElementById('transferName').addEventListener('input', function() {
        this.value = this.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s]/g, '');
    });

    // Handle manual weight input calculation
    if (document.getElementById('manualWeightInput')) {
        document.getElementById('manualWeightInput').addEventListener('input', function() {
            this.value = this.value.replace(/\D/g, '');
            if (currentWeightProduct) {
                calculateWeightSubtotal(parseInt(this.value) || 0);
            }
        });
    }

    // Sync all print toggles across payment tabs
    const mainPrintChk = document.getElementById('chkPrintReceipt');
    if (mainPrintChk) {
        // Ensure explicitly unchecked on load to prevent browser cache issues
        mainPrintChk.checked = false;
        document.querySelectorAll('.chk-print-mirror').forEach(mirror => {
            mirror.checked = false;
            mirror.addEventListener('change', () => {
                mainPrintChk.checked = mirror.checked;
                document.querySelectorAll('.chk-print-mirror').forEach(m => m.checked = mirror.checked);
            });
        });

        mainPrintChk.addEventListener('change', () => {
            document.querySelectorAll('.chk-print-mirror').forEach(m => m.checked = mainPrintChk.checked);
        });
    }
});

// ============================================================
// FORMAT HELPERS
// ============================================================
function formatCOP(value) {
    if (!value && value !== 0) return '$0';
    return '$' + Math.floor(value).toLocaleString('es-CO');
}

// ============================================================
// SMART SEARCH — Unified barcode + name detection
// ============================================================

function runSmartSearch(query, commitMode) {
    /**
     * commitMode = true  → called on Enter with no dropdown selection.
     */
    
    // Check for PLU barcode (starts with 2, length 13)
    if (commitMode && query.length === 13 && query.startsWith('2')) {
        const pluCode = query.substring(1, 6); // 5 digits PLU
        const priceOrWeight = parseInt(query.substring(7, 12), 10); // 5 digits Price
        
        fetch(`/api/product/plu?code=${pluCode}`)
            .then(res => res.json())
            .then(data => {
                if (data.success && data.product) {
                    const product = data.product;
                    
                    // Add directly to cart with the exact price from barcode
                    const cartItem = {
                        product_id: product.id,
                        name: product.name,
                        barcode: query,
                        unit_price: priceOrWeight, // Use price from barcode!
                        quantity: 1,
                        subtotal: priceOrWeight,
                        stock: product.stock,
                        image: product.image,
                        sell_by_weight: false, // Treat as fixed price item since price is already calculated
                        is_plu: true
                    };
                    
                    cart.push(cartItem);
                    updateCartDisplay();
                    showToast('', `${product.name} agregado (${formatCOP(priceOrWeight)})`, 'success');
                    closeDropdown();
                    clearInput();
                } else {
                    showToast('', data.message || 'Código PLU no registrado', 'error');
                    closeDropdown();
                    clearInput();
                }
            })
            .catch(() => showToast('', 'Error consultando PLU', 'error'));
        return;
    }

    // Cancel any previous in-flight search to free server threads
    if (searchAbortController) {
        searchAbortController.abort();
    }
    searchAbortController = new AbortController();
    
    fetch(`/api/product/smart-search?q=${encodeURIComponent(query)}`, { signal: searchAbortController.signal })
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                if (commitMode) {
                    // If it looks like a barcode (numeric), show BLOCKING modal
                    if (/^\d+$/.test(query)) {
                        showNotFoundModal(query);
                    } else {
                        showToast('', data.message || 'Producto no encontrado', 'error');
                    }
                    closeDropdown();
                    clearInput();
                } else {
                    if (data.mode === 'barcode') {
                        closeDropdown();
                    } else {
                        showDropdownEmpty(data.message || 'Sin resultados');
                    }
                }
                return;
            }

            const products = data.products || [];
            const mode = data.mode; // 'barcode' | 'barcode_partial' | 'name'

            // Exact barcode hit on Enter → add immediately, no dropdown
            if (commitMode && mode === 'barcode' && products.length === 1) {
                addToCart(products[0]);
                showToast('', `${products[0].name} agregado`, 'success');
                closeDropdown();
                clearInput();
                return;
            }

            // Single result on Enter (any mode) → add immediately
            if (commitMode && products.length === 1) {
                addToCart(products[0]);
                showToast('', `${products[0].name} agregado`, 'success');
                closeDropdown();
                clearInput();
                return;
            }

            // Exact barcode match while typing → do not add directly to prevent double entry, wait for Enter
            if (!commitMode && mode === 'barcode' && products.length === 1) {
                closeDropdown();
                return;
            }

            // Multiple results → show dropdown (only for name search or partial barcode)
            showDropdown(products, mode);
        })
        .catch((err) => {
            if (err.name === 'AbortError') return; // Cancelled intentionally, ignore
            if (commitMode) showToast('', 'Error de conexión', 'error');
        });
}

function clearInput() {
    const input = document.getElementById('barcodeInput');
    input.value = '';
    input.focus();
    updateSearchIcon('idle');
}

// ─── Dropdown Rendering ──────────────────────────────────────

function showDropdown(products, mode) {
    const dropdown = document.getElementById('smartDropdown');
    dropdownProducts = products;
    dropdownHighlight = -1;

    if (products.length === 0) {
        showDropdownEmpty('No se encontraron productos');
        return;
    }

    const isBarcode = mode === 'barcode' || mode === 'barcode_partial';
    const headerLabel = isBarcode ? ' Código de barras' : ' Resultados de búsqueda';

    let html = `<div class="smart-dropdown-header">${headerLabel} — ${products.length} resultado${products.length !== 1 ? 's' : ''}</div>`;

    products.forEach((p, i) => {
        const imgSrc = p.image && p.image !== 'default_product.png'
            ? `/user_images/products/${p.image}` : null;
        const imgContent = imgSrc
            ? `<img src="${imgSrc}" alt="" onerror="this.parentElement.textContent=''">`
            : '';
        const barcodeClass = (mode === 'barcode' && i === 0) ? ' barcode-match' : '';
        const weightBadge = p.sell_by_weight ? `<span class="badge"> ${p.weight_unit}</span>` : '';
        const catBadge = p.category ? `<span class="badge">${p.category}</span>` : '';

        html += `
            <div class="smart-dropdown-item${barcodeClass}" data-index="${i}"
                 onclick="selectDropdownProduct(${i})">
                <div class="smart-dropdown-item-img">${imgContent}</div>
                <div class="smart-dropdown-item-info">
                    <div class="smart-dropdown-item-name">${p.name}</div>
                    <div class="smart-dropdown-item-meta">
                        ${catBadge}${weightBadge}
                        ${p.barcode ? `<span style="font-family:monospace;opacity:0.6">${p.barcode}</span>` : ''}
                    </div>
                </div>
                <div class="smart-dropdown-item-price">${p.price_formatted}</div>
            </div>`;
    });

    html += `<div class="smart-dropdown-hint">
        <span><kbd>↑↓</kbd> Navegar</span>
        <span><kbd>Enter</kbd> Agregar</span>
        <span><kbd>Esc</kbd> Cerrar</span>
    </div>`;

    dropdown.innerHTML = html;
    dropdown.classList.add('visible');
}

function showDropdownEmpty(message) {
    const dropdown = document.getElementById('smartDropdown');
    dropdownProducts = [];
    dropdownHighlight = -1;
    dropdown.innerHTML = `
        <div class="smart-dropdown-empty">
            <span class="empty-icon"></span>
            ${message}
        </div>`;
    dropdown.classList.add('visible');
}

function closeDropdown() {
    const dropdown = document.getElementById('smartDropdown');
    dropdown.classList.remove('visible');
    dropdownProducts = [];
    dropdownHighlight = -1;
}

function refreshHighlight(items) {
    items.forEach((el, i) => {
        el.classList.toggle('highlighted', i === dropdownHighlight);
    });
    if (items[dropdownHighlight]) {
        items[dropdownHighlight].scrollIntoView({ block: 'nearest' });
    }
}

function selectDropdownProduct(index) {
    const product = dropdownProducts[index];
    if (!product) return;
    addToCart(product);
    showToast('', `${product.name} agregado`, 'success');
    closeDropdown();
    clearInput();
}

function updateSearchIcon(mode) {
    const indicator = document.getElementById('searchModeIndicator');
    if (!indicator) return;
    const icons = {
        barcode: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="11" y1="8" x2="11" y2="16"/><line x1="15" y1="8" x2="15" y2="16"/></svg>',
        name: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        idle: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
    };
    const titles = {
        barcode: 'Código de barras detectado',
        name: 'Buscando por nombre',
        idle: 'Escanea o escribe un producto'
    };
    indicator.innerHTML = icons[mode] || icons.idle;
    indicator.title = titles[mode] || titles.idle;
    indicator.className = `search-mode-indicator mode-${mode || 'idle'}`;
}

// Keep searchProducts for the right panel search input
function searchProducts(query) {
    if (!query || query.length < 2) return;
    fetch(`/api/product/search?q=${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const grid = document.getElementById('searchResults');
                document.getElementById('categoriesGrid').style.display = 'none';
                document.getElementById('productsGrid').style.display = 'none';
                grid.style.display = 'grid';
                document.getElementById('panelTitle').innerHTML = ` Resultados: "${query}"`;
                document.getElementById('panelBackBtn').classList.add('visible');
                if (data.products.length === 0) {
                    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">
                        <div style="font-size:2.5rem;margin-bottom:12px"></div><p>No se encontraron productos</p></div>`;
                } else {
                    grid.innerHTML = data.products.map(p => createProductButton(p)).join('');
                }
            }
        })
        .catch(() => {});
}

// ============================================================
// CATEGORY & PRODUCT LOADING
// ============================================================
function loadCategoryProducts(categoryId, categoryName) {
    fetch(`/api/category/${categoryId}/products`)
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const grid = document.getElementById('productsGrid');
                document.getElementById('categoriesGrid').style.display = 'none';
                document.getElementById('searchResults').style.display = 'none';
                grid.style.display = 'grid';
                
                document.getElementById('panelTitle').innerHTML = ` ${categoryName}`;
                document.getElementById('panelBackBtn').classList.add('visible');
                
                // Regain focus on the main barcode scanner
                const barcodeInput = document.getElementById('barcodeInput');
                if (barcodeInput) setTimeout(() => barcodeInput.focus(), 50);
                
                if (data.products.length === 0) {
                    grid.innerHTML = `
                        <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                            <div style="font-size: 2.5rem; margin-bottom: 12px;"></div>
                            <p>No hay productos en esta categoría</p>
                            <a href="/products/add" class="btn btn-primary btn-sm" style="margin-top: 12px;">+ Agregar Producto</a>
                        </div>`;
                } else {
                    grid.innerHTML = data.products.map(p => createProductButton(p)).join('');
                }
            }
        })
        .catch(() => {
            showToast('', 'Error cargando productos', 'error');
        });
}

function createProductButton(product) {
    const imgSrc = product.image && product.image !== 'default_product.png' 
        ? `/user_images/products/${product.image}`
        : '';
    
    const imgHtml = imgSrc 
        ? `<img src="${imgSrc}" alt="${product.name}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block'">
           <span style="display: none; font-size: 2rem;"></span>`
        : `<span style="font-size: 2rem;"></span>`;
    
    return `
        <button class="product-btn" onclick='addToCartFromBtn(${JSON.stringify(product)})'>
            ${imgHtml}
            <span class="prod-name">${product.name}</span>
            <span class="prod-price">${product.price_formatted}</span>
        </button>`;
}

function showCategories() {
    document.getElementById('categoriesGrid').style.display = 'grid';
    document.getElementById('productsGrid').style.display = 'none';
    document.getElementById('searchResults').style.display = 'none';
    document.getElementById('panelTitle').innerHTML = ' Categorías';
    document.getElementById('panelBackBtn').classList.remove('visible');
    // Keep panelSearchInput value - don't clear it unless user does it manually
    
    // Regain focus on the main barcode scanner
    const barcodeInput = document.getElementById('barcodeInput');
    if (barcodeInput) setTimeout(() => barcodeInput.focus(), 50);
}

// ============================================================
// CART MANAGEMENT
// ============================================================
function addToCart(product) {
    if (product.sell_by_weight) {
        openWeightModal(product);
        return;
    }

    const existingIndex = cart.findIndex(item => item.product_id === product.id);
    
    if (existingIndex !== -1) {
        const existing = cart[existingIndex];
        // Stock validation
        if (!product.sell_by_weight && product.stock !== null) {
            if (existing.quantity >= product.stock) {
                showToast('', `Stock insuficiente para "${product.name}"`, 'error');
                return;
            }
        }
        existing.quantity += 1;
        existing.subtotal = existing.quantity * existing.unit_price;
        
        // Mover al final del array para que se muestre de primero al hacer prepend()
        cart.splice(existingIndex, 1);
        cart.push(existing);
    } else {
        // Initial stock check
        if (!product.sell_by_weight && product.stock !== null) {
            if (product.stock <= 0) {
                showToast('', `El producto "${product.name}" está agotado`, 'error');
                return;
            }
        }
        cart.push({
            product_id: product.id,
            name: product.name,
            barcode: product.barcode || '',
            unit_price: product.price,
            quantity: 1,
            subtotal: product.price,
            stock: product.stock,
            image: product.image,
            sell_by_weight: false
        });
    }
    
    updateCartDisplay();
    
    // Re-focus barcode input
    document.getElementById('barcodeInput').focus();
}

function addToCartFromBtn(product) {
    addToCart(product);
    showToast('', `${product.name} agregado`, 'success');
    
    // Regain focus on the main barcode scanner
    const barcodeInput = document.getElementById('barcodeInput');
    if (barcodeInput) setTimeout(() => barcodeInput.focus(), 50);
}

function updateQuantity(index, delta) {
    const item = cart[index];
    if (!item) return;
    
    if (item.sell_by_weight) {
        // Can't +1 / -1 weight directly like this. Would need to reopen modal.
        // For now, we don't allow modifying weight from cart, only removing.
        showToast('', 'Elimina y vuelve a pesar el producto', 'error');
        return;
    }

    const newQty = item.quantity + delta;
    
    if (newQty < 1) {
        removeFromCart(index);
        return;
    }
    
    if (newQty > item.stock && item.stock !== null && !item.sell_by_weight) {
        showToast('', `Stock insuficiente (Disponible: ${item.stock})`, 'error');
        return;
    }
    
    item.quantity = newQty;
    item.subtotal = item.quantity * item.unit_price;
    updateCartDisplay();
    // Re-focus barcode input after quantity change
    document.getElementById('barcodeInput').focus();
}

function removeFromCart(index) {
    const item = cart[index];
    cart.splice(index, 1);
    updateCartDisplay();
    showToast('', `${item.name} eliminado`, 'error');
    // Re-focus barcode input
    document.getElementById('barcodeInput').focus();
}

function clearCart() {
    if (cart.length === 0) return;
    
    if (confirm('¿Estás seguro de limpiar todo el carrito?')) {
        cart.length = 0;
        updateCartDisplay();
        document.getElementById('barcodeInput').focus();
    }
}

function updateCartDisplay() {
    const tableBody = document.getElementById('cartTableBody');
    const cartEmpty = document.getElementById('cartEmpty');
    const cartTable = document.getElementById('cartTable');
    const btnCharge = document.getElementById('btnCharge');
    const btnClear = document.getElementById('btnClearCart');
    
    if (cart.length === 0) {
        cartEmpty.style.display = 'flex';
        cartTable.style.display = 'none';
        currentTotal = 0;
    } else {
        cartEmpty.style.display = 'none';
        cartTable.style.display = 'table';
        
        currentTotal = 0;
        tableBody.innerHTML = '';
        
        cart.forEach((item, index) => {
            currentTotal += item.subtotal;
            
            const row = document.createElement('tr');
            row.className = 'cart-item-added';
            
            let qtyDisplay;
            if (item.sell_by_weight) {
                const isLb = item.weight_unit === 'lb';
                const formattedWeight = isLb ? 
                    `${(item.weight_grams / 500).toFixed(3)} lb` : 
                    `${(item.weight_grams / 1000).toFixed(3)} kg`;
                    
                qtyDisplay = `
                    <div class="cart-qty-controls" style="justify-content: center; background: none;">
                        <span class="cart-qty-value" style="font-size: 0.95rem;"> ${formattedWeight}</span>
                    </div>`;
            } else {
                qtyDisplay = `
                    <div class="cart-qty-controls">
                        <button class="cart-qty-btn minus" onclick="updateQuantity(${index}, -1)">−</button>
                        <span class="cart-qty-value">${item.quantity}</span>
                        <button class="cart-qty-btn" onclick="updateQuantity(${index}, 1)">+</button>
                    </div>`;
            }

            row.innerHTML = `
                <td>
                    <div class="cart-item-name">${item.name}</div>
                    ${item.barcode ? `<div class="cart-item-barcode">${item.barcode}</div>` : ''}
                </td>
                <td>
                    ${qtyDisplay}
                </td>
                <td style="text-align: right;">${formatCOP(item.unit_price)}</td>
                <td style="text-align: right;" class="cart-subtotal">${formatCOP(item.subtotal)}</td>
                <td>
                    <button class="cart-remove-btn" onclick="removeFromCart(${index})" title="Eliminar"></button>
                </td>
            `;
            tableBody.prepend(row);
        });
    }
    
    // Update totals
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    document.getElementById('cartItemsCount').textContent = `${totalItems} artículo${totalItems !== 1 ? 's' : ''} en el carrito`;
    document.getElementById('cartSubtotal').textContent = formatCOP(currentTotal);
    document.getElementById('cartTotal').textContent = formatCOP(currentTotal);
    
    // Update charge button
    btnCharge.textContent = `COBRAR ${formatCOP(currentTotal)}`;
    btnCharge.disabled = cart.length === 0;
    btnClear.disabled = cart.length === 0;
    // Save tabs to localStorage
    if (typeof saveTabs === 'function') {
        saveTabs();
        renderTabs();
    }
}

// ============================================================
// WEIGHT MODAL
// ============================================================
function openWeightModal(product) {
    currentWeightProduct = product;
    document.getElementById('weightProductName').textContent = product.name;
    document.getElementById('weightProductPrice').textContent = `${product.price_formatted} / ${product.weight_unit}`;
    
    
    // Reset manual input
    const input = document.getElementById('manualWeightInput');
    input.value = '';
    calculateWeightSubtotal(0);
    
    // Always show scale section
    const savedPort = localStorage.getItem('mercapp_hw_scale');
    const scaleSection = document.getElementById('scaleReadSection');
    scaleSection.style.display = 'block';
    document.getElementById('scaleStatus').textContent = '— g';
    document.getElementById('scaleStatus').style.color = 'var(--text-muted)';
    
    if (savedPort) {
        // Scale configured — auto-read
        document.getElementById('scaleStatusMsg').textContent = 'Báscula SAT CS30 conectada';
        document.getElementById('scaleStatusMsg').style.color = 'var(--text-muted)';
        document.getElementById('weightModal').classList.add('active');
        setTimeout(() => readScaleWeight(), 200);
    } else {
        // No scale configured — show section but with hint
        document.getElementById('scaleStatusMsg').textContent = 'Sin báscula configurada. Configúrala en Hardware o ingresa el peso manualmente.';
        document.getElementById('scaleStatusMsg').style.color = 'var(--text-muted)';
        document.getElementById('weightModal').classList.add('active');
        setTimeout(() => input.focus(), 100);
    }
}

function readScaleWeight() {
    let savedPort = localStorage.getItem('mercapp_hw_scale');
    
    if (!savedPort) {
        // Try auto-detect first
        const statusDiv = document.getElementById('scaleStatus');
        const statusMsg = document.getElementById('scaleStatusMsg');
        const btn = document.getElementById('btnReadScale');
        statusDiv.textContent = 'Buscando...';
        statusDiv.style.color = '#FFA726';
        statusMsg.textContent = 'Detectando báscula automáticamente...';
        statusMsg.style.color = '#FFA726';
        btn.disabled = true;
        
        fetch('/api/hardware/detect-scale')
        .then(r => r.json())
        .then(res => {
            if (res.success && res.port) {
                localStorage.setItem('mercapp_hw_scale', res.port);
                statusMsg.textContent = `Báscula detectada en ${res.port}. Leyendo peso...`;
                statusMsg.style.color = 'var(--success)';
                // Now read with the detected port
                readScaleWeight();
            } else {
                statusDiv.textContent = 'No encontrada';
                statusDiv.style.color = 'var(--error)';
                statusMsg.textContent = 'No se detectó ninguna báscula. Ingresa el peso manualmente.';
                statusMsg.style.color = 'var(--error)';
                btn.disabled = false;
                document.getElementById('manualWeightInput').focus();
            }
        })
        .catch(() => {
            statusDiv.textContent = 'Error';
            statusDiv.style.color = 'var(--error)';
            statusMsg.textContent = 'Error buscando báscula. Ingresa el peso manualmente.';
            statusMsg.style.color = 'var(--error)';
            btn.disabled = false;
        });
        return;
    }
    
    const statusDiv = document.getElementById('scaleStatus');
    const statusMsg = document.getElementById('scaleStatusMsg');
    const btn = document.getElementById('btnReadScale');
    
    // Show reading state
    statusDiv.textContent = 'Leyendo...';
    statusDiv.style.color = '#FFA726';
    statusDiv.style.borderColor = '#FFA726';
    statusMsg.textContent = 'Esperando lectura de la báscula...';
    statusMsg.style.color = '#FFA726';
    btn.disabled = true;
    
    fetch('/api/hardware/weight?port=' + encodeURIComponent(savedPort))
    .then(r => r.json())
    .then(res => {
        if (res.success && res.weight_grams >= 0) {
            const grams = res.weight_grams;
            
            // Anti-absurd validation: reject readings > 50kg
            if (grams > 50000) {
                statusDiv.textContent = grams + ' g (!)';
                statusDiv.style.color = 'var(--error)';
                statusDiv.style.borderColor = 'var(--error)';
                statusMsg.textContent = '⚠️ Lectura absurda (' + grams + 'g). Vuelve a pesar.';
                statusMsg.style.color = 'var(--error)';
                return;
            }
            
            statusDiv.textContent = grams + ' g';
            statusDiv.style.color = 'var(--success)';
            statusDiv.style.borderColor = 'var(--success)';
            statusMsg.textContent = '✓ Peso leído correctamente';
            statusMsg.style.color = 'var(--success)';
            
            // Auto-fill manual input and calculate subtotal
            document.getElementById('manualWeightInput').value = grams;
            calculateWeightSubtotal(grams);
            
            // Only auto-confirm if scale mode is 'auto'
            if (scaleMode === 'auto') {
                setTimeout(() => confirmWeight(), 500);
            }
        } else {
            statusDiv.textContent = 'Error';
            statusDiv.style.color = 'var(--error)';
            statusDiv.style.borderColor = 'var(--error)';
            statusMsg.textContent = res.message || 'No se pudo leer. Ingresa el peso manualmente.';
            statusMsg.style.color = 'var(--error)';
            document.getElementById('manualWeightInput').focus();
        }
    })
    .catch(err => {
        statusDiv.textContent = 'Error';
        statusDiv.style.color = 'var(--error)';
        statusDiv.style.borderColor = 'var(--error)';
        statusMsg.textContent = 'Error de conexión con la báscula. Ingresa manualmente.';
        statusMsg.style.color = 'var(--error)';
        document.getElementById('manualWeightInput').focus();
    })
    .finally(() => {
        btn.disabled = false;
    });
}

function closeWeightModal() {
    document.getElementById('weightModal').classList.remove('active');
    currentWeightProduct = null;
    document.getElementById('barcodeInput').focus();
}

function setManualWeight(grams) {
    document.getElementById('manualWeightInput').value = grams;
    calculateWeightSubtotal(grams);
}

function calculateWeightSubtotal(grams) {
    const btn = document.getElementById('btnConfirmWeight');
    const subtotalDiv = document.getElementById('weightSubtotal');
    
    if (grams < 10) {
        subtotalDiv.textContent = '$0';
        subtotalDiv.style.color = 'var(--text-muted)';
        btn.disabled = true;
        return;
    }
    
    let calculatedRaw = 0;
    if (currentWeightProduct.weight_unit === 'lb') {
        calculatedRaw = currentWeightProduct.price * (grams / 500.0);
    } else {
        calculatedRaw = currentWeightProduct.price * (grams / 1000.0);
    }
    
    // Round to nearest 50
    const subtotal = Math.round(calculatedRaw / 50.0) * 50;
    
    subtotalDiv.textContent = formatCOP(subtotal);
    subtotalDiv.style.color = 'var(--success)';
    btn.disabled = false;
    
    // Store temporarily in input via dataset
    document.getElementById('manualWeightInput').dataset.subtotal = subtotal;
}

function confirmWeight() {
    if (!currentWeightProduct) return;
    
    const gramsStr = document.getElementById('manualWeightInput').value;
    const grams = parseInt(gramsStr) || 0;
    
    if (grams < 10) {
        showToast('', 'El peso debe ser al menos 10g', 'error');
        return;
    }
    
    if (grams > 50000) {
        showToast('', 'El peso excede el límite de 50kg', 'error');
        return;
    }
    
    const subtotal = parseInt(document.getElementById('manualWeightInput').dataset.subtotal) || 0;
    
    const existingIndex = cart.findIndex(item => item.product_id === currentWeightProduct.id);
    
    if (existingIndex !== -1) {
        const existing = cart[existingIndex];
        existing.weight_grams += grams;
        
        let calculatedRaw = 0;
        if (existing.weight_unit === 'lb') {
            calculatedRaw = existing.unit_price * (existing.weight_grams / 500.0);
        } else {
            calculatedRaw = existing.unit_price * (existing.weight_grams / 1000.0);
        }
        existing.subtotal = Math.round(calculatedRaw / 50.0) * 50;
        
        // Mover al final del array para que aparezca primero en la tabla (por el prepend)
        cart.splice(existingIndex, 1);
        cart.push(existing);
    } else {
        cart.push({
            product_id: currentWeightProduct.id,
            name: currentWeightProduct.name,
            barcode: currentWeightProduct.barcode || '',
            unit_price: currentWeightProduct.price,
            quantity: 1,
            subtotal: subtotal,
            stock: currentWeightProduct.stock,
            image: currentWeightProduct.image,
            sell_by_weight: true,
            weight_grams: grams,
            weight_unit: currentWeightProduct.weight_unit
        });
    }
    
    updateCartDisplay();
    showToast('', `${currentWeightProduct.name} agregado (${grams}g)`, 'success');
    closeWeightModal();
}

// ============================================================
// PAYMENT MODAL
// ============================================================
function openPaymentModal() {
    if (cart.length === 0) return;
    
    // Voice announcement of total (Synchronous to prevent browser blocking)
    announceTotal(currentTotal);
    
    const totalFormatted = formatCOP(currentTotal);
    document.getElementById('payTotalEfectivo').textContent = totalFormatted;
    document.getElementById('payTotalTarjeta').textContent = totalFormatted;
    document.getElementById('payTotalTransferencia').textContent = totalFormatted;
    if(document.getElementById('payTotalMixto')) { document.getElementById('payTotalMixto').textContent = totalFormatted; }
    
    // Reset fields
    document.getElementById('amountReceived').value = '';
    document.getElementById('changeDisplay').style.display = 'none';
    document.getElementById('btnPayEfectivo').disabled = true;
    if(document.getElementById('cardLast4')) { document.getElementById('cardLast4').value = ''; }
    if(document.getElementById('cardApproval')) { document.getElementById('cardApproval').value = ''; }
    document.getElementById('transferBank').value = '';
    if(document.getElementById('transferRef')) { document.getElementById('transferRef').value = ''; }
    if(document.getElementById('transferName')) { document.getElementById('transferName').value = ''; }
    
    // Reset mixto fields
    if(document.getElementById('mixtoEfectivoRecibido')) { document.getElementById('mixtoEfectivoRecibido').value = ''; }
    if(document.getElementById('mixtoTransferencia')) { document.getElementById('mixtoTransferencia').value = ''; }
    if(document.getElementById('mixtoChangeContainer')) { document.getElementById('mixtoChangeContainer').style.display = 'none'; }
    if(document.getElementById('btnPayMixto')) { document.getElementById('btnPayMixto').disabled = true; }
    if(document.getElementById('mixtoAssigned')) { document.getElementById('mixtoAssigned').textContent = '$0'; }
    if(document.getElementById('mixtoStatusLabel')) { document.getElementById('mixtoStatusLabel').textContent = 'FALTANTE:'; }
    if(document.getElementById('mixtoStatusValue')) { document.getElementById('mixtoStatusValue').textContent = totalFormatted; }
    if(document.getElementById('mixtoDisplay')) { document.getElementById('mixtoDisplay').className = 'change-display invalid'; }
    
    // Show modal
    document.getElementById('paymentModal').classList.add('active');
    
    // Default to exact amount
    setTimeout(() => {
        if (typeof setExactAmount === 'function') {
            setExactAmount();
        }
    }, 50);
    
    // Switch to cash tab by default
    switchPaymentTab('efectivo');
}

function closePaymentModal() {
    document.getElementById('paymentModal').classList.remove('active');
    document.getElementById('barcodeInput').focus();
}

function switchPaymentTab(tab) {
    // Update tabs
    document.querySelectorAll('.payment-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.payment-content').forEach(c => c.classList.remove('active'));
    
    document.getElementById(`tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');
    document.getElementById(`content${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');
    
    // Focus first input
    if (tab === 'efectivo') {
        setTimeout(() => document.getElementById('amountReceived').focus(), 100);
    } else if (tab === 'tarjeta') {
        setTimeout(() => { let el = document.getElementById('cardLast4'); if(el) el.focus(); }, 100);
    } else if (tab === 'transferencia') {
        setTimeout(() => document.getElementById('transferBank').focus(), 100);
    } else if (tab === 'mixto') {
        setTimeout(() => { let el = document.getElementById('mixtoEfectivoRecibido'); if(el) el.focus(); }, 100);
    }
}

// ============================================================
// CASH PAYMENT HELPERS
// ============================================================
function addDenomination(amount) {
    const input = document.getElementById('amountReceived');
    const current = parseInt(input.value) || 0;
    input.value = current + amount;
    calculateChange();
}

function setExactAmount() {
    document.getElementById('amountReceived').value = currentTotal;
    calculateChange();
}

function clearAmount() {
    document.getElementById('amountReceived').value = '';
    document.getElementById('changeDisplay').style.display = 'none';
    document.getElementById('btnPayEfectivo').disabled = true;
}

function calculateChange() {
    const amountStr = document.getElementById('amountReceived').value;
    const amount = parseInt(amountStr) || 0;
    const changeDiv = document.getElementById('changeDisplay');
    const changeValue = document.getElementById('changeValue');
    const btnPay = document.getElementById('btnPayEfectivo');
    
    if (!amountStr || amount === 0) {
        changeDiv.style.display = 'none';
        btnPay.disabled = true;
        return;
    }
    
    const change = amount - currentTotal;
    changeDiv.style.display = 'block';
    
    if (change >= 0) {
        changeDiv.className = 'change-display valid';
        changeValue.textContent = formatCOP(change);
        btnPay.disabled = false;
    } else {
        changeDiv.className = 'change-display invalid';
        changeValue.textContent = `Faltan ${formatCOP(Math.abs(change))}`;
        btnPay.disabled = true;
    }
}

// ============================================================
// MIXTO (SPLIT) PAYMENT HELPERS
// ============================================================
function calculateMixto() {
    const transVal = parseInt(document.getElementById('mixtoTransferencia').value) || 0;
    const cashReceived = parseInt(document.getElementById('mixtoEfectivoRecibido').value) || 0;

    // Cash needed is whatever transfer doesn't cover
    const cashNeeded = Math.max(0, currentTotal - transVal);
    const valTransfer = Math.min(transVal, currentTotal);
    const valCash = currentTotal - valTransfer;

    const totalAssigned = valTransfer + valCash;

    // Update total assigned
    if (document.getElementById('mixtoAssigned')) {
        document.getElementById('mixtoAssigned').textContent = formatCOP(totalAssigned);
    }

    const displayDiv = document.getElementById('mixtoDisplay');
    const statusLabel = document.getElementById('mixtoStatusLabel');
    const statusValue = document.getElementById('mixtoStatusValue');
    const changeContainer = document.getElementById('mixtoChangeContainer');
    const changeValue = document.getElementById('mixtoChangeValue');
    const btnPay = document.getElementById('btnPayMixto');

    if (transVal > currentTotal) {
        if (displayDiv) displayDiv.className = 'change-display invalid';
        if (statusLabel) statusLabel.textContent = 'EXCESO TRANSFERENCIA:';
        if (statusValue) statusValue.textContent = formatCOP(transVal - currentTotal);
        if (changeContainer) changeContainer.style.display = 'none';
        if (btnPay) btnPay.disabled = true;
        return;
    }

    if (cashReceived >= cashNeeded) {
        if (displayDiv) displayDiv.className = 'change-display valid';
        if (statusLabel) statusLabel.textContent = 'PAGO COMPLETO';
        if (statusValue) statusValue.textContent = '✓';
        if (btnPay) btnPay.disabled = false;

        const change = cashReceived - cashNeeded;
        if (change > 0) {
            if (changeContainer) changeContainer.style.display = 'flex';
            if (changeValue) changeValue.textContent = formatCOP(change);
        } else {
            if (changeContainer) changeContainer.style.display = 'none';
        }
    } else {
        if (displayDiv) displayDiv.className = 'change-display invalid';
        if (statusLabel) statusLabel.textContent = 'EFECTIVO FALTANTE:';
        if (statusValue) statusValue.textContent = formatCOP(cashNeeded - cashReceived);
        if (changeContainer) changeContainer.style.display = 'none';
        if (btnPay) btnPay.disabled = true;
    }
}

function fillMixtoField(field) {
    if (field === 'efectivo') {
        const transVal = parseInt(document.getElementById('mixtoTransferencia').value) || 0;
        const needed = Math.max(0, currentTotal - transVal);
        const input = document.getElementById('mixtoEfectivoRecibido');
        if (input) input.value = needed;
    } else if (field === 'transferencia') {
        const cashReceived = parseInt(document.getElementById('mixtoEfectivoRecibido').value) || 0;
        const needed = Math.max(0, currentTotal - cashReceived);
        const input = document.getElementById('mixtoTransferencia');
        if (input) input.value = needed;
    }
    calculateMixto();
}

// ============================================================
// PROCESS SALE
// ============================================================
function processSale(method) {
    // Hardware Drawer Kick
    if (method === 'efectivo') {
        let hwPrinter = localStorage.getItem('mercapp_hw_printer');
        if (hwPrinter) {
            fetch('/api/hardware/open-drawer', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').getAttribute('content')},
                body: JSON.stringify({printer_name: hwPrinter})
            }).catch(e=>{});
        }
    }

    if (cart.length === 0) return;
    
    const payload = {
        items: cart.map(item => {
            if (item.is_custom) {
                return {
                    is_custom: true,
                    custom_name: item.name,
                    custom_price: item.unit_price,
                    quantity: item.quantity
                };
            }
            const data = {
                product_id: item.product_id,
                quantity: item.quantity
            };
            if (item.sell_by_weight) {
                data.weight_grams = item.weight_grams;
            }
            return data;
        }),
        payment: { method: method }
    };
    
    // Validate and add payment data
    if (method === 'efectivo') {
        const amount = document.getElementById('amountReceived').value;
        if (!amount || parseInt(amount) < currentTotal) {
            showToast('', 'El monto recibido es insuficiente', 'error');
            return;
        }
        payload.payment.amount_received = amount;
    } else if (method === 'tarjeta') {
        // No mandatory fields for tarjeta anymore
        payload.payment.card_last4 = '';
        payload.payment.card_approval = '';
    } else if (method === 'transferencia') {
        const bank = document.getElementById('transferBank').value;
        payload.payment.transfer_bank = bank || '';
        payload.payment.transfer_ref = '';
        payload.payment.transfer_name = '';
    } else if (method === 'mixto') {
        const transVal = parseInt(document.getElementById('mixtoTransferencia').value) || 0;
        const cashReceived = parseInt(document.getElementById('mixtoEfectivoRecibido').value) || 0;
        const bank = document.getElementById('mixtoTransferBank').value;

        const valTransfer = Math.min(transVal, currentTotal);
        const valCash = currentTotal - valTransfer;

        payload.payment.amount_transfer = valTransfer;
        payload.payment.amount_received = cashReceived;
        payload.payment.amount_cash = valCash;
        payload.payment.amount_card = 0;
        payload.payment.transfer_bank = bank || '';
    }
    
    // Disable all pay buttons
    document.querySelectorAll('[id^="btnPay"]').forEach(btn => btn.disabled = true);
    
    const saleOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': CSRF_TOKEN
        },
        body: JSON.stringify(payload)
    };
    
    // Helper: attempt sale with auto-retry on connection failure
    function attemptSale(retriesLeft) {
        fetch('/api/sale', saleOptions)
        .then(res => {
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                // Server returned HTML (CSRF error, session expired, etc.)
                throw new Error('SESSION_EXPIRED');
            }
            return res.json();
        })
        .then(data => {
            if (data.success) {
                lastSaleId = data.sale.id;
                lastReceiptNumber = data.sale.receipt_number;
                
                // Close payment modal
                closePaymentModal();
                
                // Show success modal
                document.getElementById('successReceipt').textContent = `Factura: ${data.sale.receipt_number}`;
                
                if (data.sale.change > 0) {
                    document.getElementById('successChangeContainer').style.display = 'block';
                    document.getElementById('successChangeValue').textContent = data.sale.change_formatted;
                } else {
                    document.getElementById('successChangeContainer').style.display = 'none';
                }
                
                document.getElementById('successModal').classList.add('active');
                
                // Auto-print: Check ONLY the checkbox corresponding to the active payment method tab
                let wantsPrint = false;
                if (method === 'efectivo') {
                    wantsPrint = document.getElementById('chkPrintReceipt').checked;
                } else if (method === 'tarjeta') {
                    wantsPrint = document.querySelector('#contentTarjeta .chk-print-mirror').checked;
                } else if (method === 'transferencia') {
                    wantsPrint = document.querySelector('#contentTransferencia .chk-print-mirror').checked;
                } else if (method === 'mixto') {
                    wantsPrint = document.querySelector('#contentMixto .chk-print-mirror').checked;
                }

                if (wantsPrint && lastSaleId) {
                    let hwPrinter = localStorage.getItem('mercapp_hw_printer');
                    if (hwPrinter) {
                        // Raw hardware printing (fast)
                        fetch('/api/hardware/print', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json', 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').getAttribute('content')},
                            body: JSON.stringify({printer_name: hwPrinter, sale_id: lastSaleId})
                        });
                    } else {
                        // Browser html print
                        window.open(`/sales/${lastSaleId}/receipt`, '_blank');
                    }
                }
                document.querySelectorAll('[id^="btnPay"]').forEach(btn => btn.disabled = false);
            } else {
                showToast('', data.message || 'Error procesando la venta', 'error');
                document.querySelectorAll('[id^="btnPay"]').forEach(btn => btn.disabled = false);
            }
        })
        .catch((err) => {
            if (err && err.message === 'SESSION_EXPIRED') {
                showToast('', 'Sesión expirada. Recargando...', 'error');
                setTimeout(() => window.location.reload(), 1500);
                return;
            }
            if (retriesLeft > 0) {
                showToast('', 'Reintentando conexión...', 'warning');
                setTimeout(() => attemptSale(retriesLeft - 1), 1000);
            } else {
                showToast('', 'Error de conexión con el servidor. Intenta de nuevo.', 'error');
                document.querySelectorAll('[id^="btnPay"]').forEach(btn => btn.disabled = false);
            }
        });
    }
    
    attemptSale(1); // 1 retry
}

// ============================================================
// PROCESS CREDIT SALE (FIADO)
// ============================================================
function processCreditSale(clientId) {
    if (cart.length === 0) return;
    
    document.querySelectorAll('.btn-accent').forEach(btn => btn.disabled = true);
    
    const payload = {
        client_id: clientId,
        items: cart.map(item => {
            if (item.is_custom) {
                return {
                    is_custom: true,
                    custom_name: item.name,
                    custom_price: item.unit_price,
                    quantity: item.quantity
                };
            }
            const data = {
                product_id: item.product_id,
                quantity: item.quantity
            };
            if (item.sell_by_weight) {
                data.weight_grams = item.weight_grams;
            }
            return data;
        })
    };
    
    fetch('/api/credit-sale', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': CSRF_TOKEN
        },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            lastSaleId = data.sale.id;
            lastReceiptNumber = data.sale.receipt_number;
            
            if (document.getElementById('paymentModal').classList.contains('active')) {
                closePaymentModal();
            }
            
            document.getElementById('successReceipt').textContent = `Factura (Fiado): ${data.sale.receipt_number}`;
            document.getElementById('successChangeContainer').style.display = 'none';
            document.getElementById('successModal').classList.add('active');
        } else {
            showToast('', data.message || 'Error procesando la venta fiada', 'error');
        }
    })
    .catch(() => {
        showToast('', 'Error de conexión con el servidor', 'error');
    })
    .finally(() => {
        document.querySelectorAll('.btn-accent').forEach(btn => btn.disabled = false);
    });
}

// ============================================================
// POST-SALE ACTIONS
// ============================================================
function printReceipt() {
    if (lastSaleId) {
        let hwPrinter = localStorage.getItem('mercapp_hw_printer');
        if (hwPrinter) {
            fetch('/api/hardware/print', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'X-CSRFToken': CSRF_TOKEN},
                body: JSON.stringify({printer_name: hwPrinter, sale_id: lastSaleId})
            });
        } else {
            window.open(`/sales/${lastSaleId}/receipt`, '_blank');
        }
    }
}

function newSale() {
    document.getElementById('successModal').classList.remove('active');
    lastSaleId = null;
    lastReceiptNumber = null;
    
    // Si la venta se realiza, la pestaña desaparece y pasa a otra o crea una nueva
    if (typeof closeTab === 'function') {
        closeTab(activeTabId);
    } else {
        cart.length = 0;
        currentTotal = 0;
        updateCartDisplay();
    }
    
    document.getElementById('barcodeInput').focus();
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(icon, message, type) {
    const toast = document.getElementById('posToast');
    
    // Auto-generate beautiful SVG icons based on notification type
    let svgIcon = '';
    if (type === 'success') {
        svgIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    } else if (type === 'error') {
        svgIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--error)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    } else {
        svgIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    }

    document.getElementById('toastIcon').innerHTML = svgIcon;
    document.getElementById('toastMessage').textContent = message;
    
    toast.className = `pos-toast ${type}`;
    
    // Show
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Hide after 2.5 seconds
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
document.addEventListener('keydown', (e) => {
    
    // Escape: Close modals
    if (e.key === 'Escape') {
        const weightModal = document.getElementById('weightModal');
        if (weightModal && weightModal.classList.contains('active')) {
            closeWeightModal();
            return;
        }
        
        closePaymentModal();
        if (document.getElementById('successModal').classList.contains('active')) {
            newSale();
        }
    }
});

// ==========================================
// HARDWARE INTEGRATION
// ==========================================
function openHardwareModal() {
    document.getElementById('hardwareModal').style.display = 'flex';
    // Load Printers
    fetch('/api/hardware/printers').then(r=>r.json()).then(res => {
        let sel = document.getElementById('hwPrinterSelect');
        sel.innerHTML = '<option value="">(Imprimir por navegador)</option>';
        if(res.success && res.printers) {
            res.printers.forEach(p => {
                sel.innerHTML += `<option value="${p}">${p}</option>`;
            });
            let savedPrinter = localStorage.getItem('mercapp_hw_printer');
            if(savedPrinter) sel.value = savedPrinter;
        }
    }).catch(e => console.error(e));

    // Load Ports
    fetch('/api/hardware/ports').then(r=>r.json()).then(res => {
        let sel = document.getElementById('hwScaleSelect');
        sel.innerHTML = '<option value="">(Ingresar peso manual)</option>';
        if(res.success && res.ports) {
            res.ports.forEach(p => {
                const desc = p.description ? ` (${p.description})` : '';
                sel.innerHTML += `<option value="${p.device}">${p.device}${desc}</option>`;
            });
            let savedPort = localStorage.getItem('mercapp_hw_scale');
            if(savedPort) sel.value = savedPort;
        }
    }).catch(e => console.error(e));
}

function closeHardwareModal() { document.getElementById('hardwareModal').style.display = 'none'; }

function saveHardwareAndClose() {
    let printer = document.getElementById('hwPrinterSelect').value;
    let scale = document.getElementById('hwScaleSelect').value;
    localStorage.setItem('mercapp_hw_printer', printer);
    localStorage.setItem('mercapp_hw_scale', scale);
    closeHardwareModal();
}

function testDrawer() {
    let printer = document.getElementById('hwPrinterSelect').value;
    if(!printer) return alert('Selecciona una impresora primero.');
    fetch('/api/hardware/open-drawer', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').getAttribute('content')},
        body: JSON.stringify({printer_name: printer})
    }).then(r=>r.json()).then(res => {
        if(res.success) alert('Señal enviada al cajón.');
        else alert('Error: ' + res.message);
    });
}

function testScale() {
    let port = document.getElementById('hwScaleSelect').value;
    if(!port) return alert('Selecciona un puerto COM primero.');
    let resDiv = document.getElementById('testScaleResult');
    resDiv.innerText = 'Leyendo...';
    resDiv.style.color = '#FFA726';
    fetch('/api/hardware/weight?port=' + port)
    .then(r=>r.json()).then(res => {
        if(res.success) {
            resDiv.innerText = res.weight_grams + ' g';
            resDiv.style.color = '#2E7D32';
        } else {
            resDiv.innerText = 'Error';
            resDiv.style.color = 'var(--error)';
            alert('Error leyendo balanza: ' + res.message);
        }
    }).catch(e => {
        resDiv.innerText = 'Timeout';
        resDiv.style.color = 'var(--error)';
    });
}

function autoDetectScale(isSilent = false) {
    if (!isSilent) showToast('Hardware', 'Buscando báscula...', 'info');
    
    fetch('/api/hardware/detect-scale')
    .then(r => r.json())
    .then(res => {
        if (res.success && res.port) {
            localStorage.setItem('mercapp_hw_scale', res.port);
            // If we are in the modal, update the select
            const sel = document.getElementById('hwScaleSelect');
            if (sel) sel.value = res.port;
            
            showToast('Báscula Detectada', `Conectada en ${res.port}${res.description ? ' ('+res.description+')' : ''}`, 'success');
        } else {
            if (!isSilent) showToast('Hardware', 'No se encontró ninguna báscula activa.', 'warning');
        }
    })
    .catch(err => {
        if (!isSilent) console.error('Error en auto-detección:', err);
    });
}

// ============================================================
// CART AND TABS PERSISTENCE (Load from LocalStorage)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
});

// ============================================================
// WEIGHT MODAL ENTER KEY
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const weightInput = document.getElementById('manualWeightInput');
    if(weightInput) {
        weightInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmWeight();
            }
        });
    }

    // Enter key to confirm cash payment
    const amountInput = document.getElementById('amountReceived');
    if(amountInput) {
        amountInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const btnPay = document.getElementById('btnPayEfectivo');
                if (btnPay && !btnPay.disabled) {
                    processSale('efectivo');
                }
            }
        });
    }

    // Enter key to confirm mixto payment
    const mixtoCashInput = document.getElementById('mixtoEfectivoRecibido');
    if(mixtoCashInput) {
        mixtoCashInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const btnPay = document.getElementById('btnPayMixto');
                if (btnPay && !btnPay.disabled) {
                    processSale('mixto');
                }
            }
        });
    }

    const mixtoTransInput = document.getElementById('mixtoTransferencia');
    if(mixtoTransInput) {
        mixtoTransInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const btnPay = document.getElementById('btnPayMixto');
                if (btnPay && !btnPay.disabled) {
                    processSale('mixto');
                }
            }
        });
    }
});

// ============================================================
// OPEN CASH DRAWER (Emergency button)
// ============================================================
function openCashDrawer() {
    let hwPrinter = localStorage.getItem('mercapp_hw_printer');
    if (!hwPrinter) {
        showToast('', 'Configura una impresora en Hardware primero', 'error');
        return;
    }
    fetch('/api/hardware/open-drawer', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRFToken': CSRF_TOKEN},
        body: JSON.stringify({printer_name: hwPrinter})
    }).then(r => r.json()).then(res => {
        if (res.success) {
            showToast('', 'Cajón abierto', 'success');
        } else {
            showToast('', 'Error: ' + (res.message || 'No se pudo abrir'), 'error');
        }
    }).catch(() => {
        showToast('', 'Error de conexión', 'error');
    });
    // Re-focus barcode input
    document.getElementById('barcodeInput').focus();
}

// ============================================================
// PERSISTENT AUTO-FOCUS: Keep barcode input focused
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const barcodeInput = document.getElementById('barcodeInput');
    if (!barcodeInput) return;

    // Re-focus when clicking anywhere on the page (except modals/inputs/buttons)
    document.addEventListener('click', (e) => {
        // Don't refocus if a modal is open
        const anyModalOpen = document.querySelector('.modal-overlay.active') ||
                             document.querySelector('.modal-overlay[style*="flex"]');
        if (anyModalOpen) return;

        // Don't steal focus from other inputs or buttons
        if (e.target.closest('input') || e.target.closest('button') || e.target.closest('select') || e.target.closest('textarea') || e.target.closest('a')) return;

        setTimeout(() => barcodeInput.focus(), 50);
    });

    // After any modal closes, refocus (checked periodically)
    let lastModalState = false;
    setInterval(() => {
        const anyModalOpen = document.querySelector('.modal-overlay.active') ||
                             document.querySelector('.modal-overlay[style*="flex"]');
        const isOpen = !!anyModalOpen;
        
        // Modal just closed
        if (lastModalState && !isOpen) {
            setTimeout(() => barcodeInput.focus(), 100);
        }
        lastModalState = isOpen;
    }, 300);
});

// ============================================================
// HARDWARE PRINT HELPER (for use from other pages)
// ============================================================
function hardwarePrintSale(saleId) {
    let hwPrinter = localStorage.getItem('mercapp_hw_printer');
    if (hwPrinter) {
        fetch('/api/hardware/print', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').getAttribute('content')},
            body: JSON.stringify({printer_name: hwPrinter, sale_id: saleId})
        }).then(r => r.json()).then(res => {
            if (res.success) {
                alert('Factura enviada a la impresora.');
            } else {
                alert('Error al imprimir: ' + (res.message || 'Desconocido'));
            }
        }).catch(() => {
            alert('Error de conexión al imprimir.');
        });
    } else {
        window.open('/sales/' + saleId + '/receipt', '_blank');
    }
}

// ============================================================
// CUSTOM PRODUCT (VARIOS) — Quick add without barcode
// ============================================================
let customProductCounter = 0;

function openCustomProductModal() {
    document.getElementById('customProductName').value = 'Varios';
    document.getElementById('customProductPrice').value = '';
    document.getElementById('customProductModal').classList.add('active');
    setTimeout(() => document.getElementById('customProductPrice').focus(), 100);
}

function closeCustomProductModal() {
    document.getElementById('customProductModal').classList.remove('active');
    document.getElementById('barcodeInput').focus();
}

function confirmCustomProduct() {
    const nameInput = document.getElementById('customProductName');
    const priceInput = document.getElementById('customProductPrice');
    
    const name = nameInput.value.trim() || 'Varios';
    const price = parseInt(priceInput.value);
    
    if (!price || price <= 0) {
        showToast('', 'Ingresa un precio válido', 'error');
        priceInput.focus();
        return;
    }
    
    customProductCounter++;
    
    cart.push({
        product_id: null,
        name: name === 'Varios' ? 'Varios' : `Varios - ${name}`,
        barcode: '',
        unit_price: price,
        quantity: 1,
        subtotal: price,
        stock: null,
        image: null,
        sell_by_weight: false,
        is_custom: true
    });
    
    updateCartDisplay();
    closeCustomProductModal();
    showToast('', `${name} ($${price.toLocaleString('es-CO')}) agregado`, 'success');
}

// Allow Enter key to confirm custom product
document.addEventListener('DOMContentLoaded', () => {
    const priceInput = document.getElementById('customProductPrice');
    if (priceInput) {
        priceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmCustomProduct();
            }
        });
    }
});

// ============================================================
// PRODUCT NOT FOUND — Blocking Alert Modal
// ============================================================
let lastNotFoundBarcode = '';

function showNotFoundModal(barcode) {
    lastNotFoundBarcode = barcode;
    document.getElementById('notFoundBarcode').textContent = barcode;
    document.getElementById('productNotFoundModal').classList.add('active');
    // Block the barcode input
    const input = document.getElementById('barcodeInput');
    if (input) {
        input.disabled = true;
        input.style.opacity = '0.4';
    }
}

function closeNotFoundModal() {
    document.getElementById('productNotFoundModal').classList.remove('active');
    // Unblock the barcode input and refocus
    const input = document.getElementById('barcodeInput');
    if (input) {
        input.disabled = false;
        input.style.opacity = '1';
        input.value = '';
        input.focus();
    }
}

function notFoundAddAsVarios() {
    closeNotFoundModal();
    openCustomProductModal();
}

function notFoundAddToInventory() {
    const barcode = lastNotFoundBarcode;
    closeNotFoundModal();
    // Redirect to product add page with barcode as query parameter
    window.location.href = '/products/add?barcode=' + encodeURIComponent(barcode);
}

// ============================================================
// KEYBOARD SHORTCUTS — F1-F4 for fast checkout
// ============================================================
document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts if a modal is open (except payment modal for F-key confirm)
    const paymentModal = document.getElementById('paymentModal');
    const customModal = document.getElementById('customProductModal');
    const successModal = document.getElementById('successModal');
    const notFoundModal = document.getElementById('productNotFoundModal');
    
    // Product Not Found modal — only Escape closes it
    if (notFoundModal && notFoundModal.classList.contains('active')) {
        if (e.key === 'Escape') { e.preventDefault(); closeNotFoundModal(); }
        return; // Block ALL other shortcuts
    }
    
    // F4 or Numpad "+" = + Varios (Open or Confirm)
    if (e.key === 'F4' || e.key === '+') {
        e.preventDefault();
        if (customModal && customModal.classList.contains('active')) {
            confirmCustomProduct();
        } else {
            openCustomProductModal();
        }
        return;
    }
    
    if (customModal && customModal.classList.contains('active')) return;
    if (successModal && successModal.classList.contains('active')) {
        if (e.key === 'Escape') { e.preventDefault(); newSale(); return; }
        return;
    }
});

// ============================================================
// PRINTER CONFIG SYNC — Load from DB on startup, save to both
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // On startup, check if DB has a saved printer and sync to localStorage
    fetch('/api/settings/printer')
        .then(r => r.json())
        .then(data => {
            if (data.success && data.printer_name) {
                // DB has a printer saved — sync to localStorage
                localStorage.setItem('mercapp_hw_printer', data.printer_name);
            } else if (!data.printer_name) {
                // DB empty but localStorage might have one — sync TO db
                const localPrinter = localStorage.getItem('mercapp_hw_printer');
                if (localPrinter) {
                    fetch('/api/settings/printer', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json', 'X-CSRFToken': CSRF_TOKEN},
                        body: JSON.stringify({printer_name: localPrinter})
                    }).catch(() => {});
                }
            }
        })
        .catch(() => {});
});
