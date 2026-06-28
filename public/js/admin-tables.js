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

    // Since Part A styles might be missing, adding basic inline styles or reusing existing classes
    return `
      <div class="admin-menu-item glass" data-id="${table.id}" style="align-items: flex-start; gap: 1.5rem;">
        <div style="flex-shrink: 0; background: white; padding: 0.5rem; border-radius: 8px;">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(table.qrUrl)}" alt="QR Code for Table ${table.label}" style="width: 120px; height: 120px; display: block;" />
        </div>
        <div style="flex: 1;">
          <h4 style="margin-bottom: 0.25rem;">Table ${table.label || table.id}</h4>
          <p style="margin-bottom: 0.75rem;">
            <a href="${table.qrUrl}" target="_blank" style="color: var(--gold-light); font-size: 0.85rem; text-decoration: underline; word-break: break-all;">
              ${table.qrUrl}
            </a>
          </p>
          <p><span style="padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; 
             ${badgeClass === 'badge-success' ? 'background: #28a745; color: white;' : 
               badgeClass === 'badge-amber' ? 'background: #ffc107; color: black;' : 
               'background: #6c757d; color: white;'}">
            ${badgeText}
          </span></p>
        </div>
        <div class="admin-menu-actions" style="flex-direction: column; gap: 0.5rem;">
          ${actionBtn}
          <a href="${table.qrUrl}" target="_blank" class="btn btn-ghost" style="text-align: center;">Open Table</a>
          <button class="btn btn-ghost reset-qr-btn" data-id="${table.id}" style="text-align: center;">Reset QR</button>
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
