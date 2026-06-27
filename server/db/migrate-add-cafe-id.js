require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
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
