function getSuperAdminKey() {
  const key = sessionStorage.getItem("superAdminKey");
  if (!key) {
    window.location.href = "/super-admin-login.html";
  }
  return key;
}

function superAdminHeaders() {
  return { "x-super-admin-key": getSuperAdminKey() };
}

async function loadPlatformStats() {
  const res = await fetch("/api/super-admin/platform-stats", { headers: superAdminHeaders() });
  if (res.status === 401) {
    sessionStorage.removeItem("superAdminKey");
    window.location.href = "/super-admin-login.html";
    return;
  }
  const stats = await res.json();
  document.getElementById("statsGrid").innerHTML = `
    <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.8rem; font-weight:700;">${stats.totalCafes}</div><div>Total Cafés</div></div>
    <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.8rem; font-weight:700;">${stats.activeCafes}</div><div>Active</div></div>
    <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.8rem; font-weight:700;">${stats.ordersToday}</div><div>Orders Today (All Cafés)</div></div>
    <div class="glass" style="padding:1rem; border-radius:10px;"><div style="font-size:1.8rem; font-weight:700;">₹${stats.revenueToday.toFixed(2)}</div><div>Revenue Today (All Cafés)</div></div>
  `;
}

async function loadCafesList() {
  const res = await fetch("/api/super-admin/cafes", { headers: superAdminHeaders() });
  const cafes = await res.json();
  const container = document.getElementById("cafesList");

  if (!cafes.length) {
    container.innerHTML = `<p class="empty-state">No cafés yet. Click "Add New Café" to create your first one.</p>`;
    return;
  }

  container.innerHTML = cafes.map((cafe) => `
    <div class="glass" style="padding:1rem; border-radius:10px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <strong>${cafe.name}</strong>
        <span class="badge ${cafe.isActive ? "badge-success" : "badge-muted"}">${cafe.isActive ? "Active" : "Inactive"}</span>
        <div style="font-size:0.85rem; color:var(--text-muted);">
          ${cafe.todaysOrderCount} orders today · ₹${cafe.todaysRevenue.toFixed(2)} revenue today
        </div>
      </div>
      <a href="/super-admin-cafe-detail.html?id=${cafe.id}" class="btn btn-ghost">View</a>
    </div>
  `).join("");
}

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  sessionStorage.removeItem("superAdminKey");
  window.location.href = "/super-admin-login.html";
});

document.getElementById("addCafeBtn")?.addEventListener("click", () => {
  document.getElementById("addCafeModal").style.display = "block";
});
document.getElementById("cancelAddCafeBtn")?.addEventListener("click", () => {
  document.getElementById("addCafeModal").style.display = "none";
});

document.getElementById("addCafeForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById("newCafeName").value.trim(),
    slug: document.getElementById("newCafeSlug").value.trim(),
    ownerName: document.getElementById("newCafeOwnerName").value.trim(),
    ownerEmail: document.getElementById("newCafeOwnerEmail").value.trim(),
  };

  try {
    const res = await fetch("/api/super-admin/cafes", {
      method: "POST",
      headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to create café");
    }
    const newCafe = await res.json();

    document.getElementById("addCafeModal").style.display = "none";
    document.getElementById("addCafeForm").reset();

    document.getElementById("newCafeSlugDisplay").textContent = newCafe.slug;
    document.getElementById("newCafeKeyDisplay").textContent = newCafe.adminKey;
    document.getElementById("newCafeCredentialsModal").style.display = "block";

    loadCafesList();
    loadPlatformStats();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("closeCredentialsModalBtn")?.addEventListener("click", () => {
  document.getElementById("newCafeCredentialsModal").style.display = "none";
});

if (document.getElementById("statsGrid")) {
  loadPlatformStats();
  loadCafesList();
}
