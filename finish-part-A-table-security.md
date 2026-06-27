# CAFE PROJECT — FINISH PART A: REAL TABLE TOKEN SECURITY
# Paste this entire file into Cursor / Antigravity / Claude Code
# This works on your EXISTING codebase as it stands right now.
# Part B (occupancy locking) is already done and working — do not
# rebuild it. You are only replacing the stubbed-out security layer
# underneath it.
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior full-stack engineer working on a real, already-running
café ordering app: plain Node.js + Express + vanilla JS, no database, no
build step, a flat JSON file (`server/data/store.json`) as the data store.
You do not rewrite working code. You do not introduce new frameworks or
dependencies beyond what already exists. You make precise, surgical edits
to specific functions and files, leaving everything else untouched.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement everything in the exact order
listed below.

---

## CURRENT STATE OF THIS CODEBASE — READ CAREFULLY, THIS IS NOT A FRESH START

This project already has a WORKING table occupancy lock system (one
device per table, auto-expiry after 30 min inactivity, manual staff
release). That part is done, tested, and must not be touched or rebuilt.

However, it was built on top of a security layer that was NEVER actually
implemented. Right now, in `server/server.js`, this exact function exists:

```js
function verifyTableToken(t) {
  // Stub behavior for missing Part A
  return { valid: true, tableId: t, table: { label: `Table ${t}` } };
}
```

This stub accepts ANY string as a valid token and just echoes it back as
the table ID. This means `?t=2`, `?t=anything`, `?t=hack-me` all currently
"work" exactly like the old insecure `?table=2` URL parameter did. The
occupancy lock on top of this is real, but the door it's guarding has no
actual lock on the token itself — anyone can still claim any table by
guessing a table number.

You are replacing ONLY this stub and its supporting pieces. You are not
touching `claimTable()`, `acceptClaim()`, `touchTableActivity()`, or the
occupancy logic in `/api/table/verify`, `/api/orders`, `/api/waiter-call`,
or `/api/admin/tables/:id/release` — those already work correctly and
already call `verifyTableToken()` correctly. You are just making
`verifyTableToken()` (and its missing partner `signTableToken()`) real.

Also note: `server.js` line ~301 already has this defensive fallback in
the admin tables route:
```js
const token = typeof signTableToken === "function" ? signTableToken(table.id, table.tokenVersion) : table.id;
```
This was written because `signTableToken` did not exist yet. After you
add `signTableToken`, this line will automatically start working
correctly — you do not need to change this line, just make sure
`signTableToken` is defined above it in the file.

Also note: `public/js/admin-tables.js` already renders QR codes using the
external service `api.qrserver.com`, by passing `table.qrUrl` as the data
to encode. This already works visually as long as `table.qrUrl` contains
a real signed token instead of a plain table number. You do not need to
change `admin-tables.js` at all — fixing the backend automatically fixes
what URL gets encoded into the QR image.

---

## WHAT YOU ARE BUILDING — EXACT SCOPE

1. Real HMAC-signed table tokens (replacing the stub)
2. Token versioning so a "Reset QR" action can invalidate old QR codes
3. A `tokenVersion` field already exists on each table object in
   `store.json` (Part B already added it) — you are now actually USING
   it for the first time
4. A "Reset QR" admin endpoint and button (currently missing entirely)
5. Making sure the existing `/api/table/verify` route correctly rejects
   genuinely invalid/forged/outdated tokens, instead of accepting
   everything like it does now

You are NOT building: occupancy locking (done), QR visual rendering
(done via external API, leave as is), menu management (done), order
management (done).

---

## TASK 1 — Add the signing secret

In `server/server.js`, near the top, right after the existing requires
and before `const app = express();`, add:

```js
const crypto = require("crypto");
```

Right after the line that defines `ADMIN_PASSWORD`, add:

```js
const TABLE_TOKEN_SECRET =
  process.env.TABLE_TOKEN_SECRET || "change-this-in-production-please";
// In production, set TABLE_TOKEN_SECRET as a real environment variable.
// This secret is what makes table tokens impossible to forge — anyone
// without this exact secret cannot produce a token that passes
// verification, no matter what tableId or version they try to guess.
```

---

## TASK 2 — Replace the stub with real signing and verification

Find this exact block in `server/server.js`:

```js
function verifyTableToken(t) {
  // Stub behavior for missing Part A
  return { valid: true, tableId: t, table: { label: `Table ${t}` } };
}
```

Replace it ENTIRELY with:

```js
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
function verifyTableToken(token) {
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

  const store = readStore();
  const table = (store.tables || []).find((t) => t.id === tableId);

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

IMPORTANT: Place this replacement BEFORE the line:
```js
const TABLE_INACTIVITY_LIMIT_MS = 30 * 60 * 1000; // 30 minutes
```
and before `claimTable()`, since `claimTable()` calls `readStore()` and
the existing code order should be preserved — `verifyTableToken` is
called by routes further down, so it just needs to exist somewhere above
its first use, consistent with where the stub currently sits.

---

## TASK 3 — Verify all existing call sites still work (no changes needed, just confirm)

Go through `server.js` and confirm these locations already call
`verifyTableToken()` correctly — they were already written correctly
against the OLD stub's return shape, and the NEW real implementation
returns the exact same shape (`{ valid, tableId, table, reason }`), so
these should need ZERO changes:

- `app.get("/api/table/verify", ...)` — already destructures
  `result.valid`, `result.tableId`, `result.table.label`, `claim.reason`
- `app.post("/api/orders", ...)` — already checks `verification.valid`
  and uses `verification.tableId`
- `app.post("/api/waiter-call", ...)` — same pattern

Do not modify these three routes. Just confirm by reading them that they
align with the new function's return shape. If you find any mismatch,
fix only the mismatch, not the whole route.

---

## TASK 4 — Add the "Reset QR" admin endpoint

This endpoint does not exist yet. Add it in the "Admin API" section of
`server.js`, near the existing `app.get("/api/admin/tables", ...)` route:

```js
// Resets a table's QR code by incrementing its tokenVersion. Any
// previously printed/shared QR for this table instantly stops working
// after this call, even though TABLE_TOKEN_SECRET itself never changes.
// Use this if a QR code is suspected to have been photographed and
// shared outside the cafe, or simply needs reprinting.
app.post("/api/admin/tables/:id/reset-qr", requireAdmin, (req, res) => {
  const store = readStore();
  const table = (store.tables || []).find((t) => t.id === req.params.id);
  if (!table) return res.status(404).json({ error: "Table not found" });

  table.tokenVersion = (table.tokenVersion || 1) + 1;
  writeStore(store);

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const newToken = signTableToken(table.id, table.tokenVersion);

  emitAll("table:qrReset", { id: table.id });

  res.json({
    ...table,
    qrUrl: `${baseUrl}/?t=${newToken}`,
  });
});
```

Place this route definition ABOVE `app.get("/api/admin/tables", ...)` in
the file (order doesn't strictly matter for Express routing here since
the paths are distinct, but keep related table routes grouped together
for readability).

---

## TASK 5 — Add a way to create new tables (currently missing)

Right now `store.tables` has exactly 10 hardcoded tables (1–10) and there
is no API to add more if the cafe grows. Add this in the same section:

```js
// Adds a brand new table — e.g. the cafe added more seating.
app.post("/api/admin/tables", requireAdmin, (req, res) => {
  const store = readStore();
  const { id, label } = req.body;

  if (!id) return res.status(400).json({ error: "Table id is required" });
  if ((store.tables || []).find((t) => t.id === id)) {
    return res.status(409).json({ error: "A table with this id already exists" });
  }

  if (!store.tables) store.tables = [];

  const newTable = {
    id: String(id),
    label: label || `Table ${id}`,
    tokenVersion: 1,
    status: "free",
    sessionId: null,
    claimedAt: null,
    lastActivityAt: null,
  };

  store.tables.push(newTable);
  writeStore(store);

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const token = signTableToken(newTable.id, newTable.tokenVersion);

  res.status(201).json({ ...newTable, qrUrl: `${baseUrl}/?t=${token}` });
});
```

---

## TASK 6 — Frontend: add "Reset QR" and "Add Table" buttons to the admin panel

`public/js/admin-tables.js` already renders each table's card with a
"Release Table" button (when occupied) and an "Open Table" link. Add a
"Reset QR" button that is ALWAYS visible (regardless of occupied/free
status), since resetting is independent of occupancy.

Find this block inside `renderAdminTables()`:

```js
<div class="admin-menu-actions" style="flex-direction: column; gap: 0.5rem;">
  ${actionBtn}
  <a href="${table.qrUrl}" target="_blank" class="btn btn-ghost" style="text-align: center;">Open Table</a>
</div>
```

Replace it with:

```js
<div class="admin-menu-actions" style="flex-direction: column; gap: 0.5rem;">
  ${actionBtn}
  <a href="${table.qrUrl}" target="_blank" class="btn btn-ghost" style="text-align: center;">Open Table</a>
  <button class="btn btn-ghost reset-qr-btn" data-id="${table.id}" style="text-align: center;">Reset QR</button>
</div>
```

Then, in the same file, find the existing event-binding block at the
bottom of `renderAdminTables()`:

```js
container.querySelectorAll(".release-table-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (!confirm("Free up this table for the next customer?")) return;

    const id = btn.dataset.id;
    try {
      await fetch(`/api/admin/tables/${id}/release`, {
        method: "POST",
        headers: adminHeaders()
      });
      loadAdminTables();
    } catch (err) {
      console.error("Failed to release table", err);
    }
  });
});
```

Add this immediately after it, inside the same function:

```js
container.querySelectorAll(".reset-qr-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (!confirm("This will invalidate the current QR code for this table. Anyone using the old printed QR will no longer be able to order. Continue?")) return;

    const id = btn.dataset.id;
    try {
      await fetch(`/api/admin/tables/${id}/reset-qr`, {
        method: "POST",
        headers: adminHeaders()
      });
      loadAdminTables();
    } catch (err) {
      console.error("Failed to reset QR", err);
      alert("Could not reset this table's QR code. Please try again.");
    }
  });
});
```

---

## TASK 7 — Frontend: add an "Add Table" form to the admin panel

Check `public/admin.html` for the existing tables panel section (likely
has an element with `id="adminTablesList"` or similar, referenced by
`admin-tables.js`). Find that section and add this form right above the
`<div id="adminTablesList">` element:

```html
<form id="addTableForm" style="display:flex; gap:0.5rem; margin-bottom:1.5rem; flex-wrap:wrap;">
  <input type="text" id="newTableId" placeholder="Table ID (e.g. 11)" required style="flex:1; min-width:140px;" />
  <input type="text" id="newTableLabel" placeholder="Label (e.g. Terrace 1)" style="flex:1; min-width:140px;" />
  <button type="submit" class="btn btn-primary">Add Table</button>
</form>
```

In `public/js/admin-tables.js`, add this near the bottom, inside the
existing `DOMContentLoaded` listener (do not create a second listener):

```js
const addTableForm = document.getElementById("addTableForm");
if (addTableForm) {
  addTableForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("newTableId").value.trim();
    const label = document.getElementById("newTableLabel").value.trim();

    if (!id) return;

    try {
      const res = await fetch("/api/admin/tables", {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id, label }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add table");
      }
      addTableForm.reset();
      loadAdminTables();
    } catch (err) {
      console.error(err);
      alert(err.message || "Could not add table. It may already exist.");
    }
  });
}
```

---

## TASK 8 — Frontend customer side: confirm `utils.js` needs ZERO changes

`public/js/utils.js` already correctly implements `ensureTableSession()`,
sends `?t=` as the token, stores it in `sessionStorage`, and handles the
409 "occupied" case distinctly from invalid-token cases. This was already
written correctly against the intended final API contract — it just
hasn't had a real backend to talk to. Do not modify this file. Confirm
by reading it that it matches the API responses now produced by the real
`verifyTableToken()` — it does.

Also confirm `public/js/cart.js` and `public/js/orders.js` already send
both `tableToken` and `sessionId` in their request bodies for
`placeOrder()` and `callWaiter()` — they should already, since Part B's
backend already requires both fields. Do not change these files unless
you find an actual mismatch while reading them.

---

## WHAT NOT TO DO

- Do not touch `claimTable()`, `acceptClaim()`, or `touchTableActivity()`
  — these already work correctly
- Do not touch the occupancy status badges or polling logic in
  `admin-tables.js` beyond adding the two new buttons/form described above
- Do not change how QR codes are visually rendered (the external
  `api.qrserver.com` image approach already works and should be left as is)
- Do not add token expiry — tokens remain permanent until manually reset
- Do not introduce a database or any new npm dependency — `crypto` is
  built into Node.js, nothing to install
- Do not change the 10 existing seeded tables' data beyond what
  `tokenVersion` increments naturally do when reset

---

## HOW TO VERIFY THIS IS DONE CORRECTLY

1. Restart the server: `npm run dev` (or `node server/server.js`)
2. Open `http://localhost:3000/admin.html`, log in
3. Go to the Tables panel — each table card should now show a QR code
   image that encodes a long signed token in its URL (visibly longer
   and more complex than just `?t=1`), not the plain table number
4. Open one table's `qrUrl` directly in a browser — should load the
   customer home page normally
5. Manually try visiting `http://localhost:3000/?t=garbage12345` — should
   be rejected with "Invalid table token" or similar, NOT silently accepted
6. Manually try visiting `http://localhost:3000/?table=2` (the OLD
   insecure query param name, not `?t=`) — should be rejected since there
   is no `?t=` token at all, falls through to "Please scan the QR code..."
7. On a table's QR `qrUrl`, place a test order — confirm it succeeds and
   the order's `tableNumber` in `store.json` matches the correct table
8. In admin, click "Reset QR" on a table that has NOT been visited yet
   — confirm `tokenVersion` increments in `store.json`
9. Try visiting the OLD `qrUrl` for that same table (copy it before
   resetting, for this test) — should now be rejected with "This QR code
   has been reset and is no longer valid"
10. Visit the NEW `qrUrl` shown after reset — should work normally
11. Add a new table via the "Add Table" form — confirm it appears in the
    list with a working QR immediately
12. Confirm the existing occupancy lock STILL works exactly as before:
    two different browsers/incognito windows hitting the same table's
    current valid QR — second one gets blocked with "table is currently
    in use"

---

## FINAL STATE AFTER THIS PROMPT

Once this is complete, your café ordering system will have:
- Real cryptographically signed, unforgeable table tokens
- Permanent QR codes that only change when an admin explicitly resets them
- Full table occupancy locking (one device per table, already working)
- Auto-expiry after 30 minutes of inactivity (already working)
- Manual staff release (already working)
- Full menu and order management (already working)
- The ability to add new tables as the cafe grows

This closes out all outstanding security work from the original plan.
There is no further "Part C" needed for table security — this is the
complete, finished system.

---

## END OF PROMPT
# ─────────────────────────────────────────────────────────────────────
