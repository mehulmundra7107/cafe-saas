let calendarVisibleMonth = new Date(); // tracks which month the mini-calendar is showing

async function openCalendarPopover() {
  const popover = document.getElementById("calendarPopover");
  const isVisible = popover.style.display === "block";
  document.getElementById("customRangePopover").style.display = "none";

  if (isVisible) {
    popover.style.display = "none";
    return;
  }

  popover.style.display = "block";
  await renderCalendarMonth();
}

async function renderCalendarMonth() {
  const popover = document.getElementById("calendarPopover");
  const year = calendarVisibleMonth.getFullYear();
  const month = calendarVisibleMonth.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;

  let activeDates = [];
  try {
    const res = await fetch(`/api/admin/orders/active-dates?month=${monthKey}`, {
      headers: adminHeaders(),
    });
    const data = await res.json();
    activeDates = data.dates;
  } catch (err) {
    console.error("Could not load active dates", err);
  }

  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = firstDay.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  let cells = "";
  for (let i = 0; i < startWeekday; i++) {
    cells += `<div class="cal-cell empty"></div>`;
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hasOrders = activeDates.includes(dateKey);
    cells += `
      <button class="cal-cell ${hasOrders ? "has-orders" : ""}" data-date="${dateKey}" ${hasOrders ? "" : "disabled"}>
        ${day}
      </button>`;
  }

  popover.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
      <button class="btn btn-ghost cal-nav" id="calPrevMonth">‹</button>
      <strong>${monthLabel}</strong>
      <button class="btn btn-ghost cal-nav" id="calNextMonth">›</button>
    </div>
    <div class="cal-grid" style="display:grid; grid-template-columns:repeat(7,1fr); gap:0.25rem; text-align:center;">
      ${cells}
    </div>
    <p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.5rem;">
      Highlighted dates have at least one order.
    </p>
  `;

  document.getElementById("calPrevMonth").addEventListener("click", () => {
    calendarVisibleMonth.setMonth(calendarVisibleMonth.getMonth() - 1);
    renderCalendarMonth();
  });
  document.getElementById("calNextMonth").addEventListener("click", () => {
    calendarVisibleMonth.setMonth(calendarVisibleMonth.getMonth() + 1);
    renderCalendarMonth();
  });

  popover.querySelectorAll(".cal-cell.has-orders").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = btn.dataset.date;
      setOrderFilter({ date });
      document.getElementById("calendarPopover").style.display = "none";
    });
  });
}

function setOrderFilter(filter) {
  currentOrderFilter = filter;
  document.querySelectorAll(".filter-quick-btn").forEach((b) => b.classList.remove("active"));
  if (filter.range) {
    const btn = document.querySelector(`.filter-quick-btn[data-range="${filter.range}"]`);
    if (btn) btn.classList.add("active");
  }
  loadOrders();
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".filter-quick-btn").forEach((btn) => {
    btn.addEventListener("click", () => setOrderFilter({ range: btn.dataset.range }));
  });

  document.getElementById("openCalendarBtn")?.addEventListener("click", openCalendarPopover);

  document.getElementById("openCustomRangeBtn")?.addEventListener("click", () => {
    document.getElementById("calendarPopover").style.display = "none";
    const popover = document.getElementById("customRangePopover");
    popover.style.display = popover.style.display === "flex" ? "none" : "flex";
  });

  document.getElementById("applyCustomRangeBtn")?.addEventListener("click", () => {
    const from = document.getElementById("customFromInput").value;
    const to = document.getElementById("customToInput").value;
    if (!from || !to) {
      alert("Please pick both a start and end date.");
      return;
    }
    setOrderFilter({ from, to });
    document.getElementById("customRangePopover").style.display = "none";
  });

  document.getElementById("closeCustomRangeBtn")?.addEventListener("click", () => {
    document.getElementById("customRangePopover").style.display = "none";
  });

  function getExportUrl(format) {
    const params = new URLSearchParams();
    if (currentOrderFilter.date) {
      params.set("date", currentOrderFilter.date);
    } else if (currentOrderFilter.from && currentOrderFilter.to) {
      params.set("from", currentOrderFilter.from);
      params.set("to", currentOrderFilter.to);
    } else {
      params.set("range", currentOrderFilter.range || "today");
    }
    params.set("key", adminKey);
    return `/api/admin/orders/export.${format}?${params.toString()}`;
  }

  document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
    window.open(getExportUrl("csv"), "_blank");
  });

  document.getElementById("exportPdfBtn")?.addEventListener("click", () => {
    window.open(getExportUrl("pdf"), "_blank");
  });
});
