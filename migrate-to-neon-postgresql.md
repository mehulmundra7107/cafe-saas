# CAFE PROJECT — MIGRATE FROM store.json TO REAL POSTGRESQL (NEON)
# Paste this entire file into Cursor / Antigravity / Claude Code
# This works on your EXISTING, working codebase. Nothing about the
# customer experience, security, or admin features changes — only
# WHERE the data lives changes, from a JSON file to a real database.
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior backend engineer who specializes in careful, zero-downtime
data migrations. You do not rewrite working logic. You do not change route
URLs, request/response shapes, or frontend code unless explicitly told to.
Your job in this prompt is precise: move the data layer from a flat JSON
file to PostgreSQL, while every existing route continues to behave
EXACTLY as it does today from the frontend's point of view.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement every task in the exact order
listed below, and verify each one before moving to the next.

---

## CURRENT STATE OF THIS PROJECT — READ CAREFULLY

This is a real, working café ordering app. Plain Node.js + Express +
vanilla JS frontend. All data currently lives in one file:
`server/data/store.json`, shaped exactly like this:

```json
{
  "cafeInfo": {
    "name": "Cafe Crafted",
    "introShort": "...",
    "introFull": "...",
    "contact": { "phone": "...", "email": "...", "address": "...", "hours": "..." }
  },
  "heroPhotos": ["photo-01.jpeg", "photo-02.jpeg", ...],
  "menuItems": [
    {
      "id": "m1",
      "name": "Caramel Latte",
      "price": 4.5,
      "description": "Rich espresso with steamed milk and caramel drizzle.",
      "image": "photo-03.jpeg",
      "category": "Beverages",
      "available": true,
      "inStock": false
    }
  ],
  "tables": [
    {
      "id": "1",
      "label": "Table 1",
      "tokenVersion": 2,
      "status": "occupied",
      "sessionId": "af6ab245-...",
      "claimedAt": "2026-06-24T11:30:24.221Z",
      "lastActivityAt": "2026-06-24T11:55:33.504Z"
    }
  ],
  "orders": [
    {
      "id": "87ac757e-...",
      "tableNumber": "1",
      "items": [
        { "id": "m1", "name": "Caramel Latte", "price": 4.5, "image": "/photos/photo-03.jpeg", "quantity": 1, "customNote": "" }
      ],
      "status": "ready",
      "total": 13.49,
      "createdAt": "2026-06-24T11:38:50.094Z",
      "updatedAt": "2026-06-24T11:39:15.827Z"
    }
  ],
  "waiterCalls": [
    {
      "id": "f82a5d73-...",
      "tableNumber": "1",
      "orderId": "82af3b1a-...",
      "createdAt": "2026-06-21T11:41:45.449Z",
      "resolved": true
    }
  ]
}
```

This project ALREADY has working: real signed table-token security
(HMAC, `signTableToken`/`verifyTableToken`), single-device table
occupancy locking with auto-expiry, real-time order/waiter-call updates
via Socket.io, full menu CRUD with image uploads, and a date-filtered
order history with CSV/PDF export. None of this logic is broken or
incomplete — you are not fixing bugs, you are relocating storage.

This project ALREADY has `pg` and `dotenv` installed in `package.json`,
and a working `.env` file at the project root containing a real,
verified `DATABASE_URL` pointing to a live Neon Postgres database
(already tested successfully with a standalone connection script —
the connection itself is confirmed working before this prompt begins).

You are NOT setting up Neon. You are NOT writing connection test scripts.
You are building the real schema and rewiring the existing app to use it.

---

## THE GOLDEN RULE FOR THIS ENTIRE PROMPT

Every existing API route's URL, HTTP method, request body shape, and
response JSON shape must stay IDENTICAL to what it is today. The
frontend (`public/js/*.js`) must NOT need any changes for Parts A through
D below. You are replacing what's behind `readStore()` and `writeStore()`
— not what the routes look like from outside. If you find yourself
wanting to change a response shape "to make it cleaner," do not — match
the existing shape exactly, even if it feels less elegant than a fresh
design would be. Consistency with the working frontend matters more than
elegance here.

---

# PART A — CREATE THE REAL DATABASE SCHEMA

## TASK A1 — Write the schema as a SQL file

Create `server/db/schema.sql`. This defines every table, matching the
existing JSON shapes as closely as SQL allows, while adding proper types
and constraints SQL gives us for free.

```sql
-- ───────────────────────────────────────────────────────────
-- CAFE INFO (single row — this project serves exactly one café
-- for now; the table is still structured to add more rows later
-- without changing its shape)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cafe_info (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  intro_short   TEXT,
  intro_full    TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  hours         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────
-- HERO PHOTOS (ordered list of filenames used on the landing page)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hero_photos (
  id            SERIAL PRIMARY KEY,
  filename      TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────
-- MENU ITEMS
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id            TEXT PRIMARY KEY,        -- keep existing string IDs like "m1" as-is
  name          TEXT NOT NULL,
  price         NUMERIC(10, 2) NOT NULL,
  description   TEXT,
  image         TEXT,                    -- filename only, same as current JSON
  category      TEXT NOT NULL DEFAULT 'General',
  available     BOOLEAN NOT NULL DEFAULT true,
  in_stock      BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────
-- TABLES (physical café tables + their security/occupancy state)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cafe_tables (
  id                TEXT PRIMARY KEY,    -- keep existing string IDs like "1", "2"
  label             TEXT NOT NULL,
  token_version     INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'occupied')),
  session_id        TEXT,
  claimed_at        TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ
);

-- ───────────────────────────────────────────────────────────
-- ORDERS
-- The "items" array is stored as JSONB — this is intentional, not
-- a shortcut. The existing app already treats order items as an
-- immutable snapshot taken at order time (name, price, and image
-- are copied at the moment of ordering, not looked up live from
-- menu_items later). JSONB preserves this exact existing behavior
-- with zero application logic changes, while still being queryable
-- with Postgres's JSONB operators if ever needed later.
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,        -- keep existing UUID strings as-is
  table_number  TEXT NOT NULL,
  items         JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected', 'preparing', 'ready')),
  total         NUMERIC(10, 2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- This index is the entire reason today's history/calendar/report
-- feature works fast — every one of those queries filters by date range.
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_table_number ON orders (table_number);

-- ───────────────────────────────────────────────────────────
-- WAITER CALLS
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waiter_calls (
  id            TEXT PRIMARY KEY,
  table_number  TEXT NOT NULL,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  resolved      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waiter_calls_resolved ON waiter_calls (resolved);
```

Note what is deliberately NOT here: no `cafe_id` column anywhere, no
multi-tenant structure yet. This schema represents exactly one café —
the one this project already serves. Multi-tenancy (the Super Admin
work) is a clean, separate next step built on top of this, once this
migration is verified solid. Do not add `cafe_id` columns in this prompt.

---

## TASK A2 — Write a script that applies the schema to Neon

Create `server/db/migrate.js`:

```js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runMigration() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");

  console.log("Applying schema to database...");
  try {
    await pool.query(schema);
    console.log("✅ Schema applied successfully.");
  } catch (err) {
    console.error("❌ Failed to apply schema:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
```

Add a script entry to `package.json`:
```json
"scripts": {
  "start": "node server/server.js",
  "dev": "node server/server.js",
  "db:migrate": "node server/db/migrate.js",
  "db:seed-from-json": "node server/db/migrate-data-from-json.js"
}
```

---

# PART B — BUILD THE DATA-ACCESS LAYER (db.js)

## TASK B1 — Create a single connection pool module

Create `server/db/pool.js`:

```js
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
});

module.exports = pool;
```

---

## TASK B2 — Build data-access functions that mirror the existing JSON shapes exactly

Create `server/db/store.js`. This file's exported functions are designed
to be drop-in replacements for what `readStore()` / `writeStore()`
currently provide — but as targeted, specific functions instead of one
big object, since reading/writing the ENTIRE database on every call (the
way the JSON file did) is not how a database should be used.

This is the most important file in this entire migration. Read it
carefully — every function here maps to a specific piece of the existing
`store.json` structure, converting between JS's `camelCase` (used
throughout the existing app) and Postgres's `snake_case` (the SQL
convention used in the schema above).

```js
const pool = require("./pool");

// ─── CAFE INFO ───────────────────────────────────────────────

async function getCafeInfo() {
  const { rows } = await pool.query("SELECT * FROM cafe_info ORDER BY id LIMIT 1");
  if (!rows.length) return null;
  const r = rows[0];
  return {
    name: r.name,
    introShort: r.intro_short,
    introFull: r.intro_full,
    contact: {
      phone: r.phone,
      email: r.email,
      address: r.address,
      hours: r.hours,
    },
  };
}

async function updateCafeInfo(partialInfo) {
  const current = await getCafeInfo();
  const merged = { ...current, ...partialInfo };
  const contact = { ...current?.contact, ...partialInfo?.contact };

  await pool.query(
    `UPDATE cafe_info SET
      name = $1, intro_short = $2, intro_full = $3,
      phone = $4, email = $5, address = $6, hours = $7,
      updated_at = NOW()
     WHERE id = (SELECT id FROM cafe_info ORDER BY id LIMIT 1)`,
    [merged.name, merged.introShort, merged.introFull, contact.phone, contact.email, contact.address, contact.hours]
  );
  return getCafeInfo();
}

// ─── HERO PHOTOS ─────────────────────────────────────────────

async function getHeroPhotos() {
  const { rows } = await pool.query("SELECT filename FROM hero_photos ORDER BY display_order ASC, id ASC");
  return rows.map((r) => r.filename);
}

async function addHeroPhoto(filename) {
  const { rows } = await pool.query("SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM hero_photos");
  await pool.query(
    "INSERT INTO hero_photos (filename, display_order) VALUES ($1, $2)",
    [filename, rows[0].next]
  );
}

async function removeHeroPhoto(filename) {
  await pool.query("DELETE FROM hero_photos WHERE filename = $1", [filename]);
}

// ─── MENU ITEMS ──────────────────────────────────────────────

function mapMenuItemRow(r) {
  return {
    id: r.id,
    name: r.name,
    price: parseFloat(r.price),
    description: r.description,
    image: r.image,
    category: r.category,
    available: r.available,
    inStock: r.in_stock,
  };
}

async function getMenuItems() {
  const { rows } = await pool.query("SELECT * FROM menu_items ORDER BY created_at ASC");
  return rows.map(mapMenuItemRow);
}

async function getMenuItemById(id) {
  const { rows } = await pool.query("SELECT * FROM menu_items WHERE id = $1", [id]);
  return rows.length ? mapMenuItemRow(rows[0]) : null;
}

async function createMenuItem(item) {
  const { rows } = await pool.query(
    `INSERT INTO menu_items (id, name, price, description, image, category, available, in_stock)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [item.id, item.name, item.price, item.description, item.image, item.category, item.available, item.inStock]
  );
  return mapMenuItemRow(rows[0]);
}

async function updateMenuItem(id, fields) {
  const existing = await getMenuItemById(id);
  if (!existing) return null;
  const merged = { ...existing, ...fields };

  const { rows } = await pool.query(
    `UPDATE menu_items SET
      name = $1, price = $2, description = $3, image = $4,
      category = $5, available = $6, in_stock = $7, updated_at = NOW()
     WHERE id = $8 RETURNING *`,
    [merged.name, merged.price, merged.description, merged.image, merged.category, merged.available, merged.inStock, id]
  );
  return mapMenuItemRow(rows[0]);
}

async function deleteMenuItem(id) {
  const { rowCount } = await pool.query("DELETE FROM menu_items WHERE id = $1", [id]);
  return rowCount > 0;
}

// ─── TABLES ──────────────────────────────────────────────────

function mapTableRow(r) {
  return {
    id: r.id,
    label: r.label,
    tokenVersion: r.token_version,
    status: r.status,
    sessionId: r.session_id,
    claimedAt: r.claimed_at ? r.claimed_at.toISOString() : null,
    lastActivityAt: r.last_activity_at ? r.last_activity_at.toISOString() : null,
  };
}

async function getTables() {
  const { rows } = await pool.query("SELECT * FROM cafe_tables ORDER BY id ASC");
  return rows.map(mapTableRow);
}

async function getTableById(id) {
  const { rows } = await pool.query("SELECT * FROM cafe_tables WHERE id = $1", [id]);
  return rows.length ? mapTableRow(rows[0]) : null;
}

async function createTable(table) {
  const { rows } = await pool.query(
    `INSERT INTO cafe_tables (id, label, token_version, status)
     VALUES ($1, $2, 1, 'free') RETURNING *`,
    [table.id, table.label]
  );
  return mapTableRow(rows[0]);
}

async function updateTable(id, fields) {
  const existing = await getTableById(id);
  if (!existing) return null;
  const merged = { ...existing, ...fields };

  const { rows } = await pool.query(
    `UPDATE cafe_tables SET
      label = $1, token_version = $2, status = $3,
      session_id = $4, claimed_at = $5, last_activity_at = $6
     WHERE id = $7 RETURNING *`,
    [merged.label, merged.tokenVersion, merged.status, merged.sessionId, merged.claimedAt, merged.lastActivityAt, id]
  );
  return mapTableRow(rows[0]);
}

// ─── ORDERS ──────────────────────────────────────────────────

function mapOrderRow(r) {
  return {
    id: r.id,
    tableNumber: r.table_number,
    items: r.items, // JSONB comes back already parsed as a JS array
    status: r.status,
    total: parseFloat(r.total),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

async function createOrder(order) {
  const { rows } = await pool.query(
    `INSERT INTO orders (id, table_number, items, status, total, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [order.id, order.tableNumber, JSON.stringify(order.items), order.status, order.total, order.createdAt]
  );
  return mapOrderRow(rows[0]);
}

async function getOrderById(id) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  return rows.length ? mapOrderRow(rows[0]) : null;
}

async function updateOrderStatus(id, status) {
  const { rows } = await pool.query(
    "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [status, id]
  );
  return rows.length ? mapOrderRow(rows[0]) : null;
}

// Mirrors the existing date-filtering behavior from server.js exactly —
// same three modes (range / date / from+to), just expressed as SQL
// instead of filtering a JS array in memory.
async function getOrdersInRange(startDate, endDate) {
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC",
    [startDate, endDate]
  );
  return rows.map(mapOrderRow);
}

async function getDistinctOrderDates(monthPrefix) {
  const { rows } = await pool.query(
    `SELECT DISTINCT TO_CHAR(created_at, 'YYYY-MM-DD') AS day FROM orders
     ${monthPrefix ? "WHERE TO_CHAR(created_at, 'YYYY-MM') = $1" : ""}
     ORDER BY day ASC`,
    monthPrefix ? [monthPrefix] : []
  );
  return rows.map((r) => r.day);
}

async function getAllOrdersForExport() {
  // used by CSV/PDF export after the date-range query already narrowed
  // things down — kept separate from getOrdersInRange for clarity of intent
  const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
  return rows.map(mapOrderRow);
}

// ─── WAITER CALLS ────────────────────────────────────────────

function mapWaiterCallRow(r) {
  return {
    id: r.id,
    tableNumber: r.table_number,
    orderId: r.order_id,
    createdAt: r.created_at.toISOString(),
    resolved: r.resolved,
  };
}

async function createWaiterCall(call) {
  const { rows } = await pool.query(
    `INSERT INTO waiter_calls (id, table_number, order_id, resolved, created_at)
     VALUES ($1, $2, $3, false, $4) RETURNING *`,
    [call.id, call.tableNumber, call.orderId, call.createdAt]
  );
  return mapWaiterCallRow(rows[0]);
}

async function getUnresolvedWaiterCalls() {
  const { rows } = await pool.query("SELECT * FROM waiter_calls WHERE resolved = false ORDER BY created_at DESC");
  return rows.map(mapWaiterCallRow);
}

async function resolveWaiterCall(id) {
  const { rows } = await pool.query(
    "UPDATE waiter_calls SET resolved = true WHERE id = $1 RETURNING *",
    [id]
  );
  return rows.length ? mapWaiterCallRow(rows[0]) : null;
}

module.exports = {
  getCafeInfo, updateCafeInfo,
  getHeroPhotos, addHeroPhoto, removeHeroPhoto,
  getMenuItems, getMenuItemById, createMenuItem, updateMenuItem, deleteMenuItem,
  getTables, getTableById, createTable, updateTable,
  createOrder, getOrderById, updateOrderStatus, getOrdersInRange, getDistinctOrderDates, getAllOrdersForExport,
  createWaiterCall, getUnresolvedWaiterCalls, resolveWaiterCall,
};
```

---

# PART C — WRITE THE ONE-TIME DATA MIGRATION SCRIPT

## TASK C1 — Migrate existing store.json data into Postgres

Create `server/db/migrate-data-from-json.js`. This is a ONE-TIME script
you run manually, once, to copy everything currently in `store.json`
into the new database. It does not touch or delete `store.json` — it
only reads from it and writes copies into Postgres.

```js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

const DATA_FILE = path.join(__dirname, "..", "data", "store.json");

async function migrate() {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const store = JSON.parse(raw);

  console.log("Starting migration from store.json into Postgres...\n");

  // 1. Cafe info — insert as the single row, only if the table is empty
  const { rows: existingCafe } = await pool.query("SELECT id FROM cafe_info LIMIT 1");
  if (existingCafe.length === 0 && store.cafeInfo) {
    await pool.query(
      `INSERT INTO cafe_info (name, intro_short, intro_full, phone, email, address, hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        store.cafeInfo.name,
        store.cafeInfo.introShort,
        store.cafeInfo.introFull,
        store.cafeInfo.contact?.phone,
        store.cafeInfo.contact?.email,
        store.cafeInfo.contact?.address,
        store.cafeInfo.contact?.hours,
      ]
    );
    console.log("✅ Migrated cafe_info");
  } else {
    console.log("↪ cafe_info already has data, skipping");
  }

  // 2. Hero photos
  let heroCount = 0;
  for (let i = 0; i < (store.heroPhotos || []).length; i++) {
    const filename = store.heroPhotos[i];
    await pool.query(
      `INSERT INTO hero_photos (filename, display_order) VALUES ($1, $2)
       ON CONFLICT (filename) DO NOTHING`,
      [filename, i]
    );
    heroCount++;
  }
  console.log(`✅ Migrated ${heroCount} hero photos`);

  // 3. Menu items
  let menuCount = 0;
  for (const item of store.menuItems || []) {
    await pool.query(
      `INSERT INTO menu_items (id, name, price, description, image, category, available, in_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.name, item.price, item.description, item.image, item.category, item.available !== false, item.inStock !== false]
    );
    menuCount++;
  }
  console.log(`✅ Migrated ${menuCount} menu items`);

  // 4. Tables (security/occupancy state included, exactly as-is)
  let tableCount = 0;
  for (const table of store.tables || []) {
    await pool.query(
      `INSERT INTO cafe_tables (id, label, token_version, status, session_id, claimed_at, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [table.id, table.label, table.tokenVersion || 1, table.status || "free", table.sessionId, table.claimedAt, table.lastActivityAt]
    );
    tableCount++;
  }
  console.log(`✅ Migrated ${tableCount} tables`);

  // 5. Orders — must run BEFORE waiter calls, since waiter_calls.order_id
  //    has a foreign key reference to orders.id
  let orderCount = 0;
  for (const order of store.orders || []) {
    await pool.query(
      `INSERT INTO orders (id, table_number, items, status, total, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [order.id, order.tableNumber, JSON.stringify(order.items), order.status, order.total, order.createdAt, order.updatedAt]
    );
    orderCount++;
  }
  console.log(`✅ Migrated ${orderCount} orders`);

  // 6. Waiter calls
  let callCount = 0;
  for (const call of store.waiterCalls || []) {
    await pool.query(
      `INSERT INTO waiter_calls (id, table_number, order_id, resolved, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [call.id, call.tableNumber, call.orderId, call.resolved, call.createdAt]
    );
    callCount++;
  }
  console.log(`✅ Migrated ${callCount} waiter calls`);

  console.log("\n🎉 Migration complete. store.json was not modified or deleted.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
```

This script uses `ON CONFLICT (id) DO NOTHING` everywhere, which makes
it safe to re-run if something goes wrong partway — already-migrated
rows are simply skipped, not duplicated or errored on.

---

# PART D — REWIRE server.js TO USE THE DATABASE

## DESIGN PRINCIPLE FOR THIS PART

Go through `server/server.js` route by route. For each route, replace
calls to `readStore()` / `writeStore()` with the equivalent function
from `server/db/store.js`. The route handler becomes `async` (it wasn't
before, since file reads were synchronous — database calls are not).
The response sent to the frontend must look IDENTICAL to before.

## TASK D1 — Replace the top-level requires

At the top of `server.js`, add:
```js
const db = require("./db/store");
```

Do NOT remove `readStore()` / `writeStore()` yet — some routes (table
token verification, occupancy claiming) reference them directly and need
careful, individual conversion. Removing them prematurely will break
things mid-edit. Remove them only after every single route below has
been converted and verified.

## TASK D2 — Convert each route, in this exact order

**`GET /api/cafe`** — replace body with:
```js
app.get("/api/cafe", async (req, res) => {
  const cafeInfo = await db.getCafeInfo();
  const heroPhotos = await db.getHeroPhotos();
  res.json({
    cafeInfo,
    heroPhotos: heroPhotos.map((p) => `/photos/${p}`),
  });
});
```

**`GET /api/menu`** — replace body with:
```js
app.get("/api/menu", async (req, res) => {
  const items = await db.getMenuItems();
  const available = items
    .filter((i) => i.available !== false)
    .map((item) => ({
      ...item,
      image: item.image.startsWith("/") ? item.image : resolveImageUrl(item.image),
    }));
  res.json(available);
});
```

**`verifyTableToken(token)`** — keep the signature verification logic
(crypto, base64url decode) EXACTLY as is. Only change the one line that
looks up the table:
```js
// BEFORE:
// const store = readStore();
// const table = (store.tables || []).find((t) => t.id === tableId);

// AFTER — this function must become async, and every caller of it
// must now use `await verifyTableToken(...)`:
async function verifyTableToken(token) {
  // ... keep all the signature checking exactly as is ...

  const table = await db.getTableById(tableId);

  if (!table) {
    return { valid: false, reason: "This table does not exist" };
  }

  if (String(table.tokenVersion) !== tokenVersionStr) {
    return {
      valid: false,
      reason: "This QR code has been reset and is no longer valid. Please ask staff for the current QR code.",
    };
  }

  return { valid: true, tableId, table };
}
```
Find every place in `server.js` that calls `verifyTableToken(...)` and
add `await` in front of it, and make sure the enclosing route handler is
declared `async`.

**`claimTable(tableId, existingSessionId)`** — same treatment, becomes
async, replace the `readStore()`/table lookup with `await db.getTableById(tableId)`,
and `acceptClaim` becomes:
```js
async function acceptClaim(table, sessionId) {
  const updated = await db.updateTable(table.id, {
    status: "occupied",
    sessionId,
    claimedAt: table.claimedAt || new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  });
  return { ok: true, sessionId, tableId: updated.id, label: updated.label };
}
```
Update `claimTable` to be `async` and `await` this call, removing the
`store` parameter since `acceptClaim` no longer needs a JSON store
object passed in.

**`touchTableActivity(tableId, sessionId)`** becomes:
```js
async function touchTableActivity(tableId, sessionId) {
  const table = await db.getTableById(tableId);
  if (table && table.sessionId === sessionId) {
    await db.updateTable(tableId, { lastActivityAt: new Date().toISOString() });
  }
}
```
Add `await` everywhere this is called.

**`GET /api/table/verify`** — add `async`, `await` the now-async
`verifyTableToken` and `claimTable` calls. Response shape unchanged.

**`POST /api/orders`** — add `async`. Replace:
```js
const store = readStore();
const table = (store.tables || []).find((t) => t.id === verification.tableId);
```
with:
```js
const table = await db.getTableById(verification.tableId);
```
Replace the stock-check loop's `store.menuItems.find(...)` with
`await db.getMenuItemById(item.id)` per item. Replace the final
`store.orders.unshift(order); writeStore(store);` with:
```js
const savedOrder = await db.createOrder(order);
```
and emit/return `savedOrder` instead of the local `order` variable, to
ensure the emitted/returned object reflects exactly what's now in the
database (timestamps formatted consistently, etc).

**`GET /api/orders/:id`** — add `async`, replace body with
`const order = await db.getOrderById(req.params.id);`.

**`POST /api/waiter-call`** — same pattern as orders: add `async`,
replace the table lookup with `db.getTableById`, replace
`store.waiterCalls.unshift(call); writeStore(store);` with
`const savedCall = await db.createWaiterCall(call);`, emit/return
`savedCall`.

**`POST /api/admin/tables/:id/release`** — add `async`, replace body with:
```js
app.post("/api/admin/tables/:id/release", requireAdmin, async (req, res) => {
  const table = await db.getTableById(req.params.id);
  if (!table) return res.status(404).json({ error: "Table not found" });

  const updated = await db.updateTable(table.id, {
    status: "free", sessionId: null, claimedAt: null, lastActivityAt: null,
  });

  emitAll("table:released", { id: updated.id });
  res.json(updated);
});
```

**`POST /api/admin/tables/:id/reset-qr`** — add `async`, replace table
lookup/update with `db.getTableById` / `db.updateTable(table.id, { tokenVersion: table.tokenVersion + 1 })`,
keep the `signTableToken` call and response shape exactly as-is.

**`POST /api/admin/tables`** (create new table) — add `async`, replace
the existence check with `await db.getTableById(id)`, replace the insert
with `await db.createTable({ id, label })`.

**`GET /api/admin/tables`** — add `async`, replace `readStore().tables`
with `await db.getTables()`. Also DELETE the stale defensive comment
and fallback that currently reads:
```js
// Fallback for signTableToken since Part A is missing
const token = typeof signTableToken === "function" ? signTableToken(table.id, table.tokenVersion) : table.id;
```
Replace with simply:
```js
const token = signTableToken(table.id, table.tokenVersion);
```
(`signTableToken` has existed and worked correctly for a while now —
this fallback was leftover from an earlier incomplete state and should
be cleaned up as part of this migration.)

**`GET /api/admin/orders`** (date-filtered list) — add `async`, replace
the in-memory filter with `await db.getOrdersInRange(start, end)`. Keep
all the existing `getQuickRangeBounds` / `parseDateOnly` / `endOfDay`
helper functions EXACTLY as they are — they compute date boundaries in
JS, which is unrelated to where the actual order rows are stored, and
continue to work identically against the new SQL-backed function.

**`GET /api/admin/orders/active-dates`** — add `async`, replace the
in-memory date-distinctness logic with `await db.getDistinctOrderDates(month)`.

**`GET /api/admin/orders/export.csv`** and **`export.pdf`** — these call
the existing `getFilteredOrders(req)` helper. Update that helper to be
`async` and use `await db.getOrdersInRange(start, end)` instead of
filtering `readStore().orders` in memory. `computeOrderReport(orders)`
itself needs NO changes — it already just takes a plain array of order
objects and computes aggregates; it doesn't care where that array came
from.

**`PATCH /api/admin/orders/:id`** — add `async`, replace with:
```js
app.patch("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!["accepted", "rejected", "preparing", "ready"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const updated = await db.updateOrderStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ error: "Order not found" });

  emitAll("order:updated", updated);
  res.json(updated);
});
```

**`GET /api/admin/waiter-calls`** — add `async`, replace with
`const calls = await db.getUnresolvedWaiterCalls(); res.json(calls);`

**`PATCH /api/admin/waiter-calls/:id`** — add `async`, replace with:
```js
app.patch("/api/admin/waiter-calls/:id", requireAdmin, async (req, res) => {
  const updated = await db.resolveWaiterCall(req.params.id);
  if (!updated) return res.status(404).json({ error: "Not found" });
  emitAll("waiter:resolved", updated);
  res.json(updated);
});
```

**`GET /api/admin/menu`** — add `async`, replace with
`const items = await db.getMenuItems();` then map exactly as before for
image URL resolution.

**`POST /api/admin/menu`** — add `async`, build the `item` object
exactly as today, then replace `store.menuItems.push(item); writeStore(store);`
with `const saved = await db.createMenuItem(item);`. Emit/return `saved`.

**`PUT /api/admin/menu/:id`** — add `async`, replace the find/mutate
pattern with `await db.updateMenuItem(req.params.id, { name, price, description, category, available, inStock, image })`
— pass only the fields that were actually provided in `req.body`/`req.file`,
same conditional logic as today, just building a `fields` object instead
of mutating a found object directly.

**`DELETE /api/admin/menu/:id`** — add `async`, replace with
`const deleted = await db.deleteMenuItem(req.params.id); if (!deleted) return res.status(404)...`

**`GET /api/admin/cafe`** — add `async`, replace with
`db.getCafeInfo()` + `db.getHeroPhotos()`, same response shape as
`GET /api/cafe`'s admin equivalent.

**`PUT /api/admin/cafe`** — add `async`, replace with
`const updated = await db.updateCafeInfo(req.body.cafeInfo);`

**`GET /api/admin/hero-photos`** — add `async`, replace with
`const photos = await db.getHeroPhotos(); res.json(photos);`

**`POST /api/admin/hero-photos`** — add `async`, after the file upload
succeeds, replace `store.heroPhotos.push(...); writeStore(store);` with
`await db.addHeroPhoto(req.file.filename);`

**`DELETE /api/admin/hero-photos/:filename`** — add `async`, replace
with `await db.removeHeroPhoto(req.params.filename);`, keep the actual
file-deletion (`fs.unlinkSync`) logic exactly as is — that part is
unrelated to the database.

## TASK D3 — Remove the now-unused JSON functions

Once every single route above is converted and verified working, delete
`readStore()` and `writeStore()` from `server.js` entirely, along with
the `DATA_FILE` constant. Do this LAST, only after manual testing
confirms every route works — not as part of the route-by-route edits
above, to avoid breaking routes you haven't converted yet mid-process.

---

## WHAT NOT TO DO IN THIS PROMPT

- Do not change any frontend file in `public/` — none of this requires
  frontend changes, since response shapes are preserved exactly
- Do not add a `cafe_id` column or any multi-tenant structure — that is
  explicitly out of scope here, coming in a later, separate prompt
- Do not delete `server/data/store.json` — leave it on disk as a backup,
  just unused, after this migration is verified working
- Do not change table/column names from what's specified above once
  written — if you need to rename something mid-implementation, also
  update every reference, do not leave a mismatch
- Do not skip the `ON CONFLICT DO NOTHING` clauses in the migration
  script — they are what make it safe to re-run

---

## HOW TO RUN AND VERIFY THIS MIGRATION

Run these commands, in this exact order, from the project root:

```bash
# 1. Create all tables in Neon (safe to re-run — uses IF NOT EXISTS)
npm run db:migrate

# 2. Copy existing store.json data into those tables (safe to re-run —
#    uses ON CONFLICT DO NOTHING)
npm run db:seed-from-json

# 3. Start the server as normal
npm run dev
```

Then verify, using your existing running app exactly as before:

1. Open the customer site — café info, hero photos, and menu should
   load identically to before
2. Scan/open a table's real QR URL — should verify and claim normally
3. Place a test order — should succeed, appear in the database
4. Open the admin panel — orders, menu, tables, waiter calls should all
   display exactly as before, with all 120 existing orders still visible
   in the "This Month" filter
5. Try resetting a table's QR — should still correctly invalidate the
   old one
6. Export a CSV and PDF report for "This Month" — totals should match
   what existed in `store.json` before migration (spot check a few
   numbers against the original file to confirm nothing was lost)
7. Restart the server entirely (`Ctrl+C`, then `npm run dev` again) —
   confirm all data persists (this is now true because it's in a real
   database, not dependent on the server process keeping a file in sync)

If anything doesn't match pre-migration behavior, do not patch around it
in the frontend — find which converted route or db.js function has a
mismatched response shape and fix it there.

---

## SESSION CONTINUITY — SAVE THIS SUMMARY

When complete, write a summary covering:
- Confirm all 5 tables exist in Neon with the exact row counts migrated
  (cafe_info: 1, hero_photos: 13, menu_items: 7, cafe_tables: 12,
  orders: 120, waiter_calls: 8 — or whatever the actual current counts
  are at migration time)
- Confirm every route in `server.js` is now `async` and uses `db.js`,
  with zero remaining calls to `readStore()`/`writeStore()`
- Confirm the frontend was not modified at all
- Note that `server/data/store.json` remains on disk, untouched, unused

This summary becomes the foundation for the next prompt: building the
Super Admin layer, which will now be straightforward — just SQL queries
across café data, with a real `cafes` table added on top of everything
built here.

---

## END OF PROMPT
# ─────────────────────────────────────────────────────────────────────
