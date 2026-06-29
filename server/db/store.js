const pool = require("./pool");
const bcrypt = require("bcrypt");

// ─── CAFES ───────────────────────────────────────────────────

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

// Since admin_key is now a bcrypt hash, we cannot look up a café directly
// by plain-text key via a WHERE clause. Instead we check the provided key
// against every active café's stored hash individually.
async function getCafeByAdminKey(adminKey) {
  const { rows } = await pool.query("SELECT * FROM cafes WHERE is_active = true");
  for (const row of rows) {
    const matches = await bcrypt.compare(adminKey, row.admin_key);
    if (matches) return mapCafeRow(row);
  }
  return null;
}

async function createCafe({ slug, name, ownerName, ownerEmail, adminKey }) {
  const hashedKey = await bcrypt.hash(adminKey, 12);
  const { rows } = await pool.query(
    `INSERT INTO cafes (slug, name, owner_name, owner_email, admin_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [slug, name, ownerName, ownerEmail, hashedKey]
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
  const hashedKey = await bcrypt.hash(newAdminKey, 12);
  const { rows } = await pool.query(
    "UPDATE cafes SET admin_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [hashedKey, id]
  );
  return rows.length ? mapCafeRow(rows[0]) : null;
}

// ─── CAFE INFO ───────────────────────────────────────────────

async function getCafeInfo(cafeId) {
  const { rows } = await pool.query("SELECT * FROM cafe_info WHERE cafe_id = $1 LIMIT 1", [cafeId]);
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

async function updateCafeInfo(cafeId, partialInfo) {
  const current = await getCafeInfo(cafeId);
  const merged = { ...current, ...partialInfo };
  const contact = { ...current?.contact, ...partialInfo?.contact };

  await pool.query(
    `UPDATE cafe_info SET
      name = $1, intro_short = $2, intro_full = $3,
      phone = $4, email = $5, address = $6, hours = $7,
      updated_at = NOW()
     WHERE cafe_id = $8`,
    [merged.name, merged.introShort, merged.introFull, contact.phone, contact.email, contact.address, contact.hours, cafeId]
  );
  return getCafeInfo(cafeId);
}

// ─── HERO PHOTOS ─────────────────────────────────────────────

async function getHeroPhotos(cafeId) {
  const { rows } = await pool.query(
    "SELECT id, filename, display_order FROM hero_photos WHERE cafe_id = $1 ORDER BY display_order ASC, id ASC",
    [cafeId]
  );
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    display_order: r.display_order
  }));
}

async function addHeroPhoto(cafeId, filename) {
  const { rows } = await pool.query("SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM hero_photos WHERE cafe_id = $1", [cafeId]);
  await pool.query(
    "INSERT INTO hero_photos (cafe_id, filename, display_order) VALUES ($1, $2, $3)",
    [cafeId, filename, rows[0].next]
  );
}

async function removeHeroPhoto(cafeId, filename) {
  await pool.query("DELETE FROM hero_photos WHERE cafe_id = $1 AND filename = $2", [cafeId, filename]);
}

async function updateHeroPhotoOrder(cafeId, updates) {
  // updates is an array of { id, display_order }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const update of updates) {
      await client.query(
        "UPDATE hero_photos SET display_order = $1 WHERE cafe_id = $2 AND id = $3",
        [update.display_order, cafeId, update.id]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

async function getMenuItems(cafeId) {
  const { rows } = await pool.query("SELECT * FROM menu_items WHERE cafe_id = $1 ORDER BY created_at ASC", [cafeId]);
  return rows.map(mapMenuItemRow);
}

async function getMenuItemById(cafeId, id) {
  const { rows } = await pool.query("SELECT * FROM menu_items WHERE cafe_id = $1 AND id = $2", [cafeId, id]);
  return rows.length ? mapMenuItemRow(rows[0]) : null;
}

async function createMenuItem(cafeId, item) {
  const { rows } = await pool.query(
    `INSERT INTO menu_items (id, cafe_id, name, price, description, image, category, available, in_stock)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [item.id, cafeId, item.name, item.price, item.description, item.image, item.category, item.available, item.inStock]
  );
  return mapMenuItemRow(rows[0]);
}

async function updateMenuItem(cafeId, id, fields) {
  const existing = await getMenuItemById(cafeId, id);
  if (!existing) return null;
  const merged = { ...existing, ...fields };

  const { rows } = await pool.query(
    `UPDATE menu_items SET
      name = $1, price = $2, description = $3, image = $4,
      category = $5, available = $6, in_stock = $7, updated_at = NOW()
     WHERE cafe_id = $8 AND id = $9 RETURNING *`,
    [merged.name, merged.price, merged.description, merged.image, merged.category, merged.available, merged.inStock, cafeId, id]
  );
  return mapMenuItemRow(rows[0]);
}

async function deleteMenuItem(cafeId, id) {
  const { rowCount } = await pool.query("DELETE FROM menu_items WHERE cafe_id = $1 AND id = $2", [cafeId, id]);
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

async function getTables(cafeId) {
  const { rows } = await pool.query("SELECT * FROM cafe_tables WHERE cafe_id = $1 ORDER BY id ASC", [cafeId]);
  return rows.map(mapTableRow);
}

async function getTableById(cafeId, id) {
  const { rows } = await pool.query("SELECT * FROM cafe_tables WHERE cafe_id = $1 AND id = $2", [cafeId, id]);
  return rows.length ? mapTableRow(rows[0]) : null;
}

async function createTable(cafeId, table) {
  const { rows } = await pool.query(
    `INSERT INTO cafe_tables (id, cafe_id, label, token_version, status)
     VALUES ($1, $2, $3, 1, 'free') RETURNING *`,
    [table.id, cafeId, table.label]
  );
  return mapTableRow(rows[0]);
}

async function updateTable(cafeId, id, fields) {
  const existing = await getTableById(cafeId, id);
  if (!existing) return null;
  const merged = { ...existing, ...fields };

  const { rows } = await pool.query(
    `UPDATE cafe_tables SET
      label = $1, token_version = $2, status = $3,
      session_id = $4, claimed_at = $5, last_activity_at = $6
     WHERE cafe_id = $7 AND id = $8 RETURNING *`,
    [merged.label, merged.tokenVersion, merged.status, merged.sessionId, merged.claimedAt, merged.lastActivityAt, cafeId, id]
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

async function createOrder(cafeId, order) {
  const { rows } = await pool.query(
    `INSERT INTO orders (id, cafe_id, table_number, items, status, total, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
    [order.id, cafeId, order.tableNumber, JSON.stringify(order.items), order.status, order.total, order.createdAt]
  );
  return mapOrderRow(rows[0]);
}

async function getOrderById(cafeId, id) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE cafe_id = $1 AND id = $2", [cafeId, id]);
  return rows.length ? mapOrderRow(rows[0]) : null;
}

async function updateOrderStatus(cafeId, id, status) {
  const { rows } = await pool.query(
    "UPDATE orders SET status = $1, updated_at = NOW() WHERE cafe_id = $2 AND id = $3 RETURNING *",
    [status, cafeId, id]
  );
  return rows.length ? mapOrderRow(rows[0]) : null;
}

// Mirrors the existing date-filtering behavior from server.js exactly —
// same three modes (range / date / from+to), just expressed as SQL
// instead of filtering a JS array in memory.
async function getOrdersInRange(cafeId, startDate, endDate) {
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE cafe_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY created_at DESC",
    [cafeId, startDate, endDate]
  );
  return rows.map(mapOrderRow);
}

async function getDistinctOrderDates(cafeId, monthPrefix) {
  const { rows } = await pool.query(
    `SELECT DISTINCT TO_CHAR(created_at, 'YYYY-MM-DD') AS day FROM orders
     WHERE cafe_id = $1 ${monthPrefix ? "AND TO_CHAR(created_at, 'YYYY-MM') = $2" : ""}
     ORDER BY day ASC`,
    monthPrefix ? [cafeId, monthPrefix] : [cafeId]
  );
  return rows.map((r) => r.day);
}

async function getAllOrdersForExport(cafeId) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE cafe_id = $1 ORDER BY created_at DESC", [cafeId]);
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

async function createWaiterCall(cafeId, call) {
  const { rows } = await pool.query(
    `INSERT INTO waiter_calls (id, cafe_id, table_number, order_id, resolved, created_at)
     VALUES ($1, $2, $3, $4, false, $5) RETURNING *`,
    [call.id, cafeId, call.tableNumber, call.orderId, call.createdAt]
  );
  return mapWaiterCallRow(rows[0]);
}

async function getUnresolvedWaiterCalls(cafeId) {
  const { rows } = await pool.query("SELECT * FROM waiter_calls WHERE cafe_id = $1 AND resolved = false ORDER BY created_at DESC", [cafeId]);
  return rows.map(mapWaiterCallRow);
}

async function resolveWaiterCall(cafeId, id) {
  const { rows } = await pool.query(
    "UPDATE waiter_calls SET resolved = true WHERE cafe_id = $1 AND id = $2 RETURNING *",
    [cafeId, id]
  );
  return rows.length ? mapWaiterCallRow(rows[0]) : null;
}

module.exports = {
  getAllCafes, getCafeById, getCafeBySlug, getCafeByAdminKey, createCafe, setCafeActive, resetCafeAdminKey,
  getCafeInfo, updateCafeInfo,
  getHeroPhotos, addHeroPhoto, removeHeroPhoto, updateHeroPhotoOrder,
  getMenuItems, getMenuItemById, createMenuItem, updateMenuItem, deleteMenuItem,
  getTables, getTableById, createTable, updateTable,
  createOrder, getOrderById, updateOrderStatus, getOrdersInRange, getDistinctOrderDates, getAllOrdersForExport,
  createWaiterCall, getUnresolvedWaiterCalls, resolveWaiterCall,
};
