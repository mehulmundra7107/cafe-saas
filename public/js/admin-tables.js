let tablesPollingTimer = null;

async function loadAdminTables() {
  if (!checkAuth || !(await checkAuth())) return;

  try {
    const res = await fetch("/api/admin/tables", { headers: adminHeaders() });
    if (!res.ok) throw new Error("Failed to load tables");
    const tables = await res.json();
    renderAdminTables(tables);
  } catch (err) {
    console.error(err);
  }
}

function renderAdminTables(tables) {
  const container = document.getElementById("adminTablesList");
  if (!container) return;

  if (!tables.length) {
    container.innerHTML = '<p class="empty-state">No tables found.</p>';
    return;
  }

  container.innerHTML = tables.map(table => {
    let badgeClass = "badge-success";
    let badgeText = "Free";
    let actionBtn = "";

    if (table.status === "occupied") {
      actionBtn = `<button class="btn btn-danger release-table-btn" data-id="${table.id}">Release Table</button>`;
      if (table.isStale) {
        badgeClass = "badge-grey";
        badgeText = "Occupied (idle, will auto-release)";
      } else {
        badgeClass = "badge-amber";
        badgeText = `Occupied (active ${table.minutesIdle}m ago)`;
      }
    }

    return `
      <div class="admin-menu-item glass" data-id="${table.id}" style="align-items: flex-start; gap: 1.5rem; flex-wrap: wrap;">

        <!-- QR Code — square, white background, borderless, scan-ready -->
        <div style="
          flex-shrink: 0;
          width: 160px;
          height: 160px;
          background: #ffffff;
          border-radius: 10px;
          overflow: hidden;
          box-shadow: 0 0 0 4px rgba(255,255,255,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <img
            src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=6&data=${encodeURIComponent(table.qrUrl)}"
            alt="QR for ${table.label || table.id}"
            style="width: 160px; height: 160px; display: block; image-rendering: pixelated;"
          />
        </div>

        <!-- Table info -->
        <div style="flex: 1; min-width: 180px;">
          <h4 style="margin-bottom: 0.25rem; font-size: 1.1rem;">${table.label || 'Table ' + table.id}</h4>
          <p style="margin-bottom: 0.75rem;">
            <a href="${table.qrUrl}" target="_blank" style="color: var(--gold-light); font-size: 0.8rem; text-decoration: underline; word-break: break-all;">
              ${table.qrUrl}
            </a>
          </p>
          <p style="margin-bottom: 0.75rem;">
            <span style="
              padding: 4px 10px;
              border-radius: 4px;
              font-size: 0.8rem;
              font-weight: bold;
              ${badgeClass === 'badge-success' ? 'background:#28a745;color:white;' :
                badgeClass === 'badge-amber'   ? 'background:#ffc107;color:black;' :
                                                 'background:#6c757d;color:white;'}
            ">${badgeText}</span>
          </p>
        </div>

        <!-- Actions -->
        <div class="admin-menu-actions" style="flex-direction: column; gap: 0.5rem; align-items: stretch;">
          ${actionBtn}
          <a href="${table.qrUrl}" target="_blank" class="btn btn-ghost" style="text-align:center;">Open Table</a>
          <a
            href="https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data=${encodeURIComponent(table.qrUrl)}"
            download="qr-${table.id}.png"
            class="btn btn-ghost"
            style="text-align:center;"
          >Download QR</a>
          <button class="btn btn-ghost reset-qr-btn" data-id="${table.id}" style="text-align:center;">Reset QR</button>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".release-table-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Free up this table for the next customer?")) return;
      
      const id = btn.dataset.id;
      try {
        await fetch(`/api/admin/tables/${id}/release`, {
          method: "POST",
          headers: adminHeaders()
        });
        loadAdminTables();
      } catch (err) {
        console.error("Failed to release table", err);
      }
    });
  });

  container.querySelectorAll(".reset-qr-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("This will invalidate the current QR code for this table. Anyone using the old printed QR will no longer be able to order. Continue?")) return;

      const id = btn.dataset.id;
      try {
        await fetch(`/api/admin/tables/${id}/reset-qr`, {
          method: "POST",
          headers: adminHeaders()
        });
        loadAdminTables();
      } catch (err) {
        console.error("Failed to reset QR", err);
        alert("Could not reset this table's QR code. Please try again.");
      }
    });
  });
}

function startTablesPolling() {
  loadAdminTables();
  if (tablesPollingTimer) clearInterval(tablesPollingTimer);
  tablesPollingTimer = setInterval(loadAdminTables, 15000);
}

function stopTablesPolling() {
  if (tablesPollingTimer) clearInterval(tablesPollingTimer);
}

// Hook into the tab system to only poll when active
document.addEventListener("DOMContentLoaded", () => {
  const tabs = document.querySelectorAll(".admin-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.dataset.panel === "tablesPanel") {
        startTablesPolling();
      } else {
        stopTablesPolling();
      }
    });
  });

  const addTableForm = document.getElementById("addTableForm");
  if (addTableForm) {
    addTableForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = document.getElementById("newTableId").value.trim();
      const label = document.getElementById("newTableLabel").value.trim();

      if (!id) return;

      try {
        const res = await fetch("/api/admin/tables", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ id, label }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to add table");
        }
        addTableForm.reset();
        loadAdminTables();
      } catch (err) {
        console.error(err);
        alert(err.message || "Could not add table. It may already exist.");
      }
    });
  }

  document.getElementById("resetAllQrBtn")?.addEventListener("click", async () => {
    if (!confirm(
      "This will invalidate EVERY table's current QR code for this café. " +
      "Any printed QR codes currently in use will stop working immediately, " +
      "and you will need to print new ones. Continue?"
    )) return;

    try {
      const res = await fetch("/api/admin/tables/reset-all-qr", {
        method: "POST",
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error("Failed to reset QR codes");

      const data = await res.json();
      alert(`Successfully reset ${data.count} table QR code(s). Reloading the list now.`);
      loadAdminTables();
    } catch (err) {
      console.error(err);
      alert("Could not reset QR codes. Please try again.");
    }
  });
});
