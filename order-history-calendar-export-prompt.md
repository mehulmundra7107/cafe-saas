# CAFE PROJECT — ORDER HISTORY: CALENDAR, FILTERS & EXPORT REPORTS
# Paste this entire file into Cursor / Antigravity / Claude Code
# Built on your EXISTING codebase. Run Part A first, verify it, then
# Part B, then Part C — each part works standalone in its own session.
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior full-stack engineer working on a real, already-running
café ordering app: plain Node.js + Express + vanilla JS, no database, a
flat JSON file (`server/data/store.json`) as the data store. You make
precise, surgical additions. You do not rewrite working code. You do not
introduce new frameworks unless explicitly instructed in this prompt.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement each part fully before moving
to the next.

---

## CONTEXT — CURRENT STATE

This project already has a working admin panel with an "Orders" tab.
Right now, `GET /api/admin/orders` in `server/server.js` returns the
ENTIRE lifetime order list with no filtering:

```js
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  res.json(readStore().orders);
});
```

And `public/js/admin.js` has `loadOrders()` / `renderOrders()` which
fetch and render this entire unfiltered list as one flat scroll.

There is no kitchen-confirmation problem to solve separately — the
admin/manager is also the kitchen. The existing "Confirm Order" action
already IS the kitchen notification. You are not changing that flow.

What you ARE building: turning this flat, unfiltered order list into a
proper date-aware history view — Today by default, a calendar to jump to
any specific day, Week/Month/Custom quick filters, and an extensible
export/report system.

Every order in `store.json` already has a `createdAt` field
(ISO timestamp string, e.g. `"2026-06-23T11:38:14.716Z"`). All date
filtering in this prompt is built entirely on this existing field — no
new fields are needed on the order object itself for Parts A and B.

---

## IMPORTANT DESIGN NOTE — DO NOT SPLIT DATA INTO MULTIPLE FILES

Do not create separate files per day, month, or year. Keep all orders in
the single `store.orders` array as they are now. Date filtering happens
at query time on the server, not by physically separating storage. This
JSON file can comfortably hold tens of thousands of orders before this
becomes a real performance concern — that point is far in the future and
is not a problem to solve in this prompt.

---

# PART A — DATE-FILTERED ORDER QUERIES (BACKEND)

## TASK A1 — Add a date-filtering helper

In `server/server.js`, add this helper function near the other utility
functions (e.g. near `resolveImageUrl`):

```js
// Returns true if the given ISO timestamp falls within [startDate, endDate],
// both inclusive, compared in the server's local date sense (whole days).
// startDate and endDate are JS Date objects representing midnight boundaries.
function isWithinDateRange(isoTimestamp, startDate, endDate) {
  const t = new Date(isoTimestamp).getTime();
  return t >= startDate.getTime() && t <= endDate.getTime();
}

// Parses a "YYYY-MM-DD" string into a Date set to local midnight.
function parseDateOnly(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

// Returns the end-of-day boundary (23:59:59.999) for a given local date.
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

// Computes [start, end] Date boundaries for named quick ranges relative
// to "today" in server local time.
function getQuickRangeBounds(range) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayEnd = endOfDay(todayStart);

  if (range === "today") {
    return { start: todayStart, end: todayEnd };
  }

  if (range === "week") {
    // Monday as the start of the week.
    const dayOfWeek = todayStart.getDay(); // 0 = Sunday
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - diffToMonday);
    return { start: weekStart, end: todayEnd };
  }

  if (range === "month") {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return { start: monthStart, end: todayEnd };
  }

  return null;
}
```

---

## TASK A2 — Update `GET /api/admin/orders` to accept filters

Replace the existing route entirely:

```js
// Supports three ways to filter:
//   ?range=today | week | month        (quick presets)
//   ?date=YYYY-MM-DD                    (a single specific day, for calendar clicks)
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD      (custom range, inclusive both ends)
// If none are provided, defaults to "today".
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const { range, date, from, to } = req.query;
  const store = readStore();
  let allOrders = store.orders || [];

  let start, end;

  if (date) {
    start = parseDateOnly(date);
    end = endOfDay(start);
  } else if (from && to) {
    start = parseDateOnly(from);
    end = endOfDay(parseDateOnly(to));
  } else {
    const bounds = getQuickRangeBounds(range || "today");
    start = bounds.start;
    end = bounds.end;
  }

  const filtered = allOrders.filter((o) => isWithinDateRange(o.createdAt, start, end));

  res.json({
    orders: filtered,
    range: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
  });
});
```

NOTE: This changes the response shape from a plain array to
`{ orders: [...], range: {...} }`. You must update the frontend
(`admin.js`) accordingly in Task A4 — do not leave the frontend expecting
a plain array.

---

## TASK A3 — Add an endpoint to list which dates actually have orders

This powers the calendar UI in Part B — so it can show a dot/highlight
only on days that actually had activity, instead of being a blind
date picker.

```js
// Returns a list of distinct dates (YYYY-MM-DD, in server local time)
// that have at least one order, optionally scoped to a given month.
// ?month=YYYY-MM  — if omitted, returns dates across all orders.
app.get("/api/admin/orders/active-dates", requireAdmin, (req, res) => {
  const { month } = req.query;
  const store = readStore();
  const allOrders = store.orders || [];

  const dateSet = new Set();
  for (const order of allOrders) {
    const d = new Date(order.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!month || key.startsWith(month)) {
      dateSet.add(key);
    }
  }

  res.json({ dates: Array.from(dateSet).sort() });
});
```

---

## TASK A4 — Update the frontend to use the new response shape and filters

In `public/js/admin.js`, replace `loadOrders()`:

```js
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
      fetch(`/api/admin/orders?${params.toString()}`, { headers: adminHeaders() }),
      fetch("/api/admin/waiter-calls", { headers: adminHeaders() }),
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
```

Keep the rest of `renderOrders()` exactly as it currently is — it already
takes an array and renders cards, that part does not need to change.

Find wherever `loadOrders()` is currently called on tab switch or page
load, and confirm it still works unchanged (it should, since
`loadOrders()` keeps the same name and is still called with no arguments).

---

# PART B — CALENDAR + QUICK FILTER BUTTONS (FRONTEND UI)

## TASK B1 — Add the filter bar to the Orders panel

In `public/admin.html`, find the Orders panel:

```html
<div id="ordersPanel" class="admin-panel active">
  <div id="waiterAlerts"></div>
  <div class="orders-list" id="ordersList">
    <p class="empty-state">Loading orders…</p>
  </div>
</div>
```

Replace it with:

```html
<div id="ordersPanel" class="admin-panel active">
  <div id="waiterAlerts"></div>

  <div class="order-filter-bar glass" style="display:flex; flex-wrap:wrap; align-items:center; gap:0.75rem; padding:1rem; margin-bottom:1rem; border-radius:12px;">
    <button class="btn btn-ghost filter-quick-btn active" data-range="today">Today</button>
    <button class="btn btn-ghost filter-quick-btn" data-range="week">This Week</button>
    <button class="btn btn-ghost filter-quick-btn" data-range="month">This Month</button>
    <button class="btn btn-ghost" id="openCalendarBtn">📅 Pick a Date</button>
    <button class="btn btn-ghost" id="openCustomRangeBtn">Custom Range</button>
    <span id="orderFilterSummary" style="margin-left:auto; font-size:0.9rem; color:var(--text-muted);"></span>
  </div>

  <div id="calendarPopover" class="glass" style="display:none; position:absolute; z-index:50; padding:1rem; border-radius:12px; margin-bottom:1rem;"></div>

  <div id="customRangePopover" class="glass" style="display:none; padding:1rem; border-radius:12px; margin-bottom:1rem; gap:0.5rem; align-items:center; flex-wrap:wrap;">
    <label>From <input type="date" id="customFromInput" /></label>
    <label>To <input type="date" id="customToInput" /></label>
    <button class="btn btn-primary" id="applyCustomRangeBtn">Apply</button>
  </div>

  <div class="orders-list" id="ordersList">
    <p class="empty-state">Loading orders…</p>
  </div>
</div>
```

---

## TASK B2 — Build the calendar popover logic

Create a new file `public/js/admin-calendar.js`:

```js
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
});
```

Include this script in `admin.html`, right after `admin-tables.js`:

```html
<script src="/js/admin-calendar.js"></script>
```

---

## TASK B3 — Add minimal CSS for the calendar grid

In the relevant admin CSS file under `public/css/`, add:

```css
.cal-cell {
  padding: 0.5rem 0;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: default;
}
.cal-cell.empty {
  visibility: hidden;
}
.cal-cell.has-orders {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
  cursor: pointer;
  font-weight: 600;
}
.cal-cell.has-orders:hover {
  background: var(--gold-light);
  color: #000;
}
.filter-quick-btn.active {
  background: var(--gold-light);
  color: #000;
}
```

Adjust the exact CSS variable names (`--gold-light`, `--text`, etc.) to
match whatever variables already exist in the project's existing CSS —
check `public/css/` for the actual variable names in use before adding
this block, and substitute accordingly so it visually matches the rest
of the admin panel.

---

# PART C — EXTENSIBLE EXPORT / REPORT SYSTEM

## DESIGN PRINCIPLE FOR THIS PART — READ BEFORE CODING

The report's content must be built as a flexible, easily-extended data
structure on the backend, NOT hardcoded into a fixed PDF layout. The
person commissioning this system has specific UI/UX plans for how the
full item-by-item breakdown should look, which have not been finalized
yet. Your job in this part is to build the DATA layer completely and
correctly, and a simple, clean DEFAULT presentation — structured so that
the visual presentation can be redesigned later without touching the
underlying calculation logic at all.

Concretely: build one backend function that computes a complete report
object containing everything potentially needed (totals, full item
breakdown sorted by revenue and by quantity, both included). Build the
CSV export directly from this object. Build a simple, readable default
PDF from this same object. Keep these display layers thin — all the real
logic lives in one place, so changing how it LOOKS later is cheap.

---

## TASK C1 — Build the report computation function

In `server/server.js`, add:

```js
// Computes a complete summary report for a date range. This single
// function is the source of truth for both CSV and PDF exports — it
// intentionally includes more data than the current default view shows,
// so future UI changes to the report's presentation don't require any
// changes to this calculation logic.
function computeOrderReport(orders) {
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  // Aggregate per menu item across all orders in this range.
  const itemMap = new Map(); // id -> { name, quantity, revenue }
  for (const order of orders) {
    for (const item of order.items || []) {
      const key = item.id || item.name;
      const existing = itemMap.get(key) || { name: item.name, quantity: 0, revenue: 0 };
      existing.quantity += item.quantity;
      existing.revenue += item.price * item.quantity;
      itemMap.set(key, existing);
    }
  }

  const itemBreakdown = Array.from(itemMap.values());
  const itemsByQuantity = [...itemBreakdown].sort((a, b) => b.quantity - a.quantity);
  const itemsByRevenue = [...itemBreakdown].sort((a, b) => b.revenue - a.revenue);

  return {
    totalOrders,
    totalRevenue,
    avgOrderValue,
    // Both sort orders are included so any future UI can pick whichever
    // it wants to lead with, without recomputing anything.
    itemsByQuantity,
    itemsByRevenue,
    generatedAt: new Date().toISOString(),
  };
}
```

---

## TASK C2 — Add a JSON report endpoint (useful on its own, and for the UI to preview before exporting)

```js
app.get("/api/admin/orders/report", requireAdmin, (req, res) => {
  const { range, date, from, to } = req.query;
  const store = readStore();
  const allOrders = store.orders || [];

  let start, end;
  if (date) {
    start = parseDateOnly(date);
    end = endOfDay(start);
  } else if (from && to) {
    start = parseDateOnly(from);
    end = endOfDay(parseDateOnly(to));
  } else {
    const bounds = getQuickRangeBounds(range || "today");
    start = bounds.start;
    end = bounds.end;
  }

  const filtered = allOrders.filter((o) => isWithinDateRange(o.createdAt, start, end));
  const report = computeOrderReport(filtered);

  res.json({
    ...report,
    range: { start: start.toISOString(), end: end.toISOString() },
  });
});
```

---

## TASK C3 — CSV export endpoint

No new dependency needed — CSV is just text formatting.

```js
function escapeCsvField(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

app.get("/api/admin/orders/export.csv", requireAdmin, (req, res) => {
  const { range, date, from, to } = req.query;
  const store = readStore();
  const allOrders = store.orders || [];

  let start, end;
  if (date) {
    start = parseDateOnly(date);
    end = endOfDay(start);
  } else if (from && to) {
    start = parseDateOnly(from);
    end = endOfDay(parseDateOnly(to));
  } else {
    const bounds = getQuickRangeBounds(range || "today");
    start = bounds.start;
    end = bounds.end;
  }

  const filtered = allOrders.filter((o) => isWithinDateRange(o.createdAt, start, end));
  const report = computeOrderReport(filtered);

  const lines = [];
  lines.push("Summary");
  lines.push(`Date Range,${start.toISOString()} to ${end.toISOString()}`);
  lines.push(`Total Orders,${report.totalOrders}`);
  lines.push(`Total Revenue,${report.totalRevenue.toFixed(2)}`);
  lines.push(`Average Order Value,${report.avgOrderValue.toFixed(2)}`);
  lines.push("");
  lines.push("Item Breakdown (sorted by quantity sold)");
  lines.push("Item Name,Quantity Sold,Revenue");
  for (const item of report.itemsByQuantity) {
    lines.push(`${escapeCsvField(item.name)},${item.quantity},${item.revenue.toFixed(2)}`);
  }

  const csv = lines.join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="orders-report-${Date.now()}.csv"`);
  res.send(csv);
});
```

---

## TASK C4 — PDF export endpoint (simple default layout, easy to redesign later)

Install `pdfkit` — a lightweight, pure-JS PDF generation library, no
native dependencies, no headless browser needed:

```bash
npm install pdfkit
```

Add the import near the top of `server.js`:

```js
const PDFDocument = require("pdfkit");
```

Add the route:

```js
// Produces a simple, clean default PDF report. This layout is
// intentionally basic — it exists to prove the data pipeline works
// end-to-end. The visual design here is expected to be revisited later
// once the final report UI/UX is decided; computeOrderReport() already
// provides everything a redesigned layout would need without further
// backend changes.
app.get("/api/admin/orders/export.pdf", requireAdmin, (req, res) => {
  const { range, date, from, to } = req.query;
  const store = readStore();
  const allOrders = store.orders || [];

  let start, end;
  if (date) {
    start = parseDateOnly(date);
    end = endOfDay(start);
  } else if (from && to) {
    start = parseDateOnly(from);
    end = endOfDay(parseDateOnly(to));
  } else {
    const bounds = getQuickRangeBounds(range || "today");
    start = bounds.start;
    end = bounds.end;
  }

  const filtered = allOrders.filter((o) => isWithinDateRange(o.createdAt, start, end));
  const report = computeOrderReport(filtered);
  const cafeName = readStore().cafeInfo?.name || "Café";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="orders-report-${Date.now()}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text(`${cafeName} — Orders Report`, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#555")
    .text(`${start.toLocaleDateString()} to ${end.toLocaleDateString()}`, { align: "center" });
  doc.moveDown(1.5);

  doc.fontSize(12).fillColor("#000");
  doc.text(`Total Orders: ${report.totalOrders}`);
  doc.text(`Total Revenue: ₹${report.totalRevenue.toFixed(2)}`);
  doc.text(`Average Order Value: ₹${report.avgOrderValue.toFixed(2)}`);
  doc.moveDown(1.5);

  doc.fontSize(14).text("Item Breakdown", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(11);

  const tableTop = doc.y;
  doc.text("Item", 50, tableTop, { width: 250 });
  doc.text("Qty Sold", 300, tableTop, { width: 100, align: "right" });
  doc.text("Revenue", 420, tableTop, { width: 100, align: "right" });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(540, doc.y).stroke();
  doc.moveDown(0.3);

  for (const item of report.itemsByQuantity) {
    const rowY = doc.y;
    doc.text(item.name, 50, rowY, { width: 250 });
    doc.text(String(item.quantity), 300, rowY, { width: 100, align: "right" });
    doc.text(`₹${item.revenue.toFixed(2)}`, 420, rowY, { width: 100, align: "right" });
    doc.moveDown(0.4);
  }

  doc.moveDown(1);
  doc.fontSize(8).fillColor("#888")
    .text(`Generated on ${new Date().toLocaleString()}`, { align: "center" });

  doc.end();
});
```

---

## TASK C5 — Add export buttons to the admin UI

In `admin.html`, inside the filter bar from Task B1, add two buttons
right before the closing `</div>` of `.order-filter-bar`:

```html
<button class="btn btn-ghost" id="exportCsvBtn">Export CSV</button>
<button class="btn btn-ghost" id="exportPdfBtn">Export PDF</button>
```

In `admin-calendar.js` (or `admin.js`, either is fine — place it near
the other filter logic), add:

```js
function buildCurrentFilterParams() {
  const params = new URLSearchParams();
  if (currentOrderFilter.date) {
    params.set("date", currentOrderFilter.date);
  } else if (currentOrderFilter.from && currentOrderFilter.to) {
    params.set("from", currentOrderFilter.from);
    params.set("to", currentOrderFilter.to);
  } else {
    params.set("range", currentOrderFilter.range || "today");
  }
  return params;
}

document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
  const params = buildCurrentFilterParams();
  window.open(`/api/admin/orders/export.csv?${params.toString()}&key=${encodeURIComponent(getAdminKey())}`, "_blank");
});

document.getElementById("exportPdfBtn")?.addEventListener("click", () => {
  const params = buildCurrentFilterParams();
  window.open(`/api/admin/orders/export.pdf?${params.toString()}&key=${encodeURIComponent(getAdminKey())}`, "_blank");
});
```

IMPORTANT: `requireAdmin` currently checks the `x-admin-key` HEADER, but
a direct browser navigation/download (via `window.open`) cannot set
custom headers. You must update `requireAdmin` to ALSO accept the key as
a query parameter, specifically to support file downloads:

```js
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
```

Check `public/js/admin.js` for however the admin key/password is
currently stored after login (likely in a variable or `sessionStorage`)
and expose or reuse a `getAdminKey()` helper function consistent with
how `adminHeaders()` already builds its header object — do not introduce
a second, separate storage mechanism for the same key.

---

## WHAT NOT TO DO IN THIS PROMPT

- Do not hardcode a fixed visual report design as the "final" design —
  the PDF/report layout in Task C4 is explicitly a placeholder default,
  not the finished product
- Do not split `store.json` into multiple files by date
- Do not add a database
- Do not touch the existing order confirmation flow, occupancy locking,
  or table token security — all of that already works and is unrelated
  to this prompt
- Do not build a separate kitchen screen — admin already serves that role

---

## HOW TO VERIFY EACH PART

**Part A:**
1. Restart server, open admin panel, Orders tab loads — should default
   to showing only today's orders
2. Manually test in browser: `GET /api/admin/orders?range=week` with the
   admin key header — confirm it returns more orders than `range=today`
   if older orders exist in `store.json`

**Part B:**
1. Click "This Week" / "This Month" — order list updates accordingly,
   active button highlights correctly
2. Click "Pick a Date" — calendar appears, current month shown, only
   days with real orders are clickable/highlighted
3. Click a highlighted day — order list updates to show only that day
4. Click "Custom Range" — two date inputs appear, applying them filters
   correctly

**Part C:**
1. With "Today" filter active, click "Export CSV" — a `.csv` file
   downloads, opening it in a spreadsheet shows summary + item breakdown
2. Click "Export PDF" — a `.pdf` file downloads, opening it shows a
   readable report with the same data
3. Switch to "This Month" filter, export again — confirm the numbers
   reflect the full month, not just today

---

## SESSION CONTINUITY NOTE

This is intentionally left open for the report's visual design — when
you're ready to redesign how the item-by-item breakdown looks (UI/UX),
that work only touches the presentation layer (Task C4's PDF layout,
and optionally a richer on-screen preview before export) and does NOT
require changing `computeOrderReport()` or any filtering logic above it.
Bring your UI/UX plan for that breakdown to the next prompt when ready.

---

## END OF PROMPT
# ─────────────────────────────────────────────────────────────────────
