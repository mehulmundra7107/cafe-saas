const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const db = require("./db/store");
const pool = require("./db/pool");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server);

const ROOT = path.join(__dirname, "..");
const PHOTOS_DIR = path.join(ROOT, "photos");
const MENU_IMAGES_DIR = path.join(ROOT, "uploads", "menu");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "superadmin123";
const TABLE_TOKEN_SECRET =
  process.env.TABLE_TOKEN_SECRET || "change-this-in-production-please";
// In production, set TABLE_TOKEN_SECRET as a real environment variable.
// This secret is what makes table tokens impossible to forge — anyone
// without this exact secret cannot produce a token that passes
// verification, no matter what tableId or version they try to guess.

const usingInsecureDefaults = [];
if (!process.env.ADMIN_PASSWORD) usingInsecureDefaults.push("ADMIN_PASSWORD");
if (!process.env.SUPER_ADMIN_PASSWORD) usingInsecureDefaults.push("SUPER_ADMIN_PASSWORD");
if (!process.env.TABLE_TOKEN_SECRET) usingInsecureDefaults.push("TABLE_TOKEN_SECRET");

if (usingInsecureDefaults.length > 0) {
  console.warn("\n⚠️  WARNING: The following secrets are using INSECURE DEFAULT values");
  console.warn("⚠️  because they are not set in your environment:");
  usingInsecureDefaults.forEach((name) => console.warn(`⚠️    - ${name}`));
  console.warn("⚠️  Set these in your .env file (local) or your hosting platform's");
  console.warn("⚠️  environment variables (production) before going live.\n");
}

if (process.env.NODE_ENV === "production" && usingInsecureDefaults.length > 0) {
  console.error("❌ Refusing to start in production with insecure default secrets.");
  console.error("❌ Missing:", usingInsecureDefaults.join(", "));
  process.exit(1);
}

[PHOTOS_DIR, MENU_IMAGES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function emitAll(event, payload) {
  io.emit(event, payload);
}

const { authLimiter, adminLimiter, publicLimiter } = require("./middleware/rateLimiters");

app.use(express.json());

app.use("/api/admin", adminLimiter);
app.use("/api/super-admin", adminLimiter);
app.use("/api", publicLimiter);
// Customer-facing pages are now accessed as /c/:cafeSlug/ instead of
// the site root. This single route handles the entry point; the
// existing static file serving below continues to handle menu.html,
// cart.html, orders.html, and all CSS/JS/images exactly as before —
// those pages will read the cafeSlug from the URL using the helper
// added in Task D2.
app.get("/c/:cafeSlug", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});
app.get("/c/:cafeSlug/menu", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "menu.html"));
});
app.get("/c/:cafeSlug/cart", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "cart.html"));
});
app.get("/c/:cafeSlug/orders", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "orders.html"));
});

app.use(express.static(path.join(ROOT, "public")));
app.use("/photos", express.static(PHOTOS_DIR));
app.use("/uploads/menu", express.static(MENU_IMAGES_DIR));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dest = req.uploadDest || MENU_IMAGES_DIR;
    cb(null, dest);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    if (/\.(jpe?g|png|webp|gif)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("Only image files allowed"));
  },
});

// Resolves which café a public/customer request belongs to, based on
// a `cafeSlug` query parameter. Customer-facing routes call this
// directly (not as Express middleware) since some of them need the
// cafeId before doing anything else, including before token verification.
async function resolveCafeBySlug(req) {
  const slug = req.query.cafeSlug || req.body?.cafeSlug;
  if (!slug) return null;
  return db.getCafeBySlug(slug);
}

// Looks up which café this admin request belongs to, based on its
// admin key, and attaches it to the request for every downstream
// handler to use. This replaces the old single-password model — every
async function requireAdmin(req, res, next) {
  try {
    const key = req.headers["x-admin-key"] || req.query.key;
    if (!key || key !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { rows } = await pool.query("SELECT * FROM cafes ORDER BY id ASC LIMIT 1");
    const cafe = rows[0];
    if (!cafe) {
      return res.status(401).json({ error: "No cafe found in database. Create one from the super-admin panel." });
    }

    req.cafeId = cafe.id;
    // Convert snake_case back to camelCase for downstream code
    req.cafe = {
      id: cafe.id,
      slug: cafe.slug,
      name: cafe.name,
      ownerName: cafe.owner_name,
      ownerEmail: cafe.owner_email,
      isActive: cafe.is_active,
      adminKey: cafe.admin_key,
      createdAt: cafe.created_at,
    };
    next();
  } catch (err) {
    console.error("Database error in requireAdmin:", err);
    return res.status(500).json({ error: "Internal server error connecting to database" });
  }
}

function requireSuperAdmin(req, res, next) {
  const key = req.headers["x-super-admin-key"] || req.query.key;
  if (key !== SUPER_ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function generateSessionId() {
  return uuidv4();
}

function signTableToken(tableId, tokenVersion) {
  const payload = `${tableId}.${tokenVersion}`;
  const signature = crypto
    .createHmac("sha256", TABLE_TOKEN_SECRET)
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

// The token packs tableId + tokenVersion + a signature into one string.
// Nobody can forge a valid token without knowing TABLE_TOKEN_SECRET,
// because the signature would not match. If admin resets a table's QR,
// tokenVersion increments in store.json, and any old token (which has
// the old version number baked into its signed payload) immediately
// fails verification from that point forward — even though its
// signature was perfectly valid for the version it was issued under.
async function verifyTableToken(cafeId, token) {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "No table token provided" };
  }

  let decoded;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return { valid: false, reason: "Malformed token" };
  }

  const parts = decoded.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "Malformed token" };
  }
  const [tableId, tokenVersionStr, signature] = parts;

  const expectedPayload = `${tableId}.${tokenVersionStr}`;
  const expectedSignature = crypto
    .createHmac("sha256", TABLE_TOKEN_SECRET)
    .update(expectedPayload)
    .digest("hex");

  // Use timing-safe comparison so this check can't leak signature
  // information through response-time differences.
  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return { valid: false, reason: "Invalid table token" };
  }

  const table = await db.getTableById(cafeId, tableId);

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

const TABLE_INACTIVITY_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

// Attempts to claim a table for a device. Returns either a success
// with a sessionId the device should remember, or a rejection with
// a human-readable reason.
async function claimTable(cafeId, tableId, existingSessionId) {
  const table = await db.getTableById(cafeId, tableId);

  if (!table) {
    return { ok: false, reason: "Table not found" };
  }

  const now = Date.now();
  const lastActivity = table.lastActivityAt ? new Date(table.lastActivityAt).getTime() : 0;
  const isStale = now - lastActivity > TABLE_INACTIVITY_LIMIT_MS;

  // Case 1: table is free — claim it fresh.
  if (table.status === "free" || !table.sessionId) {
    return await acceptClaim(cafeId, table, generateSessionId());
  }

  // Case 2: this exact device already holds this table — just refresh it.
  if (existingSessionId && table.sessionId === existingSessionId) {
    return await acceptClaim(cafeId, table, existingSessionId);
  }

  // Case 3: occupied by someone else, but their session went stale — take over.
  if (isStale) {
    return await acceptClaim(cafeId, table, generateSessionId());
  }

  // Case 4: occupied by someone else, still active — reject.
  return {
    ok: false,
    reason: "This table is currently in use by another device. If you just sat down, please ask our staff for help.",
  };
}

async function acceptClaim(cafeId, table, sessionId) {
  const updated = await db.updateTable(cafeId, table.id, {
    status: "occupied",
    sessionId,
    claimedAt: table.claimedAt || new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  });
  return { ok: true, sessionId, tableId: updated.id, label: updated.label };
}

// Call this on every authenticated customer action (placing an order,
// calling a waiter, etc.) to keep the table's session alive.
async function touchTableActivity(cafeId, tableId, sessionId) {
  const table = await db.getTableById(cafeId, tableId);
  if (table && table.sessionId === sessionId) {
    await db.updateTable(cafeId, tableId, { lastActivityAt: new Date().toISOString() });
  }
}

// ——— Public API ———

app.get("/api/table/verify", async (req, res) => {
  const { t, sid } = req.query; // sid = existing sessionId, if the device has one already

  if (!t) {
    return res.status(400).json({ valid: false, reason: "No table token provided" });
  }

  const cafe = await resolveCafeBySlug(req);
  if (!cafe || !cafe.isActive) {
    return res.status(404).json({ valid: false, reason: "Café not found or inactive" });
  }

  const result = await verifyTableToken(cafe.id, t);
  
  if (!result.valid) {
    return res.status(403).json({ valid: false, reason: result.reason });
  }

  const claim = await claimTable(cafe.id, result.tableId, sid || null);
  if (!claim.ok) {
    return res.status(409).json({ valid: false, reason: claim.reason, occupied: true });
  }

  res.json({
    valid: true,
    tableId: result.tableId,
    label: result.table.label,
    sessionId: claim.sessionId,
  });
});

app.get("/api/cafe", async (req, res) => {
  const cafe = await resolveCafeBySlug(req);
  if (!cafe || !cafe.isActive) {
    return res.status(404).json({ error: "Café not found" });
  }

  const cafeInfo = await db.getCafeInfo(cafe.id);
  const heroPhotos = await db.getHeroPhotos(cafe.id);
  res.json({
    cafeInfo,
    heroPhotos: heroPhotos.map((p) => `/photos/${p}`),
  });
});

app.get("/api/menu", async (req, res) => {
  const cafe = await resolveCafeBySlug(req);
  if (!cafe || !cafe.isActive) {
    return res.status(404).json({ error: "Café not found" });
  }

  const items = await db.getMenuItems(cafe.id);
  const available = items
    .filter((i) => i.available !== false)
    .map((item) => ({
      ...item,
      image: item.image.startsWith("/") ? item.image : resolveImageUrl(item.image),
    }));
  res.json(available);
});

function resolveImageUrl(filename) {
  if (fs.existsSync(path.join(MENU_IMAGES_DIR, filename))) {
    return `/uploads/menu/${filename}`;
  }
  if (fs.existsSync(path.join(PHOTOS_DIR, filename))) {
    return `/photos/${filename}`;
  }
  return `/photos/photo-01.jpeg`;
}

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

app.post("/api/orders", async (req, res) => {
  const { tableToken, sessionId, items } = req.body;

  if (!tableToken || !sessionId) {
    return res.status(400).json({ error: "Missing table session. Please rescan the QR code on your table." });
  }

  const cafe = await resolveCafeBySlug(req);
  if (!cafe || !cafe.isActive) {
    return res.status(404).json({ error: "Café not found" });
  }

  const verification = await verifyTableToken(cafe.id, tableToken);
  if (!verification.valid) {
    return res.status(403).json({ error: verification.reason });
  }

  const table = await db.getTableById(cafe.id, verification.tableId);
  if (!table || table.sessionId !== sessionId) {
    return res.status(403).json({ error: "Your table session has expired or was taken over by another device. Please rescan the QR code." });
  }

  if (!items?.length) {
    return res.status(400).json({ error: "Cart is empty" });
  }

  for (const item of items) {
    const menuItem = await db.getMenuItemById(cafe.id, item.id);
    if (!menuItem || menuItem.available === false || menuItem.inStock === false) {
      return res.status(400).json({ error: `"${item.name}" is out of stock. Please remove it from your cart.` });
    }
  }

  const order = {
    id: uuidv4(),
    tableNumber: verification.tableId,
    items,
    status: "pending",
    total: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const savedOrder = await db.createOrder(cafe.id, order);
  await touchTableActivity(cafe.id, verification.tableId, sessionId);
  emitAll("order:new", savedOrder);
  res.status(201).json(savedOrder);
});

app.get("/api/orders/:id", async (req, res) => {
  const cafe = await resolveCafeBySlug(req);
  if (!cafe || !cafe.isActive) {
    return res.status(404).json({ error: "Café not found" });
  }

  const order = await db.getOrderById(cafe.id, req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

app.post("/api/waiter-call", async (req, res) => {
  const { tableToken, sessionId, orderId } = req.body;

  if (!tableToken || !sessionId) {
    return res.status(400).json({ error: "Missing table session. Please rescan the QR code on your table." });
  }

  const cafe = await resolveCafeBySlug(req);
  if (!cafe || !cafe.isActive) {
    return res.status(404).json({ error: "Café not found" });
  }

  const verification = await verifyTableToken(cafe.id, tableToken);
  if (!verification.valid) {
    return res.status(403).json({ error: verification.reason });
  }

  const table = await db.getTableById(cafe.id, verification.tableId);
  if (!table || table.sessionId !== sessionId) {
    return res.status(403).json({ error: "Your table session has expired or was taken over by another device. Please rescan the QR code." });
  }

  const call = {
    id: uuidv4(),
    tableNumber: verification.tableId,
    orderId: orderId || null,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
  const savedCall = await db.createWaiterCall(cafe.id, call);
  await touchTableActivity(cafe.id, verification.tableId, sessionId);
  emitAll("waiter:new", savedCall);
  res.status(201).json(savedCall);
});

// ——— Admin API ———

app.post("/api/admin/tables/:id/release", requireAdmin, async (req, res) => {
  const table = await db.getTableById(req.cafeId, req.params.id);
  if (!table) return res.status(404).json({ error: "Table not found" });

  const updated = await db.updateTable(req.cafeId, table.id, {
    status: "free", sessionId: null, claimedAt: null, lastActivityAt: null,
  });

  emitAll("table:released", { id: updated.id });
  res.json(updated);
});

// Resets a table's QR code by incrementing its tokenVersion. Any
// previously printed/shared QR for this table instantly stops working
// after this call, even though TABLE_TOKEN_SECRET itself never changes.
// Use this if a QR code is suspected to have been photographed and
// shared outside the cafe, or simply needs reprinting.
app.post("/api/admin/tables/:id/reset-qr", requireAdmin, async (req, res) => {
  const table = await db.getTableById(req.cafeId, req.params.id);
  if (!table) return res.status(404).json({ error: "Table not found" });

  const updated = await db.updateTable(req.cafeId, table.id, { tokenVersion: table.tokenVersion + 1 });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const newToken = signTableToken(table.id, updated.tokenVersion);

  emitAll("table:qrReset", { id: table.id });

  res.json({
    ...updated,
    qrUrl: `${baseUrl}/c/${req.cafe.slug}/?t=${newToken}`,
  });
});

// Adds a brand new table — e.g. the cafe added more seating.
app.post("/api/admin/tables", requireAdmin, async (req, res) => {
  const { id, label } = req.body;

  if (!id) return res.status(400).json({ error: "Table id is required" });
  
  const existing = await db.getTableById(req.cafeId, id);
  if (existing) {
    return res.status(409).json({ error: "A table with this id already exists" });
  }

  const newTable = await db.createTable(req.cafeId, { id: String(id), label: label || `Table ${id}` });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const token = signTableToken(newTable.id, newTable.tokenVersion);

  res.status(201).json({ ...newTable, qrUrl: `${baseUrl}/c/${req.cafe.slug}/?t=${token}` });
});

app.get("/api/admin/tables", requireAdmin, async (req, res) => {
  const tablesDb = await db.getTables(req.cafeId);
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const now = Date.now();

  const tables = tablesDb.map((table) => {
    const token = signTableToken(table.id, table.tokenVersion);
    const lastActivity = table.lastActivityAt ? new Date(table.lastActivityAt).getTime() : 0;
    const minutesIdle = table.lastActivityAt ? Math.round((now - lastActivity) / 60000) : null;
    const isStale = table.status === "occupied" && now - lastActivity > TABLE_INACTIVITY_LIMIT_MS;

    return {
      ...table,
      qrUrl: `${baseUrl}/c/${req.cafe.slug}/?t=${token}`,
      minutesIdle,
      isStale,
    };
  });

  res.json(tables);
});

// Supports three ways to filter:
//   ?range=today | week | month        (quick presets)
//   ?date=YYYY-MM-DD                    (a single specific day, for calendar clicks)
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD      (custom range, inclusive both ends)
// If none are provided, defaults to "today".
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const { range, date, from, to } = req.query;

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

  const filtered = await db.getOrdersInRange(req.cafeId, start, end);

  res.json({
    orders: filtered,
    range: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
  });
});

// Returns a list of distinct dates (YYYY-MM-DD, in server local time)
// that have at least one order, optionally scoped to a given month.
// ?month=YYYY-MM  — if omitted, returns dates across all orders.
app.get("/api/admin/orders/active-dates", requireAdmin, async (req, res) => {
  const { month } = req.query;
  const dates = await db.getDistinctOrderDates(req.cafeId, month);
  res.json({ dates });
});

// Part C: Compute Order Report
function computeOrderReport(orders) {
  let totalRevenue = 0;
  const itemMap = {};

  for (const order of orders) {
    totalRevenue += order.total || 0;
    for (const item of order.items) {
      if (!itemMap[item.name]) {
        itemMap[item.name] = { quantity: 0, revenue: 0 };
      }
      itemMap[item.name].quantity += item.quantity;
      itemMap[item.name].revenue += item.price * item.quantity;
    }
  }

  const items = Object.entries(itemMap)
    .map(([name, stats]) => ({
      name,
      quantity: stats.quantity,
      revenue: stats.revenue,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    totalOrders: orders.length,
    totalRevenue,
    averageOrderValue: orders.length ? totalRevenue / orders.length : 0,
    items,
  };
}

async function getFilteredOrders(req) {
  const { range, date, from, to } = req.query;
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

  const orders = await db.getOrdersInRange(req.cafeId, start, end);

  return {
    orders,
    rangeLabel: date || (from && to ? `${from} to ${to}` : range || "today"),
  };
}

app.get("/api/admin/orders/export.csv", requireAdmin, async (req, res) => {
  const { orders, rangeLabel } = await getFilteredOrders(req);
  const report = computeOrderReport(orders);

  let csv = `Date Range,${rangeLabel}\n`;
  csv += `Total Orders,${report.totalOrders}\n`;
  csv += `Total Revenue,${report.totalRevenue.toFixed(2)}\n`;
  csv += `Average Order Value,${report.averageOrderValue.toFixed(2)}\n\n`;

  csv += `Item Name,Quantity Sold,Total Revenue\n`;
  for (const item of report.items) {
    csv += `"${item.name}",${item.quantity},${item.revenue.toFixed(2)}\n`;
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="cafe-report-${rangeLabel}.csv"`);
  res.send(csv);
});

app.get("/api/admin/orders/export.pdf", requireAdmin, async (req, res) => {
  const { orders, rangeLabel } = await getFilteredOrders(req);
  const report = computeOrderReport(orders);

  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="cafe-report-${rangeLabel}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).text("Cafe Order Report", { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Date Range: ${rangeLabel}`);
  doc.text(`Total Orders: ${report.totalOrders}`);
  doc.text(`Total Revenue: $${report.totalRevenue.toFixed(2)}`);
  doc.text(`Average Order Value: $${report.averageOrderValue.toFixed(2)}`);
  doc.moveDown(2);

  doc.fontSize(14).text("Item Breakdown", { underline: true });
  doc.moveDown(0.5);

  for (const item of report.items) {
    doc
      .fontSize(10)
      .text(`${item.name}  —  Qty: ${item.quantity}  —  Rev: $${item.revenue.toFixed(2)}`);
  }

  doc.end();
});

app.patch("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!["accepted", "rejected", "preparing", "ready"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const updated = await db.updateOrderStatus(req.cafeId, req.params.id, status);
  if (!updated) return res.status(404).json({ error: "Order not found" });

  emitAll("order:updated", updated);
  res.json(updated);
});

app.get("/api/admin/waiter-calls", requireAdmin, async (req, res) => {
  const calls = await db.getUnresolvedWaiterCalls(req.cafeId);
  res.json(calls);
});

app.patch("/api/admin/waiter-calls/:id", requireAdmin, async (req, res) => {
  const updated = await db.resolveWaiterCall(req.cafeId, req.params.id);
  if (!updated) return res.status(404).json({ error: "Not found" });
  emitAll("waiter:resolved", updated);
  res.json(updated);
});

app.get("/api/admin/menu", requireAdmin, async (req, res) => {
  const items = await db.getMenuItems(req.cafeId);
  res.json(
    items.map((item) => ({
      ...item,
      image: item.image.startsWith("/") ? item.image : resolveImageUrl(item.image),
    }))
  );
});

app.post("/api/admin/menu", requireAdmin, upload.single("image"), async (req, res) => {
  const { name, price, description, category, available } = req.body;
  const item = {
    id: uuidv4(),
    name: name || "Untitled",
    price: parseFloat(price) || 0,
    description: description || "",
    image: req.file ? req.file.filename : "photo-01.jpeg",
    category: category || "General",
    available: available !== "false",
    inStock: req.body.inStock !== "false",
  };
  const saved = await db.createMenuItem(req.cafeId, item);
  const items = await db.getMenuItems(req.cafeId);
  emitAll("menu:updated", items);
  res.status(201).json({ ...saved, image: resolveImageUrl(saved.image) });
});

app.put("/api/admin/menu/:id", requireAdmin, upload.single("image"), async (req, res) => {
  const { name, price, description, category, available, inStock } = req.body;
  
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (price !== undefined) fields.price = parseFloat(price);
  if (description !== undefined) fields.description = description;
  if (category !== undefined) fields.category = category;
  if (available !== undefined) fields.available = available !== "false";
  if (inStock !== undefined) fields.inStock = inStock !== "false";
  if (req.file) fields.image = req.file.filename;

  const updated = await db.updateMenuItem(req.cafeId, req.params.id, fields);
  if (!updated) return res.status(404).json({ error: "Not found" });

  const items = await db.getMenuItems(req.cafeId);
  emitAll("menu:updated", items);
  res.json({ ...updated, image: resolveImageUrl(updated.image) });
});

app.delete("/api/admin/menu/:id", requireAdmin, async (req, res) => {
  const deleted = await db.deleteMenuItem(req.cafeId, req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  const items = await db.getMenuItems(req.cafeId);
  emitAll("menu:updated", items);
  res.json({ ok: true });
});

app.get("/api/admin/cafe", requireAdmin, async (req, res) => {
  const cafeInfo = await db.getCafeInfo(req.cafeId);
  const heroPhotos = await db.getHeroPhotos(req.cafeId);
  res.json({
    cafeInfo,
    heroPhotos,
  });
});

app.put("/api/admin/cafe", requireAdmin, async (req, res) => {
  const updated = await db.updateCafeInfo(req.cafeId, req.body.cafeInfo);
  emitAll("cafe:updated", updated);
  res.json(updated);
});

app.get("/api/admin/hero-photos", requireAdmin, async (req, res) => {
  const photos = await db.getHeroPhotos(req.cafeId);
  res.json(photos);
});

app.post("/api/admin/hero-photos", requireAdmin, (req, res, next) => {
  req.uploadDest = PHOTOS_DIR;
  next();
}, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image" });
  await db.addHeroPhoto(req.cafeId, req.file.filename);
  const photos = await db.getHeroPhotos(req.cafeId);
  emitAll("hero:updated", photos);
  res.status(201).json({ filename: req.file.filename, url: `/photos/${req.file.filename}` });
});

app.delete("/api/admin/hero-photos/:filename", requireAdmin, async (req, res) => {
  const name = req.params.filename;
  if (!name) return res.status(400).json({ error: "Filename required" });

  try {
    const p = path.join(PHOTOS_DIR, name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (err) {
    console.error("Failed to delete file:", err);
  }

  await db.removeHeroPhoto(req.cafeId, name);
  const photos = await db.getHeroPhotos(req.cafeId);
  emitAll("hero:updated", photos);
  res.json({ ok: true });
});

app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// ─── SUPER ADMIN: PLATFORM-WIDE ROUTES ──────────────────────

app.post("/api/super-admin/login", authLimiter, (req, res) => {
  const { key } = req.body;
  if (key !== SUPER_ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect key" });
  }
  res.json({ success: true });
});

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

io.on("connection", () => {});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Café server running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`Default admin password: ${ADMIN_PASSWORD}`);
});
