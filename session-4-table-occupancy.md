# CAFE PROJECT — SESSION 4, PART B
# Table Occupancy Lock (One Device Per Table)
# Paste this entire file into Cursor / Antigravity / Claude Code
# This is a CONTINUATION of Part A — paste Part A's completion summary
# above this prompt before pasting this one.
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior full-stack engineer working on a plain Node.js + Express +
vanilla JS café ordering app (no database, no framework, no build step —
a flat JSON file is the data store). You extend existing code carefully
and do not introduce new tools or frameworks. You write simple, readable,
well-commented code that fits the existing style of this project.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement everything in order.

---

## CONTEXT — WHAT ALREADY EXISTS (FROM PART A)

Part A already implemented:
- Signed, permanent table tokens (`tableId.tokenVersion.signature`,
  base64url-encoded) generated via `signTableToken()` and verified via
  `verifyTableToken()` in `server/server.js`
- `store.tables` array in `server/data/store.json`, each table shaped:
  ```json
  {
    "id": "1",
    "label": "Table 1",
    "tokenVersion": 1,
    "status": "free",
    "sessionId": null,
    "claimedAt": null,
    "lastActivityAt": null
  }
  ```
  Note: `status`, `sessionId`, `claimedAt`, `lastActivityAt` were
  scaffolded in Part A but NOT used yet — you are implementing their
  actual logic now in Part B.
- `GET /api/table/verify?t=...` — verifies a token and returns table info
- `POST /api/orders` and `POST /api/waiter-call` — both now require and
  verify `tableToken`, and derive `tableNumber` only from the verified
  token, never from client input
- `public/js/utils.js` has `ensureTableSession()`, `getTableToken()`,
  `getTableNumber()`, `getTableLabel()`, all using `sessionStorage`
- Admin panel has a "Tables & QR Codes" section with QR display,
  download, and "Reset QR" per table

You are building on top of all of this. Do not undo or duplicate it.

---

## WHAT YOU ARE BUILDING IN THIS PART

A table can only be actively used by ONE device at a time. If a second
device tries to use the same table while the first device is still
active, it is blocked with a clear message.

The rules, exactly:

1. When a device's table token is verified successfully (in
   `ensureTableSession()`), the server attempts to **claim** the table
   for that device.
2. If the table is currently `"free"` → claim succeeds. The table
   becomes `"occupied"`, tied to a new `sessionId` generated for this
   device. The device stores this `sessionId` and uses it on every
   future request this visit.
3. If the table is currently `"occupied"` by a DIFFERENT `sessionId`,
   AND that session has had activity within the last 30 minutes →
   claim is REJECTED. The device sees a clear "table is currently in
   use" message and cannot proceed.
4. If the table is `"occupied"` but `lastActivityAt` is OLDER than
   30 minutes → treat the old session as abandoned. Auto-release it,
   and claim the table fresh for the new device.
5. If the SAME device (matching `sessionId`, e.g. they refreshed the
   page or came back) tries to claim a table it already holds → this
   always succeeds, it's just continuing their own session.
6. Every order placement and waiter-call request from a device updates
   that table's `lastActivityAt` to "now" — this is what keeps an
   actively-browsing customer's claim alive and is the basis for the
   30-minute auto-expiry.
7. Staff can manually release any table from the admin panel at any
   time (e.g. customer paid and left) — this immediately frees the
   table for the next customer, regardless of the 30-minute timer.

---

## TASK 1 — Add a session ID generator

In `server/server.js`, you already have `uuid` imported. Use it to
generate session IDs — no new dependency needed.

```js
function generateSessionId() {
  return uuidv4();
}
```

---

## TASK 2 — Add the claim logic as a reusable function

Add this function in `server.js`, near `verifyTableToken`:

```js
const TABLE_INACTIVITY_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

// Attempts to claim a table for a device. Returns either a success
// with a sessionId the device should remember, or a rejection with
// a human-readable reason.
function claimTable(tableId, existingSessionId) {
  const store = readStore();
  const table = store.tables.find((t) => t.id === tableId);

  if (!table) {
    return { ok: false, reason: "Table not found" };
  }

  const now = Date.now();
  const lastActivity = table.lastActivityAt ? new Date(table.lastActivityAt).getTime() : 0;
  const isStale = now - lastActivity > TABLE_INACTIVITY_LIMIT_MS;

  // Case 1: table is free — claim it fresh.
  if (table.status === "free" || !table.sessionId) {
    return acceptClaim(store, table, generateSessionId());
  }

  // Case 2: this exact device already holds this table — just refresh it.
  if (existingSessionId && table.sessionId === existingSessionId) {
    return acceptClaim(store, table, existingSessionId);
  }

  // Case 3: occupied by someone else, but their session went stale — take over.
  if (isStale) {
    return acceptClaim(store, table, generateSessionId());
  }

  // Case 4: occupied by someone else, still active — reject.
  return {
    ok: false,
    reason: "This table is currently in use by another device. If you just sat down, please ask our staff for help.",
  };
}

function acceptClaim(store, table, sessionId) {
  table.status = "occupied";
  table.sessionId = sessionId;
  table.claimedAt = table.claimedAt || new Date().toISOString();
  table.lastActivityAt = new Date().toISOString();
  writeStore(store);
  return { ok: true, sessionId, tableId: table.id, label: table.label };
}

// Call this on every authenticated customer action (placing an order,
// calling a waiter, etc.) to keep the table's session alive.
function touchTableActivity(tableId, sessionId) {
  const store = readStore();
  const table = store.tables.find((t) => t.id === tableId);
  if (table && table.sessionId === sessionId) {
    table.lastActivityAt = new Date().toISOString();
    writeStore(store);
  }
}
```

---

## TASK 3 — Update `/api/table/verify` to also claim the table

Modify the route from Part A:

```js
app.get("/api/table/verify", (req, res) => {
  const { t, sid } = req.query; // sid = existing sessionId, if the device has one already

  if (!t) {
    return res.status(400).json({ valid: false, reason: "No table token provided" });
  }

  const result = verifyTableToken(t);
  if (!result.valid) {
    return res.status(403).json({ valid: false, reason: result.reason });
  }

  const claim = claimTable(result.tableId, sid || null);
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
```

Note the new `409 Conflict` status specifically for the "table occupied"
case — this lets the frontend distinguish "invalid QR" from "valid QR,
but someone else is already here" and show a different message for each.

---

## TASK 4 — Require sessionId on order and waiter-call routes, and touch activity

Update `POST /api/orders` to also accept and validate `sessionId`, and
call `touchTableActivity` on success:

```js
app.post("/api/orders", (req, res) => {
  const { tableToken, sessionId, items } = req.body;

  if (!tableToken || !sessionId) {
    return res.status(400).json({ error: "Missing table session. Please rescan the QR code on your table." });
  }

  const verification = verifyTableToken(tableToken);
  if (!verification.valid) {
    return res.status(403).json({ error: verification.reason });
  }

  const store = readStore();
  const table = store.tables.find((t) => t.id === verification.tableId);
  if (!table || table.sessionId !== sessionId) {
    return res.status(403).json({ error: "Your table session has expired or was taken over by another device. Please rescan the QR code." });
  }

  if (!items?.length) {
    return res.status(400).json({ error: "Cart is empty" });
  }

  for (const item of items) {
    const menuItem = store.menuItems.find((m) => m.id === item.id);
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

  store.orders.unshift(order);
  writeStore(store);
  touchTableActivity(verification.tableId, sessionId);
  emitAll("order:new", order);
  res.status(201).json(order);
});
```

Apply the exact same `sessionId` check and `touchTableActivity` call to
`POST /api/waiter-call`.

---

## TASK 5 — Admin endpoints for table status and manual release

Add to the "Admin API" section in `server.js`:

```js
// Manually frees a table immediately, regardless of activity timing.
// Use this after a customer pays and leaves, so the table is ready
// for the next customer right away.
app.post("/api/admin/tables/:id/release", requireAdmin, (req, res) => {
  const store = readStore();
  const table = store.tables.find((t) => t.id === req.params.id);
  if (!table) return res.status(404).json({ error: "Table not found" });

  table.status = "free";
  table.sessionId = null;
  table.claimedAt = null;
  table.lastActivityAt = null;
  writeStore(store);

  emitAll("table:released", { id: table.id });
  res.json(table);
});
```

Update the existing `GET /api/admin/tables` route (from Part A) to also
report a live `isStale` flag, so the admin UI can show "occupied (idle)"
vs "occupied (active)":

```js
app.get("/api/admin/tables", requireAdmin, (req, res) => {
  const store = readStore();
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const now = Date.now();

  const tables = store.tables.map((table) => {
    const token = signTableToken(table.id, table.tokenVersion);
    const lastActivity = table.lastActivityAt ? new Date(table.lastActivityAt).getTime() : 0;
    const minutesIdle = table.lastActivityAt ? Math.round((now - lastActivity) / 60000) : null;
    const isStale = table.status === "occupied" && now - lastActivity > TABLE_INACTIVITY_LIMIT_MS;

    return {
      ...table,
      qrUrl: `${baseUrl}/?t=${token}`,
      minutesIdle,
      isStale,
    };
  });

  res.json(tables);
});
```

---

## TASK 6 — Frontend: pass sessionId through, handle the "occupied" case

Update `ensureTableSession()` in `public/js/utils.js`:

```js
const TABLE_SESSION_ID_KEY = "cafe_table_session_id";

async function ensureTableSession() {
  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get("t");
  const existingSessionId = sessionStorage.getItem(TABLE_SESSION_ID_KEY);

  const tokenToUse = tokenFromUrl || sessionStorage.getItem(TABLE_TOKEN_KEY);

  if (!tokenToUse) {
    showTableError("Please scan the QR code on your table to get started.");
    return false;
  }

  try {
    const url = `/api/table/verify?t=${encodeURIComponent(tokenToUse)}` +
      (existingSessionId ? `&sid=${encodeURIComponent(existingSessionId)}` : "");
    const res = await fetch(url);
    const data = await res.json();

    if (!data.valid) {
      if (res.status === 409 && data.occupied) {
        showTableError(data.reason);
      } else {
        showTableError(data.reason || "This QR code is not valid.");
      }
      return false;
    }

    sessionStorage.setItem(TABLE_TOKEN_KEY, tokenToUse);
    sessionStorage.setItem(TABLE_ID_KEY, data.tableId);
    sessionStorage.setItem(TABLE_LABEL_KEY, data.label);
    sessionStorage.setItem(TABLE_SESSION_ID_KEY, data.sessionId);
    return true;
  } catch (err) {
    showTableError("Could not verify your table. Please check your connection and rescan the QR code.");
    return false;
  }
}

function getTableSessionId() {
  return sessionStorage.getItem(TABLE_SESSION_ID_KEY) || null;
}
```

Update `placeOrder()` in `public/js/cart.js` to include `sessionId`:

```js
body: JSON.stringify({
  tableToken: getTableToken(),
  sessionId: getTableSessionId(),
  items: cart,
}),
```

Update `callWaiter()` in `public/js/orders.js` the same way:

```js
body: JSON.stringify({
  tableToken: getTableToken(),
  sessionId: getTableSessionId(),
  orderId: orderId,
}),
```

Also handle the case where the server rejects a request mid-session
because another device took over the table (e.g. staff manually
released it and someone else claimed it). In both `cart.js`'s
`placeOrder()` and `orders.js`'s `callWaiter()`, if the response status
is `403`, show the server's error message via `showToast()` AND prompt
the customer to rescan — do not silently fail.

---

## TASK 7 — Admin panel: show live table status

Update `public/js/admin-tables.js` (from Part A) so each table card also
shows occupancy status clearly:

- If `status === "free"` → green badge: "Free"
- If `status === "occupied"` and `isStale === false` → amber badge:
  "Occupied" (with "active Xm ago" subtext)
- If `status === "occupied"` and `isStale === true` → grey badge:
  "Occupied (idle, will auto-release)"
- Add a "Release Table" button on every occupied table card. On click,
  show a confirm dialog ("Free up this table for the next customer?"),
  then call `POST /api/admin/tables/:id/release` and refresh that card

Make this list auto-refresh every 15 seconds while the admin is on this
page (simple `setInterval`, cleared if the admin navigates away), so
staff don't have to manually refresh to see current occupancy.

---

## WHAT NOT TO DO IN THIS PART

- Do not allow multiple devices on one table under any setting — this
  was explicitly decided as strict, one-device-per-table
- Do not make the 30-minute timer configurable via the UI in this
  session — hardcode `TABLE_INACTIVITY_LIMIT_MS`, we can expose it
  later if needed
- Do not touch the QR token signing/reset logic from Part A — it
  already works, leave it as is
- Do not add push notifications or sound alerts for table releases —
  out of scope here

---

## HOW TO VERIFY THIS PART WORKS

1. Restart the server: `npm run dev`
2. On Device/Browser A: visit Table 1's QR URL — should succeed, land
   on the home page normally
3. On Device/Browser B (or an incognito window, simulating a second
   device): visit the SAME Table 1 QR URL — should be blocked with
   "This table is currently in use by another device..."
4. On Device/Browser A: place an order — confirm it works (same device,
   same session, should never be blocked by its own claim)
5. In admin panel, confirm Table 1 shows "Occupied" with recent activity
6. Click "Release Table" in admin for Table 1
7. On Device/Browser B: retry visiting Table 1's QR URL — should now
   succeed immediately, since it was manually released
8. To test auto-expiry without waiting 30 minutes: temporarily lower
   `TABLE_INACTIVITY_LIMIT_MS` to `10000` (10 seconds) locally, confirm
   a second device can claim the table after waiting past that window,
   then restore it to 30 minutes before considering this done

---

## SESSION CONTINUITY — SAVE THIS SUMMARY

When done, write a short summary covering:
- Confirm one-device-per-table is enforced on claim, order, and
  waiter-call requests
- Confirm auto-expiry (30 min inactivity) and manual staff release both
  work
- List any files modified
- Confirm the final shape of a table object in `store.json` after all
  of Part A + Part B

This is the final part of Session 4. Your café ordering system's table
security is now complete: permanent signed QR tokens, server-side
verification on every order, and single-device occupancy locking.

---

## END OF SESSION 4 — PART B (FINAL)
# ─────────────────────────────────────────────────────────────────────
