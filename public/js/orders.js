let socket = null;
let pollingTimer = null;
let ordersData = {};

async function fetchOrders() {
  const sessionOrders = getSessionOrders();
  const listEl = document.getElementById("ordersList");
  const emptyEl = document.getElementById("noOrdersMessage");

  if (!sessionOrders || sessionOrders.length === 0) {
    listEl.innerHTML = "";
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";

  for (const orderId of sessionOrders) {
    try {
      const res = await fetch(withCafeSlug(`/api/orders/${orderId}`), { cache: "no-store" });
      if (res.ok) {
        const order = await res.json();
        ordersData[order.id] = order;
      }
    } catch (err) {
      console.error(err);
    }
  }

  renderOrders();
}

function renderOrders() {
  const listEl = document.getElementById("ordersList");
  const sessionOrders = getSessionOrders();

  // Reverse so newest is on top
  const sortedOrders = [...sessionOrders].reverse().filter(id => ordersData[id]);

  if (sortedOrders.length === 0) {
    document.getElementById("noOrdersMessage").style.display = "block";
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = sortedOrders.map(id => {
    const order = ordersData[id];
    return generateOrderHTML(order);
  }).join("");

  // Attach event listeners
  sortedOrders.forEach(id => {
    const order = ordersData[id];
    if (["accepted", "preparing", "ready"].includes(order.status)) {
      const btn = document.getElementById(`callWaiterBtn-${order.id}`);
      if (btn) btn.addEventListener("click", () => callWaiter(order.id));
    }
  });
}

function generateOrderHTML(order) {
  const configs = {
    pending: {
      icon: '<div class="spinner"></div>',
      title: "Waiting for confirmation",
      text: "The café is reviewing your order.",
      showWaiter: false,
    },
    accepted: {
      icon: "✓",
      title: "Order accepted!",
      text: "Your order is being prepared.",
      showWaiter: true,
    },
    preparing: {
      icon: "👨‍🍳",
      title: "Being prepared",
      text: "Our kitchen is working on your order right now.",
      showWaiter: true,
    },
    ready: {
      icon: "🎉",
      title: "Order ready!",
      text: "Your order is ready. Enjoy!",
      showWaiter: true,
    },
    rejected: {
      icon: "✕",
      title: "Order rejected",
      text: "Sorry, the café could not accept your order.",
      showWaiter: false,
    },
  };

  const cfg = configs[order.status] || configs.pending;
  const itemsHtml = order.items.map(item => `
    <div class="order-item-summary">
      <span>${item.quantity}x ${item.name}</span>
      <span>${formatPrice(item.price * item.quantity)}</span>
    </div>
  `).join("");

  return `
    <div class="order-status-panel glass ${order.status}" id="order-panel-${order.id}">
      <div class="status-icon">${cfg.icon}</div>
      <h2>${cfg.title}</h2>
      <p>${cfg.text}</p>
      
      <div class="order-items-list">
        ${itemsHtml}
        <div class="order-total">
          <strong>Total:</strong>
          <strong>${formatPrice(order.total)}</strong>
        </div>
      </div>

      ${cfg.showWaiter ? `<button class="btn btn-primary waiter-btn" id="callWaiterBtn-${order.id}">Call Waiter for Order</button>` : ""}
      
      <p class="order-id">Order #${order.id.slice(0, 8)} · Table ${order.tableNumber}</p>
    </div>
  `;
}

async function callWaiter(orderId) {
  try {
    const res = await fetch(withCafeSlug("/api/waiter-call"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableToken: getTableToken(),
        sessionId: getTableSessionId(),
        orderId: orderId,
      }),
    });
    
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 403) {
        showToast(errData.error || "Session invalid. Please rescan QR code.");
        return;
      }
      throw new Error(errData.error || "Failed");
    }
    
    showToast("Waiter has been notified!");
  } catch (err) {
    showToast(err.message === "Failed" ? "Could not reach staff. Please wave to a waiter." : err.message);
  }
}

function startPolling() {
  fetchOrders();
  pollingTimer = setInterval(fetchOrders, 3000);

  if (!socket) {
    socket = io();
    socket.on("order:updated", (order) => {
      const sessionOrders = getSessionOrders();
      if (sessionOrders.includes(order.id)) {
        ordersData[order.id] = order;
        renderOrders();
      }
    });
  }
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof initCustomerApp === "function") {
    initCustomerApp(startPolling);
  } else {
    startPolling();
  }
});

window.addEventListener("beforeunload", stopPolling);
