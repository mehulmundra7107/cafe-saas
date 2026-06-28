let adminKey = sessionStorage.getItem("admin_key") || "";
let socket = null;

function adminHeaders(json = true) {
  const h = { "x-admin-key": adminKey };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function checkAuth() {
  if (!adminKey) return { ok: false, error: "No key" };
  try {
    const res = await fetch("/api/admin/check", { headers: adminHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || "Incorrect password" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Network error connecting to server" };
  }
}

function showAdmin() {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("adminShell").classList.add("active");
  initSocket();
  loadOrders();
  loadMenuAdmin();
  loadCafeSettings();
  if (typeof loadAdminTables === 'function') loadAdminTables();
}

async function login(password) {
  const btn = document.querySelector("#loginForm button");
  const originalText = btn.textContent;
  btn.textContent = "Connecting to database...";
  btn.disabled = true;

  adminKey = password;
  const result = await checkAuth();
  
  btn.textContent = originalText;
  btn.disabled = false;

  if (!result.ok) {
    adminKey = "";
    const errorEl = document.getElementById("loginError");
    errorEl.textContent = result.error;
    errorEl.style.display = "block";
    return;
  }
  sessionStorage.setItem("admin_key", adminKey);
  document.getElementById("loginError").style.display = "none";
  showAdmin();
}

function logout() {
  adminKey = "";
  sessionStorage.removeItem("admin_key");
  location.reload();
}

function initSocket() {
  if (socket) return;
  socket = io();
  socket.on("order:new", () => loadOrders());
  socket.on("order:updated", () => loadOrders());
  socket.on("waiter:new", () => loadOrders());
  socket.on("menu:updated", () => loadMenuAdmin());
  socket.on("hero:updated", () => loadCafeSettings());
  socket.on("cafe:updated", () => loadCafeSettings());
  socket.on("table:released", () => {
    if (typeof loadAdminTables === 'function') loadAdminTables();
  });
}

// ——— Tabs ———

document.querySelectorAll(".admin-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
  });
});

// ——— Orders ———

let currentOrderFilter = { range: "today" };

async function loadOrders() {
  try {
    const params = new URLSearchParams();
    if (currentOrderFilter.date) {
      params.set("date", currentOrderFilter.date);
    } else if (currentOrderFilter.from && currentOrderFilter.to) {
      params.set("from", currentOrderFilter.from);
      params.set("to", currentOrderFilter.to);
    } else {
      params.set("range", currentOrderFilter.range || "today");
    }

    const [ordersRes, waiterRes] = await Promise.all([
      fetch(`/api/admin/orders?${params.toString()}`, { headers: adminHeaders(), cache: "no-store" }),
      fetch("/api/admin/waiter-calls", { headers: adminHeaders(), cache: "no-store" }),
    ]);
    const ordersData = await ordersRes.json();
    const waiterCalls = await waiterRes.json();
    renderOrders(ordersData.orders, waiterCalls);
    renderOrderFilterSummary(ordersData);
  } catch (err) {
    console.error(err);
  }
}

function renderOrderFilterSummary(ordersData) {
  const el = document.getElementById("orderFilterSummary");
  if (!el) return;
  const count = ordersData.orders.length;
  const revenue = ordersData.orders.reduce((sum, o) => sum + (o.total || 0), 0);
  el.textContent = `${count} order${count === 1 ? "" : "s"} · ${formatPrice(revenue)} revenue`;
}

function renderOrders(orders, waiterCalls) {
  const container = document.getElementById("ordersList");
  const waiterContainer = document.getElementById("waiterAlerts");

  waiterContainer.innerHTML = waiterCalls.length
    ? waiterCalls
        .map(
          (c) => `
      <div class="waiter-alert glass" data-id="${c.id}">
        <div><strong>Waiter requested</strong> — Table ${c.tableNumber}</div>
        <button class="btn btn-ghost resolve-waiter">Dismiss</button>
      </div>`
        )
        .join("")
    : "";

  waiterContainer.querySelectorAll(".resolve-waiter").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".waiter-alert").dataset.id;
      await fetch(`/api/admin/waiter-calls/${id}`, {
        method: "PATCH",
        headers: adminHeaders(),
      });
      loadOrders();
    });
  });

  if (!orders.length) {
    container.innerHTML = '<p class="empty-state">No orders yet.</p>';
    return;
  }

  container.innerHTML = orders
    .map((order) => {
      const itemsHtml = order.items
        .map(
          (i) =>
            `<li>${i.quantity}× ${i.name} — ${formatPrice(i.price * i.quantity)}${i.customNote ? `<br><span class="note">Note: ${i.customNote}</span>` : ""}</li>`
        )
        .join("");

      const dateObj = new Date(order.createdAt);
      const time = dateObj.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const dateStr = dateObj.toLocaleDateString();

      let actions = "";
      if (order.status === "pending") {
        actions = `
          <button class="btn btn-success accept-btn" data-id="${order.id}">Accept</button>
          <button class="btn btn-danger reject-btn" data-id="${order.id}">Reject</button>`;
      } else if (order.status === "accepted") {
        actions = `<button class="btn btn-primary preparing-btn" data-id="${order.id}">Mark Preparing</button>`;
      } else if (order.status === "preparing") {
        actions = `<button class="btn btn-success ready-btn" data-id="${order.id}">Mark Ready</button>`;
      }

      return `
        <div class="order-card glass">
          <div class="order-card-header">
            <div>
              <h3>Table ${order.tableNumber}</h3>
              <div class="order-meta">${dateStr} ${time} · ${formatPrice(order.total)}</div>
            </div>
            <span class="status-badge ${order.status}">${order.status}</span>
          </div>
          <ul class="order-items-list">${itemsHtml}</ul>
          <div class="order-actions">${actions}</div>
        </div>`;
    })
    .join("");

  container.querySelectorAll(".accept-btn").forEach((btn) => {
    btn.addEventListener("click", () => updateOrder(btn.dataset.id, "accepted"));
  });
  container.querySelectorAll(".reject-btn").forEach((btn) => {
    btn.addEventListener("click", () => updateOrder(btn.dataset.id, "rejected"));
  });
  container.querySelectorAll(".preparing-btn").forEach((btn) => {
    btn.addEventListener("click", () => updateOrder(btn.dataset.id, "preparing"));
  });
  container.querySelectorAll(".ready-btn").forEach((btn) => {
    btn.addEventListener("click", () => updateOrder(btn.dataset.id, "ready"));
  });
}

async function updateOrder(id, status) {
  await fetch(`/api/admin/orders/${id}`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ status }),
  });
  loadOrders();
}

// ——— Menu management ———

async function loadMenuAdmin() {
  try {
    const res = await fetch("/api/admin/menu", { headers: adminHeaders() });
    const items = await res.json();
    renderMenuAdmin(items);
  } catch (err) {
    console.error(err);
  }
}

function renderMenuAdmin(items) {
  const list = document.getElementById("adminMenuList");
  if (!items.length) {
    list.innerHTML = '<p class="empty-state">No menu items. Add one below.</p>';
    return;
  }

  list.innerHTML = items
    .map(
      (item) => `
    <div class="admin-menu-item glass ${item.inStock === false ? 'admin-out-of-stock' : ''}" data-id="${item.id}">
      <img src="${item.image}" alt="${item.name}" />
      <div>
        <h4>${item.name} ${item.inStock === false ? '<span style="color:var(--danger);font-size:0.8rem;margin-left:0.5rem">(Out of Stock)</span>' : ''}</h4>
        <p>${formatPrice(item.price)} · ${item.category}${item.available === false ? " · Hidden" : ""}</p>
      </div>
      <div class="admin-menu-actions">
        <button class="btn btn-ghost toggle-stock-btn">${item.inStock === false ? 'Mark In Stock' : 'Out of Stock'}</button>
        <button class="btn btn-ghost edit-item-btn">Edit</button>
        <button class="btn btn-danger delete-item-btn">Delete</button>
      </div>
    </div>`
    )
    .join("");

  list.querySelectorAll(".delete-item-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".admin-menu-item").dataset.id;
      if (!confirm("Delete this menu item?")) return;
      await fetch(`/api/admin/menu/${id}`, { method: "DELETE", headers: adminHeaders() });
      loadMenuAdmin();
    });
  });

  list.querySelectorAll(".edit-item-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.closest(".admin-menu-item").dataset.id;
      const item = items.find((i) => i.id === id);
      fillMenuForm(item);
    });
  });

  list.querySelectorAll(".toggle-stock-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".admin-menu-item").dataset.id;
      const item = items.find((i) => i.id === id);
      const formData = new FormData();
      formData.append("inStock", item.inStock === false ? "true" : "false");
      await fetch(`/api/admin/menu/${id}`, {
        method: "PUT",
        headers: { "x-admin-key": adminKey },
        body: formData,
      });
      loadMenuAdmin();
    });
  });
}

function fillMenuForm(item) {
  document.getElementById("menuFormTitle").textContent = "Edit Menu Item";
  document.getElementById("editItemId").value = item.id;
  document.getElementById("itemName").value = item.name;
  document.getElementById("itemPrice").value = item.price;
  document.getElementById("itemDesc").value = item.description;
  document.getElementById("itemCategory").value = item.category;
  document.getElementById("itemAvailable").checked = item.available !== false;
  document.getElementById("menuForm").scrollIntoView({ behavior: "smooth" });
}

function resetMenuForm() {
  document.getElementById("menuFormTitle").textContent = "Add Menu Item";
  document.getElementById("editItemId").value = "";
  document.getElementById("menuForm").reset();
  document.getElementById("itemAvailable").checked = true;
}

document.getElementById("menuForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const editId = document.getElementById("editItemId").value;
  const formData = new FormData();
  formData.append("name", document.getElementById("itemName").value);
  formData.append("price", document.getElementById("itemPrice").value);
  formData.append("description", document.getElementById("itemDesc").value);
  formData.append("category", document.getElementById("itemCategory").value);
  formData.append("available", document.getElementById("itemAvailable").checked);

  const imageFile = document.getElementById("itemImage").files[0];
  if (imageFile) formData.append("image", imageFile);

  const url = editId ? `/api/admin/menu/${editId}` : "/api/admin/menu";
  const method = editId ? "PUT" : "POST";

  await fetch(url, {
    method,
    headers: { "x-admin-key": adminKey },
    body: formData,
  });

  resetMenuForm();
  loadMenuAdmin();
  showToast(editId ? "Item updated" : "Item added");
});

document.getElementById("resetMenuForm").addEventListener("click", resetMenuForm);

// ——— Cafe settings & hero photos ———

async function loadCafeSettings() {
  try {
    const res = await fetch("/api/admin/cafe", { headers: adminHeaders() });
    const data = await res.json();
    const { cafeInfo, heroPhotos } = data;

    document.getElementById("cafeNameInput").value = cafeInfo.name || "";
    document.getElementById("introShortInput").value = cafeInfo.introShort || "";
    document.getElementById("introFullInput").value = cafeInfo.introFull || "";
    document.getElementById("phoneInput").value = cafeInfo.contact?.phone || "";
    document.getElementById("emailInput").value = cafeInfo.contact?.email || "";
    document.getElementById("addressInput").value = cafeInfo.contact?.address || "";
    document.getElementById("hoursInput").value = cafeInfo.contact?.hours || "";

    const grid = document.getElementById("heroPhotosGrid");
    grid.innerHTML = heroPhotos
      .map(
        (p) => `
      <div class="hero-photo-thumb">
        <img src="/photos/${p}" alt="Hero" />
        <button type="button" data-name="${p}" class="delete-hero-btn" title="Remove">×</button>
      </div>`
      )
      .join("");

    grid.querySelectorAll(".delete-hero-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this photo from carousel?")) return;
        await fetch(`/api/admin/hero-photos/${encodeURIComponent(btn.dataset.name)}`, {
          method: "DELETE",
          headers: adminHeaders(),
        });
        loadCafeSettings();
      });
    });
  } catch (err) {
    console.error(err);
  }
}

document.getElementById("cafeInfoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await fetch("/api/admin/cafe", {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({
      cafeInfo: {
        name: document.getElementById("cafeNameInput").value,
        introShort: document.getElementById("introShortInput").value,
        introFull: document.getElementById("introFullInput").value,
        contact: {
          phone: document.getElementById("phoneInput").value,
          email: document.getElementById("emailInput").value,
          address: document.getElementById("addressInput").value,
          hours: document.getElementById("hoursInput").value,
        },
      },
    }),
  });
  showToast("Café info saved");
});

document.getElementById("heroPhotoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = document.getElementById("heroPhotoInput").files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("image", file);

  await fetch("/api/admin/hero-photos", {
    method: "POST",
    headers: { "x-admin-key": adminKey },
    body: formData,
  });

  document.getElementById("heroPhotoForm").reset();
  loadCafeSettings();
  showToast("Photo added to carousel");
});

// ——— Init ———

document.getElementById("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  login(document.getElementById("adminPassword").value);
});

document.getElementById("logoutBtn").addEventListener("click", logout);

(async () => {
  if (await checkAuth()) showAdmin();
})();
