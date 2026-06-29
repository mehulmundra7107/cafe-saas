// Removed global keys to enforce table scoping
const TABLE_SESSION_ID_KEY = "cafe_table_session_id";
const TABLE_TOKEN_KEY = "cafe_table_token";
const TABLE_ID_KEY = "cafe_table_id";
const TABLE_LABEL_KEY = "cafe_table_label";

// This café's slug, used to scope every API call to the correct
// tenant in the database. When this project grows to serve multiple
// cafés from one deployment, this becomes dynamic (e.g. read from a
// subdomain or URL path) instead of a fixed constant.
// Reads the café slug from the URL path, e.g. /c/blue-tokai-nashik/menu
// → "blue-tokai-nashik". Falls back to a default only for direct local
// testing without the /c/:slug prefix — this fallback should not be
// relied on in production, where every real link includes it.
function getCafeSlugFromUrl() {
  const match = window.location.pathname.match(/^\/c\/([^/]+)/);
  if (match) return match[1];
  console.warn("No cafeSlug found in URL path — falling back to default. This should not happen in production.");
  return "cafe-crafted";
}

const CAFE_SLUG = getCafeSlugFromUrl();

function withCafeSlug(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cafeSlug=${encodeURIComponent(CAFE_SLUG)}`;
}

async function ensureTableSession() {
  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get("t");
  const existingSessionId = sessionStorage.getItem(TABLE_SESSION_ID_KEY);

  const tokenToUse = tokenFromUrl || sessionStorage.getItem(TABLE_TOKEN_KEY);

  if (!tokenToUse) {
    showTableError("Please scan the QR code on your table to get started.");
    return false;
  }

  try {
    const url = withCafeSlug(`/api/table/verify?t=${encodeURIComponent(tokenToUse)}` +
      (existingSessionId ? `&sid=${encodeURIComponent(existingSessionId)}` : ""));
    const res = await fetch(url);
    const data = await res.json();

    if (!data.valid) {
      if (res.status === 409 && data.occupied) {
        showTableError(data.reason);
      } else {
        showTableError(data.reason || "This QR code is not valid.");
      }
      return false;
    }

    sessionStorage.setItem(TABLE_TOKEN_KEY, tokenToUse);
    sessionStorage.setItem(TABLE_ID_KEY, data.tableId);
    sessionStorage.setItem(TABLE_LABEL_KEY, data.label);
    sessionStorage.setItem(TABLE_SESSION_ID_KEY, data.sessionId);
    return true;
  } catch (err) {
    showTableError("Could not verify your table. Please check your connection and rescan the QR code.");
    return false;
  }
}

async function initCustomerApp(callback) {
  const ok = await ensureTableSession();
  if (ok && callback) {
    callback();
  }
}

function getTableSessionId() {
  return sessionStorage.getItem(TABLE_SESSION_ID_KEY) || null;
}

function getTableToken() {
  return sessionStorage.getItem(TABLE_TOKEN_KEY) || null;
}

function showTableError(msg) {
  document.body.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; padding:2rem; text-align:center; background:var(--bg);">
      <h2 style="color:var(--gold-light); margin-bottom:1rem; font-family:var(--font-display);">Authentication Required</h2>
      <p style="margin-bottom:2rem;">${msg}</p>
    </div>
  `;
}

function getTableNumber() {
  return sessionStorage.getItem(TABLE_ID_KEY) || "1";
}

function getCartKey() {
  return `cafe_cart_${getTableSessionId() || 'default'}`;
}

function getOrderKey() {
  return `cafe_active_order_${getTableSessionId() || 'default'}`;
}

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(getCartKey()) || "[]");
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(getCartKey(), JSON.stringify(cart));
  updateCartBadge();
}

function clearCart() {
  localStorage.removeItem(getCartKey());
  updateCartBadge();
}

function cartCount() {
  return getCart().reduce((sum, item) => sum + item.quantity, 0);
}

function cartTotal() {
  return getCart().reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function updateCartBadge() {
  const badge = document.querySelector(".cart-badge span");
  if (!badge) return;
  const count = cartCount();
  badge.textContent = count;
  badge.style.display = count > 0 ? "flex" : "none";
}

function addToCart(menuItem, quantity, customNote) {
  const cart = getCart();
  const note = (customNote || "").trim();
  const existing = cart.find(
    (c) => c.id === menuItem.id && (c.customNote || "") === note
  );

  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.push({
      id: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      image: menuItem.image,
      quantity,
      customNote: note,
    });
  }

  saveCart(cart);
}

function updateCartQty(id, customNote, delta) {
  const cart = getCart();
  const note = (customNote || "").trim();
  const existing = cart.find(
    (c) => c.id === id && (c.customNote || "") === note
  );

  if (existing) {
    existing.quantity += delta;
    if (existing.quantity <= 0) {
      const idx = cart.indexOf(existing);
      cart.splice(idx, 1);
    }
    saveCart(cart);
  }
}

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 2500);
}

function formatPrice(n) {
  return `₹${Number(n).toFixed(2)}`;
}

function getSessionOrders() {
  try {
    return JSON.parse(localStorage.getItem(getOrderKey()) || "[]");
  } catch {
    return [];
  }
}

function addSessionOrder(orderId) {
  const orders = getSessionOrders();
  if (!orders.includes(orderId)) {
    orders.push(orderId);
    localStorage.setItem(getOrderKey(), JSON.stringify(orders));
  }
}

function getActiveOrderId() {
  const orders = getSessionOrders();
  return orders.length > 0 ? orders[orders.length - 1] : null;
}

function clearActiveOrder() {
  // We no longer clear all orders, maybe clear the last one if needed, but not required right now.
  // We'll leave it as a no-op or just remove it if not used. But wait, newOrderBtn calls it.
  // Actually, newOrderBtn should just redirect or not clear the whole history.
  // For safety, let's keep it but just return.
}

document.addEventListener("DOMContentLoaded", () => {
  updateCartBadge();

  // Rewrite hardcoded navigation links to include the current café's slug.
  // This ensures that when a customer clicks "Home" or "Menu", they stay
  // within their specific café's experience (e.g. /c/cafe-crafted/menu)
  // instead of falling back to the root platform paths.
  const prefix = `/c/${CAFE_SLUG}`;
  document.querySelectorAll("a").forEach(a => {
    const href = a.getAttribute("href");
    if (!href) return;
    
    if (href === "/") {
      a.setAttribute("href", prefix);
    } else if (href === "/menu.html") {
      a.setAttribute("href", `${prefix}/menu`);
    } else if (href === "/cart.html") {
      a.setAttribute("href", `${prefix}/cart`);
    } else if (href === "/orders.html") {
      a.setAttribute("href", `${prefix}/orders`);
    }
  });
});
