let socket = null;
let pollingTimer = null;

function renderCart() {
  const cart = getCart();
  const listEl = document.getElementById("cartList");
  const summaryEl = document.getElementById("cartSummary");
  const checkoutEl = document.getElementById("checkoutSection");
  const emptyEl = document.getElementById("cartEmpty");
  // We removed orderStatus inline display
  if (!cart.length) {
    listEl.innerHTML = "";
    summaryEl.style.display = "none";
    checkoutEl.style.display = "none";
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";
  summaryEl.style.display = "block";
  checkoutEl.style.display = "block";

  listEl.innerHTML = cart
    .map(
      (item) => `
    <div class="cart-item glass">
      <img src="${item.image}" alt="${item.name}" />
      <div class="cart-item-info">
        <h4>${item.name}</h4>
        ${item.customNote ? `<p class="cart-item-note">"${item.customNote}"</p>` : ""}
        <div class="cart-item-meta">
          <div class="cart-qty-control">
            <button type="button" class="qty-btn cart-qty-minus" data-id="${item.id}" data-note="${item.customNote || ''}">−</button>
            <span class="qty-value">${item.quantity}</span>
            <button type="button" class="qty-btn cart-qty-plus" data-id="${item.id}" data-note="${item.customNote || ''}">+</button>
          </div>
          <span>${formatPrice(item.price * item.quantity)}</span>
        </div>
      </div>
    </div>`
    )
    .join("");

  document.getElementById("cartTotal").textContent = formatPrice(cartTotal());

  document.querySelectorAll(".cart-qty-minus").forEach((btn) => {
    btn.addEventListener("click", () => {
      updateCartQty(btn.dataset.id, btn.dataset.note, -1);
      renderCart();
    });
  });

  document.querySelectorAll(".cart-qty-plus").forEach((btn) => {
    btn.addEventListener("click", () => {
      updateCartQty(btn.dataset.id, btn.dataset.note, 1);
      renderCart();
    });
  });
}

async function placeOrder() {
  const cart = getCart();
  if (!cart.length) return;

  const btn = document.getElementById("placeOrderBtn");
  btn.disabled = true;
  btn.textContent = "Placing order…";

  try {
    const res = await fetch(withCafeSlug("/api/orders"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableToken: getTableToken(),
        sessionId: getTableSessionId(),
        items: cart,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 403) {
        showToast(errData.error || "Session invalid. Please rescan QR code.");
        btn.disabled = false;
        btn.textContent = "Confirm Order";
        return;
      }
      throw new Error(errData.error || "Failed");
    }

    const order = await res.json();
    clearCart();
    addSessionOrder(order.id);
    window.location.href = "/orders.html";
  } catch (err) {
    showToast(err.message === "Failed" ? "Could not place order. Try again." : err.message);
    btn.disabled = false;
    btn.textContent = "Confirm Order";
  }
}

// The status and polling logic has been moved to orders.js
document.getElementById("placeOrderBtn")?.addEventListener("click", placeOrder);
document.addEventListener("DOMContentLoaded", () => {
  if (typeof initCustomerApp === "function") {
    initCustomerApp(renderCart);
  } else {
    renderCart();
  }
});
