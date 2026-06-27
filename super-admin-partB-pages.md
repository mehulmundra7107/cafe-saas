# CAFE PROJECT — SUPER ADMIN, PART B
# Login, Dashboard, Café Management Pages + Frontend Wiring
# Paste this entire file into Cursor / Antigravity / Claude Code
# This is a CONTINUATION of Part A — paste Part A's completion summary
# above this prompt before pasting this one. Do not run this before
# Part A is verified working.
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior full-stack engineer building an internal admin tool.
This tool is for the PLATFORM OWNER only — not café staff, not
customers. It does not need the polish of the customer-facing site.
It needs to be clear, fast, and functional. Plain HTML/CSS/vanilla JS,
matching the existing project's style — no new frameworks.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement everything in order.

---

## CONTEXT — WHAT ALREADY EXISTS (FROM PART A)

Part A already implemented the full multi-tenant database foundation:
- A `cafes` table: `id, slug, name, owner_name, owner_email, is_active, admin_key, created_at, updated_at`
- Every other table (`cafe_info`, `hero_photos`, `menu_items`,
  `cafe_tables`, `orders`, `waiter_calls`) now has a `cafe_id` column,
  fully backfilled for the one existing café
- `server/db/store.js` — every function now takes `cafeId` as its first
  parameter, plus new functions: `getAllCafes()`, `getCafeById(id)`,
  `getCafeBySlug(slug)`, `getCafeByAdminKey(adminKey)`,
  `createCafe({...})`, `setCafeActive(id, isActive)`,
  `resetCafeAdminKey(id, newAdminKey)`
- `server/server.js` — `requireAdmin` now looks up which café a request
  belongs to via its admin key, attaching `req.cafeId` and `req.cafe`.
  Public customer-facing routes resolve their café via a `cafeSlug`
  query parameter using `resolveCafeBySlug(req)`.
- The existing café's data lives under `cafeId = 1` (or whatever the
  actual id is — confirm from Part A's continuity summary), slug
  `cafe-crafted`, with its `admin_key` equal to the original
  `ADMIN_PASSWORD` value.

You are building on top of this directly. Do not redo Part A's work.

---

## WHAT YOU ARE BUILDING IN THIS PART

1. A Super Admin login (separate secret, separate from any café's
   `admin_key`)
2. A Super Admin dashboard: platform-wide stats + list of all cafés
3. A café detail/drill-down page
4. An "Add New Café" flow
5. The small but necessary frontend change: the customer-facing pages
   need to know their own `cafeSlug` so every API call includes it

---

# PART 1 — SUPER ADMIN BACKEND

## TASK 1.1 — Add the super admin secret

In `.env`, add a new line:
```
SUPER_ADMIN_PASSWORD=choose-a-strong-secret-here
```

In `server/server.js`, near the existing `ADMIN_PASSWORD` constant, add:
```js
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "superadmin123";
```

This is a SEPARATE secret from any individual café's `admin_key` — never
shared, never derived from it. You (the platform owner) are the only
person who should ever know this value.

## TASK 1.2 — Super admin auth middleware

Mirror the exact pattern of `requireAdmin`, but check against this
single platform-wide secret instead of looking anything up in the
database:

```js
function requireSuperAdmin(req, res, next) {
  const key = req.headers["x-super-admin-key"] || req.query.key;
  if (key !== SUPER_ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
```

## TASK 1.3 — Super admin API routes

Add these routes in a clearly separated section of `server.js`, after
the existing `/api/admin/*` routes:

```js
// ─── SUPER ADMIN: PLATFORM-WIDE ROUTES ──────────────────────

app.get("/api/super-admin/cafes", requireSuperAdmin, async (req, res) => {
  const cafes = await db.getAllCafes();

  // Enrich each café with today's quick stats, so the dashboard list
  // doesn't need a second round-trip per café.
  const enriched = await Promise.all(
    cafes.map(async (cafe) => {
      const bounds = getQuickRangeBounds("today");
      const todaysOrders = await db.getOrdersInRange(cafe.id, bounds.start, bounds.end);
      const todaysRevenue = todaysOrders.reduce((sum, o) => sum + o.total, 0);
      return {
        ...cafe,
        adminKey: undefined, // never send admin keys in the list view
        todaysOrderCount: todaysOrders.length,
        todaysRevenue,
      };
    })
  );

  res.json(enriched);
});

app.get("/api/super-admin/cafes/:id", requireSuperAdmin, async (req, res) => {
  const cafe = await db.getCafeById(req.params.id);
  if (!cafe) return res.status(404).json({ error: "Café not found" });

  const tables = await db.getTables(cafe.id);
  const menuItems = await db.getMenuItems(cafe.id);
  const allOrders = await db.getAllOrdersForExport(cafe.id);

  const totalRevenue = allOrders.reduce((sum, o) => sum + o.total, 0);
  const monthBounds = getQuickRangeBounds("month");
  const monthOrders = await db.getOrdersInRange(cafe.id, monthBounds.start, monthBounds.end);
  const monthRevenue = monthOrders.reduce((sum, o) => sum + o.total, 0);

  res.json({
    ...cafe,
    adminKey: undefined, // never expose the actual key value over the wire casually
    stats: {
      tableCount: tables.length,
      menuItemCount: menuItems.length,
      totalOrdersAllTime: allOrders.length,
      totalRevenueAllTime: totalRevenue,
      ordersThisMonth: monthOrders.length,
      revenueThisMonth: monthRevenue,
    },
    recentOrders: allOrders.slice(0, 20),
  });
});

app.post("/api/super-admin/cafes", requireSuperAdmin, async (req, res) => {
  const { slug, name, ownerName, ownerEmail } = req.body;

  if (!slug || !name) {
    return res.status(400).json({ error: "slug and name are required" });
  }

  const existing = await db.getCafeBySlug(slug);
  if (existing) {
    return res.status(409).json({ error: "A café with this slug already exists" });
  }

  // Generate a random admin key for the new café — the platform owner
  // will share this with the café's owner/manager after creation.
  const adminKey = crypto.randomBytes(9).toString("base64url");

  const cafe = await db.createCafe({ slug, name, ownerName, ownerEmail, adminKey });

  // Seed this new café with sensible defaults so it's immediately usable:
  // a blank cafe_info row and four starter tables.
  await pool.query(
    `INSERT INTO cafe_info (cafe_id, name, intro_short, intro_full)
     VALUES ($1, $2, $3, $4)`,
    [cafe.id, name, "Welcome to our cafe.", "Tell your customers about your cafe here."]
  );
  for (let i = 1; i <= 4; i++) {
    await db.createTable(cafe.id, { id: String(i), label: `Table ${i}` });
  }

  res.status(201).json(cafe); // includes adminKey once, at creation time, so it can be shared with the owner
});

app.patch("/api/super-admin/cafes/:id/status", requireSuperAdmin, async (req, res) => {
  const { isActive } = req.body;
  const updated = await db.setCafeActive(req.params.id, isActive);
  if (!updated) return res.status(404).json({ error: "Café not found" });
  res.json({ ...updated, adminKey: undefined });
});

app.post("/api/super-admin/cafes/:id/reset-admin-key", requireSuperAdmin, async (req, res) => {
  const newAdminKey = crypto.randomBytes(9).toString("base64url");
  const updated = await db.resetCafeAdminKey(req.params.id, newAdminKey);
  if (!updated) return res.status(404).json({ error: "Café not found" });
  res.json(updated); // returns the new key ONCE, so the platform owner can share it with the café owner
});

app.get("/api/super-admin/platform-stats", requireSuperAdmin, async (req, res) => {
  const cafes = await db.getAllCafes();
  const bounds = getQuickRangeBounds("today");

  let ordersToday = 0;
  let revenueToday = 0;
  for (const cafe of cafes) {
    const orders = await db.getOrdersInRange(cafe.id, bounds.start, bounds.end);
    ordersToday += orders.length;
    revenueToday += orders.reduce((sum, o) => sum + o.total, 0);
  }

  res.json({
    totalCafes: cafes.length,
    activeCafes: cafes.filter((c) => c.isActive).length,
    inactiveCafes: cafes.filter((c) => !c.isActive).length,
    ordersToday,
    revenueToday,
  });
});
```

NOTE: `pool` must be required directly in `server.js` for the inline
`cafe_info` seed insert above — confirm `const pool = require("./db/pool");`
already exists near the top (Part A likely already needs this for other
reasons; if not present, add it).

---

# PART 2 — SUPER ADMIN FRONTEND PAGES

## TASK 2.1 — Login page

Create `public/super-admin-login.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Super Admin Login</title>
  <link rel="stylesheet" href="/css/admin.css" />
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; }
    .login-box { width: 320px; padding: 2rem; border-radius: 12px; }
    .login-box input { width: 100%; margin-bottom: 1rem; }
    .login-box button { width: 100%; }
    .error-text { color: #ff6b6b; font-size: 0.85rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="login-box glass">
    <h2 style="margin-bottom: 1.5rem;">Super Admin</h2>
    <input type="password" id="superAdminKeyInput" placeholder="Platform secret key" />
    <button class="btn btn-primary" id="loginBtn">Log In</button>
    <p class="error-text" id="loginError" style="display:none;"></p>
  </div>

  <script>
    document.getElementById("loginBtn").addEventListener("click", async () => {
      const key = document.getElementById("superAdminKeyInput").value.trim();
      const errorEl = document.getElementById("loginError");
      errorEl.style.display = "none";

      if (!key) return;

      try {
        const res = await fetch(`/api/super-admin/platform-stats?key=${encodeURIComponent(key)}`);
        if (!res.ok) throw new Error("Invalid key");

        sessionStorage.setItem("superAdminKey", key);
        window.location.href = "/super-admin-dashboard.html";
      } catch (err) {
        errorEl.textContent = "Incorrect key. Please try again.";
        errorEl.style.display = "block";
      }
    });

    document.getElementById("superAdminKeyInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("loginBtn").click();
    });
  </script>
</body>
</html>
```

## TASK 2.2 — Dashboard page

Create `public/super-admin-dashboard.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Super Admin — Dashboard</title>
  <link rel="stylesheet" href="/css/admin.css" />
</head>
<body>
  <div class="admin-topbar">
    <h1>Platform Dashboard</h1>
    <button class="btn btn-ghost" id="logoutBtn">Log Out</button>
  </div>

  <div class="stats-grid" id="statsGrid" style="display:grid; grid-template-columns:repeat(4,1fr); gap:1rem; margin:1.5rem 0;">
    <!-- filled by JS -->
  </div>

  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
    <h2>All Cafés</h2>
    <button class="btn btn-primary" id="addCafeBtn">+ Add New Café</button>
  </div>

  <div id="cafesList" class="cafes-grid" style="display:grid; gap:1rem;"></div>

  <div id="addCafeModal" class="modal-overlay" style="display:none;">
    <div class="modal glass" style="max-width:420px; margin:10vh auto; padding:1.5rem; border-radius:12px;">
      <h3>Add New Café</h3>
      <form id="addCafeForm">
        <label>Café Name <input type="text" id="newCafeName" required /></label>
        <label>URL Slug <input type="text" id="newCafeSlug" placeholder="e.g. blue-tokai-nashik" required /></label>
        <label>Owner Name <input type="text" id="newCafeOwnerName" /></label>
        <label>Owner Email <input type="email" id="newCafeOwnerEmail" /></label>
        <div style="display:flex; gap:0.5rem; margin-top:1rem;">
          <button type="submit" class="btn btn-primary">Create</button>
          <button type="button" class="btn btn-ghost" id="cancelAddCafeBtn">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <div id="newCafeCredentialsModal" class="modal-overlay" style="display:none;">
    <div class="modal glass" style="max-width:420px; margin:10vh auto; padding:1.5rem; border-radius:12px;">
      <h3>Café Created</h3>
      <p>Share these details with the café owner. The admin key is shown only once.</p>
      <p><strong>Slug:</strong> <span id="newCafeSlugDisplay"></span></p>
      <p><strong>Admin Key:</strong> <code id="newCafeKeyDisplay"></code></p>
      <button class="btn btn-primary" id="closeCredentialsModalBtn">Done</button>
    </div>
  </div>

  <script src="/js/super-admin.js"></script>
</body>
</html>
```

## TASK 2.3 — Café detail page

Create `public/super-admin-cafe-detail.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Super Admin — Café Detail</title>
  <link rel="stylesheet" href="/css/admin.css" />
</head>
<body>
  <div class="admin-topbar">
    <a href="/super-admin-dashboard.html" class="btn btn-ghost">← Back to Dashboard</a>
    <button class="btn btn-ghost" id="logoutBtn">Log Out</button>
  </div>

  <div id="cafeDetailContent">
    <p class="empty-state">Loading café details…</p>
  </div>

  <script src="/js/super-admin-detail.js"></script>
</body>
</html>
```

## TASK 2.4 — Shared JS: super-admin.js (dashboard logic)

Create `public/js/super-admin.js`:

```js
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
```

## TASK 2.5 — Café detail page logic: super-admin-detail.js

Create `public/js/super-admin-detail.js`:

```js
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
```

---

# PART 3 — FRONTEND WIRING: cafeSlug ON CUSTOMER-FACING PAGES

## DESIGN DECISION FOR THIS PROJECT'S CURRENT SCALE

Since this project currently serves exactly one café, the simplest
correct approach is: hardcode that café's slug as a single configurable
constant in the customer-facing JS, rather than rebuilding the entire
URL structure to support `/cafe-crafted/menu` style routing right now.
This keeps today's behavior working unchanged, while the backend (Part
A) is already fully ready for real per-café URLs whenever that becomes
necessary for a second café.

## TASK 3.1 — Add a single config constant

In `public/js/utils.js`, near the top, add:

```js
// This café's slug, used to scope every API call to the correct
// tenant in the database. When this project grows to serve multiple
// cafés from one deployment, this becomes dynamic (e.g. read from a
// subdomain or URL path) instead of a fixed constant.
const CAFE_SLUG = "cafe-crafted";

function withCafeSlug(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cafeSlug=${encodeURIComponent(CAFE_SLUG)}`;
}
```

## TASK 3.2 — Apply withCafeSlug() to every public API call

Go through `public/js/home.js`, `public/js/menu.js`, `public/js/cart.js`,
`public/js/orders.js`, and `public/js/utils.js` itself
(`ensureTableSession`). Find every `fetch(...)` call that hits a public
(non-admin) endpoint, and wrap the URL with `withCafeSlug(...)`:

```js
// BEFORE:
const res = await fetch("/api/cafe");

// AFTER:
const res = await fetch(withCafeSlug("/api/cafe"));
```

Apply this to: `/api/cafe`, `/api/menu`, `/api/table/verify` (this one
already has a `?t=` query param — `withCafeSlug` correctly detects the
existing `?` and uses `&` instead), `/api/orders` (POST and GET by id),
`/api/waiter-call` (POST).

Do NOT apply this to any `/api/admin/*` or `/api/super-admin/*` calls —
those are scoped by admin key / super-admin key instead, not by slug.

---

## WHAT NOT TO DO IN THIS PROMPT

- Do not build real subdomain or path-based multi-café routing for the
  customer-facing site — that's deliberately deferred until a second
  café actually exists, per the design decision in Part 3
- Do not remove the existing single-café admin panel (`admin.html`) —
  café owners keep using it exactly as before, just now scoped by their
  own café's admin key instead of the old global password
- Do not expose any café's `admin_key` in any list-view API response —
  only return it once, at creation time or reset time, directly to the
  super admin

---

## HOW TO VERIFY THIS PART WORKS

1. Restart the server: `npm run dev`
2. Visit `/super-admin-login.html`, log in with `SUPER_ADMIN_PASSWORD`
3. Dashboard loads — should show 1 café ("Cafe Crafted"), with today's
   real order count and revenue
4. Click "View" on that café — detail page shows real stats: all-time
   orders, this month's orders, table count, menu item count, recent
   orders list
5. Click "+ Add New Café" — fill in a test café, submit — confirm a new
   row appears in the `cafes` table, with 4 starter tables auto-created
6. Copy the generated admin key shown in the success modal — confirm it
   logs into `/admin.html` correctly for THIS NEW café only, showing an
   empty dashboard (no orders, no menu items yet) — completely separate
   from "Cafe Crafted"'s data
7. Back in super admin, click "Deactivate" on the test café — confirm
   its admin key no longer logs in afterward (`requireAdmin` should
   reject it once `is_active = false`, if not already explicit, add a
   check for this in `getCafeByAdminKey` usage as a quick follow-up fix)
8. Visit the actual customer-facing site (`index.html`) — confirm
   everything still works exactly as before (menu loads, ordering works)
   — this confirms the `cafeSlug` wiring didn't break the existing
   experience

---

## SESSION CONTINUITY NOTE

This completes the Super Admin feature for a single deployed instance
serving one or more cafés from one shared codebase and database. The
next natural step, when you're ready, is GitHub + Render deployment —
a separate, focused prompt, since it's an operations task rather than a
feature-building one.

---

## END OF PART B
# ─────────────────────────────────────────────────────────────────────
