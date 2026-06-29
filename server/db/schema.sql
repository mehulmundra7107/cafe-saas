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

-- ───────────────────────────────────────────────────────────
-- CAFE INFO
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cafe_info (
  id            SERIAL PRIMARY KEY,
  cafe_id       INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
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
-- HERO PHOTOS
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hero_photos (
  id            SERIAL PRIMARY KEY,
  cafe_id       INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────
-- MENU ITEMS
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id            TEXT PRIMARY KEY,
  cafe_id       INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  price         NUMERIC(10, 2) NOT NULL,
  description   TEXT,
  image         TEXT,
  category      TEXT NOT NULL DEFAULT 'General',
  available     BOOLEAN NOT NULL DEFAULT true,
  in_stock      BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_cafe ON menu_items (cafe_id);

-- ───────────────────────────────────────────────────────────
-- TABLES
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cafe_tables (
  id                TEXT PRIMARY KEY,
  cafe_id           INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  token_version     INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'occupied')),
  session_id        TEXT,
  claimed_at        TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cafe_tables_cafe ON cafe_tables (cafe_id);

-- ───────────────────────────────────────────────────────────
-- ORDERS
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  cafe_id       INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  table_number  TEXT NOT NULL,
  items         JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected', 'preparing', 'ready')),
  total         NUMERIC(10, 2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_table_number ON orders (table_number);
CREATE INDEX IF NOT EXISTS idx_orders_cafe_created ON orders (cafe_id, created_at DESC);

-- ───────────────────────────────────────────────────────────
-- WAITER CALLS
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waiter_calls (
  id            TEXT PRIMARY KEY,
  cafe_id       INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  table_number  TEXT NOT NULL,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  resolved      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waiter_calls_resolved ON waiter_calls (resolved);
CREATE INDEX IF NOT EXISTS idx_waiter_calls_cafe_resolved ON waiter_calls (cafe_id, resolved);

-- ───────────────────────────────────────────────────────────
-- SUPER ADMIN SETTINGS (a single row holding the hashed
-- platform-owner password — there is exactly one super admin)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS super_admin_settings (
  id              SERIAL PRIMARY KEY,
  password_hash   TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NOTE: cafes.admin_key now stores a bcrypt HASH, not a plain password.
-- This is enforced by application code (server.js), not a database
-- constraint, since Postgres has no way to validate hash format at
-- the column level. See server.js's requireAdmin and the café
-- creation/reset-key routes for where hashing is applied.
