function getSuperAdminKey() {
  const key = sessionStorage.getItem("superAdminKey");
  if (!key) window.location.href = "/super-admin-login.html";
  return key;
}
function superAdminHeaders() {
  return { "x-super-admin-key": getSuperAdminKey() };
}

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  sessionStorage.removeItem("superAdminKey");
  window.location.href = "/super-admin-login.html";
});

async function loadCafeDetail() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    document.getElementById("cafeDetailContent").innerHTML = `<p class="empty-state">No café specified.</p>`;
    return;
  }

  const res = await fetch(`/api/super-admin/cafes/${id}`, { headers: superAdminHeaders() });
  if (res.status === 401) {
    sessionStorage.removeItem("superAdminKey");
    window.location.href = "/super-admin-login.html";
    return;
  }
  if (!res.ok) {
    document.getElementById("cafeDetailContent").innerHTML = `<p class="empty-state">Café not found.</p>`;
    return;
  }
  const cafe = await res.json();

  document.getElementById("cafeDetailContent").innerHTML = `
    <h1>${cafe.name}</h1>
    <p style="color:var(--text-muted);">${cafe.slug} · ${cafe.ownerName || "—"} · ${cafe.ownerEmail || "—"}</p>
    <span class="badge ${cafe.isActive ? "badge-success" : "badge-muted"}">${cafe.isActive ? "Active" : "Inactive"}</span>

    <div style="display:flex; gap:0.5rem; margin:1rem 0;">
      <button class="btn btn-ghost" id="toggleActiveBtn">${cafe.isActive ? "Deactivate" : "Activate"} Café</button>
      <button class="btn btn-ghost" id="resetKeyBtn">Reset Admin Key</button>
    </div>

    <div class="stats-grid" style="display:grid; grid-template-columns:repeat(3,1fr); gap:1rem; margin:1.5rem 0;">
      <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.5rem; font-weight:700;">${cafe.stats.tableCount}</div><div>Tables</div></div>
      <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.5rem; font-weight:700;">${cafe.stats.menuItemCount}</div><div>Menu Items</div></div>
      <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.5rem; font-weight:700;">${cafe.stats.totalOrdersAllTime}</div><div>Orders All-Time</div></div>
      <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.5rem; font-weight:700;">₹${cafe.stats.totalRevenueAllTime.toFixed(2)}</div><div>Revenue All-Time</div></div>
      <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.5rem; font-weight:700;">${cafe.stats.ordersThisMonth}</div><div>Orders This Month</div></div>
      <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.5rem; font-weight:700;">₹${cafe.stats.revenueThisMonth.toFixed(2)}</div><div>Revenue This Month</div></div>
    </div>

    <h2>Recent Orders</h2>
    <div id="recentOrdersList">
      ${cafe.recentOrders.map((o) => `
        <div class="glass" style="padding:0.75rem; border-radius:8px; margin-bottom:0.5rem;">
          Table ${o.tableNumber} · ₹${o.total.toFixed(2)} · ${o.status} · ${new Date(o.createdAt).toLocaleString()}
        </div>
      `).join("") || "<p class='empty-state'>No orders yet.</p>"}
    </div>
  `;

  document.getElementById("toggleActiveBtn").addEventListener("click", async () => {
    await fetch(`/api/super-admin/cafes/${id}/status`, {
      method: "PATCH",
      headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !cafe.isActive }),
    });
    loadCafeDetail();
  });

  document.getElementById("resetKeyBtn").addEventListener("click", async () => {
    if (!confirm("This will invalidate the café's current admin login. Continue?")) return;
    const res = await fetch(`/api/super-admin/cafes/${id}/reset-admin-key`, {
      method: "POST",
      headers: superAdminHeaders(),
    });
    const updated = await res.json();
    alert(`New admin key for this café:\n\n${updated.adminKey}\n\nShare this with the café owner — it will not be shown again.`);
  });
}

loadCafeDetail();
