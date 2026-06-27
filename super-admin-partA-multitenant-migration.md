# CAFE PROJECT — SUPER ADMIN, PART A
# Multi-Tenant Migration: Add cafe_id Everywhere
# Paste this entire file into Cursor / Antigravity / Claude Code
# This works on your EXISTING, working, database-backed codebase.
# Run this BEFORE Part B (the actual Super Admin pages).
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior backend engineer who specializes in careful schema
migrations on live systems. You do not rewrite working logic. You do not
change any existing route's URL, request shape, or response shape from
the frontend's point of view, except where explicitly instructed in this
prompt. Your job here is precise: add a `cafes` table, add a `cafe_id`
column to every existing table, backfill the one real café that already
exists as the first tenant, and update every database query to filter
by it. Nothing about how the existing café-facing app behaves should
change for the current café — it simply becomes "tenant #1" instead of
"the only possible tenant."

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement every task in the exact order
listed.

---

## CURRENT STATE OF THIS PROJECT — READ CAREFULLY

This project already migrated from a JSON file to a real PostgreSQL
database (hosted on Neon). The current schema, exactly as it exists
today in `server/db/schema.sql`, has these tables with NO concept of
multiple cafés — everything implicitly belongs to "the one café":

```sql
cafe_info     (id, name, intro_short, intro_full, phone, email, address, hours, updated_at)
hero_photos   (id, filename, display_order, created_at)
menu_items    (id, name, price, description, image, category, available, in_stock, created_at, updated_at)
cafe_tables   (id, label, token_version, status, session_id, claimed_at, last_activity_at)
orders        (id, table_number, items, status, total, created_at, updated_at)
waiter_calls  (id, table_number, order_id, resolved, created_at)
```

`server/db/store.js` contains all data-access functions (e.g.
`getMenuItems()`, `createOrder()`, `getTables()`) that `server.js` calls,
fully converted to use PostgreSQL via a connection pool in
`server/db/pool.js`. There are 120 real orders, 13 real tables, 7 real
menu items, and 1 real café's info already live in this database. This
data must not be lost or duplicated during this migration.

The existing admin auth pattern, which you must mirror for super admin:
```js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
```

---

## WHAT YOU ARE BUILDING IN THIS PART

1. A new `cafes` table — the master list of every café on the platform
2. A `cafe_id` column added to every existing table, with a foreign key
   back to `cafes`
3. A migration that creates exactly one row in `cafes` for the café that
   already exists, and backfills every existing row in every other table
   with that café's `cafe_id` — so nothing is orphaned
4. Every function in `server/db/store.js` updated to accept and filter
   by `cafe_id`
5. Every route in `server/server.js` updated to determine which café a
   request belongs to, and pass that `cafe_id` through to the database
   layer

You are NOT building the actual Super Admin pages yet — that is Part B,
a separate prompt. This part is purely the database and backend
groundwork that Part B will be built on top of.

---

## TASK 1 — Add the new tables and columns to schema.sql

Update `server/db/schema.sql`. Add this NEW table at the very top of the
file, before all existing tables (since everything else will reference it):

```sql
-- ───────────────────────────────────────────────────────────
-- CAFES (the master list of every café on the platform — this
-- is the table the Super Admin manages directly)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cafes (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,     -- url-friendly identifier, e.g. "cafe-crafted"
  name          TEXT NOT NULL,
  owner_name    TEXT,
  owner_email   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  admin_key     TEXT NOT NULL,            -- this café's own admin password (replaces the single global ADMIN_PASSWORD)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Now add a `cafe_id` column to every existing table. Edit each
`CREATE TABLE IF NOT EXISTS` block to add this column right after `id`:

```sql
cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
```

Specifically:
- `cafe_info` — add `cafe_id`. Note: this table can now have ONE row PER
  café instead of one row total. Remove any assumption of "only one row
  ever exists."
- `hero_photos` — add `cafe_id`
- `menu_items` — add `cafe_id`. Also change the index pattern: instead of
  a global `id` primary key being sufficiently unique, keep `id` as
  primary key (existing string IDs like "m1" stay unique within their
  own café in practice, but to be fully safe across cafés, add a
  composite uniqueness rule):
  ```sql
  -- after the CREATE TABLE block:
  CREATE INDEX IF NOT EXISTS idx_menu_items_cafe ON menu_items (cafe_id);
  ```
- `cafe_tables` — add `cafe_id`. Same composite consideration — table IDs
  like "1", "2" are only meant to be unique within one café, not globally:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_cafe_tables_cafe ON cafe_tables (cafe_id);
  ```
- `orders` — add `cafe_id`. Add an index:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_orders_cafe_created ON orders (cafe_id, created_at DESC);
  ```
  This composite index matters — almost every order query going forward
  filters by BOTH café and date range together, so a combined index
  serves that pattern directly instead of two separate single-column
  indexes.
- `waiter_calls` — add `cafe_id`. Add an index:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_waiter_calls_cafe_resolved ON waiter_calls (cafe_id, resolved);
  ```

---

## TASK 2 — Write the backfill migration script

Create `server/db/migrate-add-cafe-id.js`. This is a ONE-TIME script that:
1. Creates the `cafes` table (if running `db:migrate` hasn't already
   picked up the schema changes — running the updated `schema.sql` again
   via the existing `migrate.js` handles table/column creation, since
   it's all `CREATE TABLE IF NOT EXISTS` — but adding a column to an
   EXISTING table needs an explicit `ALTER TABLE`, which `IF NOT EXISTS`
   on `CREATE TABLE` does not handle for pre-existing tables. Account for
   this explicitly, as described below)
2. Inserts one row into `cafes` representing the café that already
   exists, using its current data from `cafe_info`
3. Updates every existing row in every other table to set their
   `cafe_id` to that one café's new ID

Since the existing tables already exist in production with real data,
adding a NOT NULL column directly would fail on existing rows. Handle
this correctly with a three-step ALTER pattern: add the column as
nullable first, backfill it, then make it NOT NULL.

First, update `server/db/schema.sql`'s table definitions to use this
safer pattern instead of inline `NOT NULL` for `cafe_id` — actually,
keep schema.sql describing the IDEAL final state (with `NOT NULL`) since
that's correct for any FUTURE fresh database that runs this schema from
scratch. For the EXISTING database that already has data, this separate
migration script handles the safe transition:

```js
require("dotenv").config();
const pool = require("./pool");

async function migrate() {
  console.log("Starting multi-tenant migration...\n");

  // Step 1: Create the cafes table if it doesn't exist yet
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cafes (
      id            SERIAL PRIMARY KEY,
      slug          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      owner_name    TEXT,
      owner_email   TEXT,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      admin_key     TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ cafes table ready");

  // Step 2: Add cafe_id as a NULLABLE column to every existing table,
  // only if it doesn't already exist (safe to re-run).
  const tablesToUpdate = ["cafe_info", "hero_photos", "menu_items", "cafe_tables", "orders", "waiter_calls"];
  for (const table of tablesToUpdate) {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${table}' AND column_name = 'cafe_id'
        ) THEN
          ALTER TABLE ${table} ADD COLUMN cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    console.log(`✅ cafe_id column ready on ${table}`);
  }

  // Step 3: Insert the existing café as tenant #1, using its current
  // cafe_info row — only if a café with this slug doesn't already exist
  // (safe to re-run).
  const { rows: existingInfo } = await pool.query("SELECT * FROM cafe_info LIMIT 1");
  const existingCafeRow = await pool.query("SELECT id FROM cafes WHERE slug = $1", ["cafe-crafted"]);

  let cafeId;
  if (existingCafeRow.rows.length > 0) {
    cafeId = existingCafeRow.rows[0].id;
    console.log(`↪ Café "cafe-crafted" already exists with id ${cafeId}, skipping insert`);
  } else {
    const name = existingInfo[0]?.name || "Cafe Crafted";
    const adminKey = process.env.ADMIN_PASSWORD || "admin123";
    const { rows } = await pool.query(
      `INSERT INTO cafes (slug, name, owner_name, owner_email, admin_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ["cafe-crafted", name, "Café Owner", existingInfo[0]?.email || null, adminKey]
    );
    cafeId = rows[0].id;
    console.log(`✅ Created café "cafe-crafted" with id ${cafeId}, using existing ADMIN_PASSWORD as its admin_key`);
  }

  // Step 4: Backfill cafe_id on every existing row in every table, only
  // where it's currently NULL (safe to re-run — already-tagged rows are
  // left alone).
  for (const table of tablesToUpdate) {
    const result = await pool.query(
      `UPDATE ${table} SET cafe_id = $1 WHERE cafe_id IS NULL`,
      [cafeId]
    );
    console.log(`✅ Backfilled cafe_id on ${result.rowCount} existing rows in ${table}`);
  }

  // Step 5: Now that every row has a cafe_id, make the column required
  // going forward, only if it isn't already.
  for (const table of tablesToUpdate) {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${table}' AND column_name = 'cafe_id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE ${table} ALTER COLUMN cafe_id SET NOT NULL;
        END IF;
      END $$;
    `);
  }
  console.log("✅ cafe_id is now NOT NULL on all tables");

  console.log("\n🎉 Multi-tenant migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
```

Add this script to `package.json`:
```json
"db:migrate-multi-tenant": "node server/db/migrate-add-cafe-id.js"
```

---

## TASK 3 — Update server/db/store.js: every function takes cafe_id

This is the core of the work. Every existing function in `store.js` must
now accept a `cafeId` parameter (as the FIRST parameter, by convention)
and include it in every query — both as a filter on reads, and as a
value to insert on writes.

Go through every function and apply this pattern. Examples for the most
important ones — apply the same idea to every remaining function in the
file (`getHeroPhotos`, `addHeroPhoto`, `removeHeroPhoto`,
`getMenuItemById`, `updateMenuItem`, `deleteMenuItem`, `getTableById`,
`createTable`, `updateTable`, `getOrderById`, `updateOrderStatus`,
`getOrdersInRange`, `getDistinctOrderDates`, `getAllOrdersForExport`,
`createWaiterCall`, `getUnresolvedWaiterCalls`, `resolveWaiterCall`):

```js
async function getCafeInfo(cafeId) {
  const { rows } = await pool.query("SELECT * FROM cafe_info WHERE cafe_id = $1 LIMIT 1", [cafeId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    name: r.name,
    introShort: r.intro_short,
    introFull: r.intro_full,
    contact: { phone: r.phone, email: r.email, address: r.address, hours: r.hours },
  };
}

async function updateCafeInfo(cafeId, partialInfo) {
  const current = await getCafeInfo(cafeId);
  const merged = { ...current, ...partialInfo };
  const contact = { ...current?.contact, ...partialInfo?.contact };

  await pool.query(
    `UPDATE cafe_info SET
      name = $1, intro_short = $2, intro_full = $3,
      phone = $4, email = $5, address = $6, hours = $7, updated_at = NOW()
     WHERE cafe_id = $8`,
    [merged.name, merged.introShort, merged.introFull, contact.phone, contact.email, contact.address, contact.hours, cafeId]
  );
  return getCafeInfo(cafeId);
}

async function getMenuItems(cafeId) {
  const { rows } = await pool.query("SELECT * FROM menu_items WHERE cafe_id = $1 ORDER BY created_at ASC", [cafeId]);
  return rows.map(mapMenuItemRow);
}

async function createMenuItem(cafeId, item) {
  const { rows } = await pool.query(
    `INSERT INTO menu_items (id, cafe_id, name, price, description, image, category, available, in_stock)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [item.id, cafeId, item.name, item.price, item.description, item.image, item.category, item.available, item.inStock]
  );
  return mapMenuItemRow(rows[0]);
}

async function getTables(cafeId) {
  const { rows } = await pool.query("SELECT * FROM cafe_tables WHERE cafe_id = $1 ORDER BY id ASC", [cafeId]);
  return rows.map(mapTableRow);
}

async function createOrder(cafeId, order) {
  const { rows } = await pool.query(
    `INSERT INTO orders (id, cafe_id, table_number, items, status, total, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
    [order.id, cafeId, order.tableNumber, JSON.stringify(order.items), order.status, order.total, order.createdAt]
  );
  return mapOrderRow(rows[0]);
}

async function getOrdersInRange(cafeId, startDate, endDate) {
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE cafe_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY created_at DESC",
    [cafeId, startDate, endDate]
  );
  return rows.map(mapOrderRow);
}
```

IMPORTANT — `getTableById`, `getOrderById`, `getMenuItemById` need a
SPECIAL note: since table/order/menu-item IDs are looked up directly by
their own unique string ID elsewhere in the existing security logic
(e.g. `verifyTableToken` looks up a table by its `id` alone, before it
even knows for certain which café's QR was scanned), these "look up by
ID alone" functions should ALSO take `cafeId` and filter by it, as a
critical security boundary:

```js
async function getTableById(cafeId, id) {
  const { rows } = await pool.query("SELECT * FROM cafe_tables WHERE cafe_id = $1 AND id = $2", [cafeId, id]);
  return rows.length ? mapTableRow(rows[0]) : null;
}
```

This means a request carrying a valid table token for Café A's "Table 1"
can NEVER accidentally match Café B's "Table 1" — even though both
cafés might have a table literally named "1". This is the entire
multi-tenant security guarantee in one pattern: every single lookup is
scoped by `cafe_id` first, no exceptions.

Add new functions for managing the `cafes` table itself, used by Super
Admin in Part B (build these now so Part B can use them immediately):

```js
function mapCafeRow(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    ownerName: r.owner_name,
    ownerEmail: r.owner_email,
    isActive: r.is_active,
    adminKey: r.admin_key,
    createdAt: r.created_at.toISOString(),
  };
}

async function getAllCafes() {
  const { rows } = await pool.query("SELECT * FROM cafes ORDER BY created_at ASC");
  return rows.map(mapCafeRow);
}

async function getCafeById(id) {
  const { rows } = await pool.query("SELECT * FROM cafes WHERE id = $1", [id]);
  return rows.length ? mapCafeRow(rows[0]) : null;
}

async function getCafeBySlug(slug) {
  const { rows } = await pool.query("SELECT * FROM cafes WHERE slug = $1", [slug]);
  return rows.length ? mapCafeRow(rows[0]) : null;
}

async function getCafeByAdminKey(adminKey) {
  const { rows } = await pool.query("SELECT * FROM cafes WHERE admin_key = $1 AND is_active = true", [adminKey]);
  return rows.length ? mapCafeRow(rows[0]) : null;
}

async function createCafe({ slug, name, ownerName, ownerEmail, adminKey }) {
  const { rows } = await pool.query(
    `INSERT INTO cafes (slug, name, owner_name, owner_email, admin_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [slug, name, ownerName, ownerEmail, adminKey]
  );
  return mapCafeRow(rows[0]);
}

async function setCafeActive(id, isActive) {
  const { rows } = await pool.query(
    "UPDATE cafes SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [isActive, id]
  );
  return rows.length ? mapCafeRow(rows[0]) : null;
}

async function resetCafeAdminKey(id, newAdminKey) {
  const { rows } = await pool.query(
    "UPDATE cafes SET admin_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [newAdminKey, id]
  );
  return rows.length ? mapCafeRow(rows[0]) : null;
}
```

Update the `module.exports` block at the bottom of `store.js` to include
these six new functions alongside everything else.

---

## TASK 4 — Update server.js: figure out cafe_id on every request

This is the second core piece. Every existing route currently has no
concept of "which café." You are adding a way to determine this on every
request, then threading it through to every `db.*` call.

### TASK 4.1 — Replace requireAdmin entirely

The single global `ADMIN_PASSWORD` is replaced by per-café admin keys
stored in the `cafes` table. Replace the existing `requireAdmin`
function with:

```js
// Looks up which café this admin request belongs to, based on its
// admin key, and attaches it to the request for every downstream
// handler to use. This replaces the old single-password model — every
// café now has its OWN admin key, stored in the cafes table.
async function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!key) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cafe = await db.getCafeByAdminKey(key);
  if (!cafe) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.cafeId = cafe.id;
  req.cafe = cafe;
  next();
}
```

### TASK 4.2 — Determine cafe_id for PUBLIC (customer-facing) routes

Customer-facing routes (`/api/cafe`, `/api/menu`, `/api/table/verify`,
`/api/orders`, `/api/waiter-call`) currently have no login at all — they
rely on the table token for security, not an admin key. These routes
need to know which café a request belongs to via a different mechanism:
the café's `slug`, present in the URL.

Since the existing frontend serves one single `index.html` /
`menu.html` etc. with no café slug in the URL today, and changing every
customer-facing URL is a bigger frontend change than this backend-focused
prompt should make unilaterally, use this approach instead: add a
required `cafeSlug` query parameter that the frontend will need to
provide (Part B's setup will explain exactly how this gets wired to the
frontend — for now, build the backend to expect it).

Add this helper near `requireAdmin`:

```js
// Resolves which café a public/customer request belongs to, based on
// a `cafeSlug` query parameter. Customer-facing routes call this
// directly (not as Express middleware) since some of them need the
// cafeId before doing anything else, including before token verification.
async function resolveCafeBySlug(req) {
  const slug = req.query.cafeSlug || req.body?.cafeSlug;
  if (!slug) return null;
  return db.getCafeBySlug(slug);
}
```

Update each public route to resolve the café first, then pass `cafe.id`
into every subsequent `db.*` call in that route. For example:

```js
app.get("/api/cafe", async (req, res) => {
  const cafe = await resolveCafeBySlug(req);
  if (!cafe || !cafe.isActive) {
    return res.status(404).json({ error: "Café not found" });
  }

  const cafeInfo = await db.getCafeInfo(cafe.id);
  const heroPhotos = await db.getHeroPhotos(cafe.id);
  res.json({ cafeInfo, heroPhotos: heroPhotos.map((p) => `/photos/${p}`) });
});
```

Apply this same "resolve cafe by slug first, then pass cafe.id into
every db call" pattern to: `/api/menu`, `/api/table/verify`,
`/api/orders` (POST), `/api/orders/:id` (GET), `/api/waiter-call` (POST).

For `verifyTableToken`, since it's called from multiple routes, change
its signature to accept `cafeId` as its first parameter:
```js
async function verifyTableToken(cafeId, token) {
  // ... same signature verification logic as before ...
  const table = await db.getTableById(cafeId, tableId);
  // ... rest unchanged ...
}
```
Update every call site to pass the resolved `cafe.id` as the first argument.

Apply the same `cafeId`-first-parameter treatment to `claimTable` and
`touchTableActivity`.

### TASK 4.3 — Update every admin route to use req.cafeId

Every existing `/api/admin/*` route already runs through the (now
updated) `requireAdmin` middleware, which attaches `req.cafeId`. Update
every single one of these routes to pass `req.cafeId` as the first
argument to its corresponding `db.*` call. For example:

```js
app.get("/api/admin/menu", requireAdmin, async (req, res) => {
  const items = await db.getMenuItems(req.cafeId);
  // ... rest unchanged ...
});

app.post("/api/admin/menu", requireAdmin, upload.single("image"), async (req, res) => {
  // ... build item object as before ...
  const saved = await db.createMenuItem(req.cafeId, item);
  // ...
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  // ... existing date-range calculation unchanged ...
  const orders = await db.getOrdersInRange(req.cafeId, start, end);
  // ...
});
```

Go through EVERY remaining `/api/admin/*` route in `server.js` and apply
this same change: pass `req.cafeId` as the first argument to whatever
`db.*` function that route calls.

---

## WHAT NOT TO DO IN THIS PART

- Do not change the response shape of any existing route — only the
  internal filtering changes, not what the frontend receives
- Do not build any Super Admin UI yet — that's Part B
- Do not change the existing `public/` frontend files yet — Part B will
  cover exactly how `cafeSlug` gets wired into customer-facing requests
- Do not remove the `ADMIN_PASSWORD` env var reference from `.env` yet —
  it's still used as the seed value for the first café's `admin_key`
  during migration; clean it up only after confirming everything works

---

## HOW TO RUN AND VERIFY THIS PART

```bash
# 1. Apply schema changes (creates cafes table, safe to re-run)
npm run db:migrate

# 2. Run the multi-tenant backfill (safe to re-run)
npm run db:migrate-multi-tenant

# 3. Restart the server
npm run dev
```

Verify:
1. Check the database directly: `SELECT * FROM cafes;` should show
   exactly one row, slug `cafe-crafted`, with `admin_key` matching
   whatever `ADMIN_PASSWORD` was in `.env`
2. Check that every existing table's rows now have a non-null `cafe_id`
   matching that café's id: `SELECT COUNT(*) FROM orders WHERE cafe_id IS NULL;`
   should return `0`
3. The EXISTING admin panel login should still work using the SAME
   admin key as before (since it was copied into `cafes.admin_key`
   during migration) — confirm logging in and viewing orders/menu still
   works exactly as before
4. Confirm placing a test order still works (this now requires the
   frontend to send a `cafeSlug` — for this verification step only, you
   can test directly via a tool like Postman/curl by adding
   `?cafeSlug=cafe-crafted` to the relevant requests, since the frontend
   wiring happens in Part B)

---

## SESSION CONTINUITY — SAVE THIS SUMMARY

When complete, write a summary covering:
- Confirm the `cafes` table has exactly 1 row, with its `id`, `slug`,
  and `admin_key` values
- Confirm every other table's existing rows were correctly backfilled
  with that `cafe_id` (give row counts per table)
- Confirm every function in `store.js` now takes `cafeId` as documented
- Confirm every route in `server.js` resolves a café (via admin key for
  admin routes, via `cafeSlug` query param for public routes) before
  calling any `db.*` function
- List the exact `cafeId` value (e.g. `1`) for the existing café, since
  Part B's frontend wiring and verification will need this

This summary becomes the foundation for Part B: the actual Super Admin
login, dashboard, café list, and café detail pages.

---

## END OF PART A
# ─────────────────────────────────────────────────────────────────────
# Part B (next prompt) will add:
# Super Admin login, dashboard (all cafes + platform stats), café detail
# drill-down, Add Café flow, and the small frontend change needed so
# customer-facing pages send their cafeSlug correctly
# ─────────────────────────────────────────────────────────────────────
