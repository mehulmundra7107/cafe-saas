require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
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
