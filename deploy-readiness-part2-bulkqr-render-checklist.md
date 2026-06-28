# CAFE PROJECT — DEPLOYMENT READINESS, PART 2
# Bulk QR Regeneration + Render Environment Verification
# Paste this entire file into Cursor / Antigravity / Claude Code
# Run this AFTER Part 1 is verified working.
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior full-stack engineer adding one small, well-scoped
convenience feature to an admin panel, then helping verify a deployment
configuration. You make precise, minimal changes.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement every task in order.

---

## CONTEXT — WHAT ALREADY EXISTS

This project already has a fully working, per-café-scoped QR reset
endpoint, confirmed in the actual code:

```js
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
```

This already correctly builds URLs using the REAL request's protocol and
host — meaning a QR generated on your live Render deployment already
gets the correct live domain baked in automatically. There is no bug
here. The only real situation needing a fix is: any QR codes generated
BEFORE you had a working deployment (i.e., generated while still
pointing at `localhost`) need to be regenerated ONCE. Doing this one
table at a time is tedious if a café has many tables — this prompt adds
a single button to do all of them at once.

Part 1 (already complete) fixed the page-gating flash bug on the super
admin pages and added a root landing page. This prompt does not touch
any of that.

---

## TASK 1 — Add a "Reset All QR Codes" backend endpoint

In `server.js`, add this route directly after the existing single-table
`reset-qr` route:

```js
// Resets every table's QR for the current café in one action. Useful
// after a domain change (e.g. moving from local development to a live
// deployed URL) when every previously-generated QR became outdated at
// once, rather than one at a time.
app.post("/api/admin/tables/reset-all-qr", requireAdmin, async (req, res) => {
  const tables = await db.getTables(req.cafeId);
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const updatedTables = [];
  for (const table of tables) {
    const updated = await db.updateTable(req.cafeId, table.id, { tokenVersion: table.tokenVersion + 1 });
    const newToken = signTableToken(table.id, updated.tokenVersion);
    updatedTables.push({
      ...updated,
      qrUrl: `${baseUrl}/c/${req.cafe.slug}/?t=${newToken}`,
    });
  }

  emitAll("table:allQrReset", { count: updatedTables.length });

  res.json({ tables: updatedTables, count: updatedTables.length });
});
```

---

## TASK 2 — Add the button to the admin Tables panel

In `public/admin.html`, find the Tables panel section (where the
existing per-table cards are rendered, likely a container with an id
like `tablesList` or similar — check the exact existing id used by
`admin-tables.js`'s `renderAdminTables()` function and place this
button directly above that container):

```html
<div style="display:flex; justify-content:flex-end; margin-bottom:1rem;">
  <button class="btn btn-ghost" id="resetAllQrBtn">Reset All QR Codes</button>
</div>
```

In `public/js/admin-tables.js`, add this near the other event bindings
inside the `DOMContentLoaded` listener (or wherever the existing
`reset-qr-btn` and `release-table-btn` listeners are currently attached
— place this alongside them, in the same initialization block):

```js
document.getElementById("resetAllQrBtn")?.addEventListener("click", async () => {
  if (!confirm(
    "This will invalidate EVERY table's current QR code for this café. " +
    "Any printed QR codes currently in use will stop working immediately, " +
    "and you will need to print new ones. Continue?"
  )) return;

  try {
    const res = await fetch("/api/admin/tables/reset-all-qr", {
      method: "POST",
      headers: adminHeaders(),
    });
    if (!res.ok) throw new Error("Failed to reset QR codes");

    const data = await res.json();
    alert(`Successfully reset ${data.count} table QR code(s). Reloading the list now.`);
    loadAdminTables();
  } catch (err) {
    console.error(err);
    alert("Could not reset QR codes. Please try again.");
  }
});
```

---

## WHAT NOT TO DO IN THIS PART

- Do not change the existing single-table `reset-qr` route or button —
  both remain useful for resetting just one compromised table without
  affecting every other table in the café
- Do not change how QR images are visually rendered — this only adds a
  bulk trigger for the same existing reset logic
- Do not touch any customer-facing files

---

## HOW TO VERIFY THIS PART WORKS

1. Restart the server locally, log into `/admin.html`
2. Go to the Tables panel, confirm the new "Reset All QR Codes" button
   appears
3. Click it, confirm the warning dialog appears, confirm clicking it
   updates every table's `tokenVersion` and regenerates every QR image
4. Confirm any OLD QR you copied beforehand (from before this reset) now
   correctly shows "This QR code has been reset and is no longer valid"
   when visited

---

# PART 3 — RENDER ENVIRONMENT VERIFICATION (NO CODE — A CHECKLIST FOR YOU)

This part is not for the AI to implement. This is a plain checklist for
you to personally walk through on Render's actual dashboard before
re-deploying, since a mismatch here was the most likely cause of
yesterday's failed deployment.

## Step 1 — Open your Render service's Environment tab

Go to render.com → your service → **Environment** tab on the left.

## Step 2 — Confirm these EXACT four variables exist, with real values

```
DATABASE_URL           → your full Neon connection string
SUPER_ADMIN_PASSWORD   → your real chosen super-admin password
ADMIN_PASSWORD         → your real chosen café-admin seed password
TABLE_TOKEN_SECRET     → your real generated long random secret
```

If `NODE_ENV` is also listed, confirm it says exactly `production`
(lowercase, no extra spaces). If it is NOT listed at all, add it with
value `production` — this is what activates the strict startup check
that refuses to boot with missing secrets, which is a safety feature,
not something to remove.

## Step 3 — Compare against your LOCAL .env, value by value

Open your local `.env` file:
```bash
cat .env
```

For `ADMIN_PASSWORD`, `SUPER_ADMIN_PASSWORD`, and `TABLE_TOKEN_SECRET`
specifically — these do NOT need to match between local and Render
(they're allowed to be different secrets for local dev vs production).
What matters is only that the Render values are NOT empty, NOT the
placeholder defaults (`admin123`, `superadmin123`,
`change-this-in-production-please`), and are pasted in cleanly — watch
out for accidentally including a trailing space or an extra line break
when copy-pasting into Render's input fields, since this is a common,
hard-to-spot cause of "it should work but doesn't."

For `DATABASE_URL` specifically — this ONE value SHOULD be the identical
real Neon connection string in both places, since both your local app
and your deployed app need to reach the exact same live database.

## Step 4 — Trigger a manual redeploy

After confirming/fixing the environment variables, go to the "Manual
Deploy" option on Render and trigger a fresh deploy — don't assume it
picked up environment variable changes automatically without a redeploy.

## Step 5 — Watch the deploy logs in real time

Render shows live logs during deployment. Watch for either:
- A clean startup with no `⚠️ WARNING` or `❌ Refusing to start` messages
  (this confirms all secrets were read correctly)
- OR an immediate crash with `❌ Refusing to start in production with
  insecure default secrets` — if you see this exact message, it
  confirms Step 2/3 above was not done correctly; go back and recheck
  the Environment tab carefully

## Step 6 — Only after a clean startup, test the live URLs

Once logs show the server started successfully (look for whatever
startup confirmation message `server.js` prints, e.g. a "Server running
on port..." line), THEN test:

1. `https://your-app.onrender.com/` — should show the new landing page
2. `https://your-app.onrender.com/admin.html` — login screen, no flash
3. `https://your-app.onrender.com/super-admin-login.html` — log in,
   confirm a clean redirect-free dashboard load
4. In the now-working super admin or café admin, regenerate QR codes
   using the new "Reset All QR Codes" button — confirm the generated
   URLs use your real `onrender.com` domain, not `localhost`
5. Scan one fresh QR with your actual phone on mobile data — confirm
   the full customer ordering flow works end-to-end on the public internet

---

## END OF PART 2 + 3
# ─────────────────────────────────────────────────────────────────────
# This completes deployment readiness. Once verified live and working,
# the platform is ready for real cafés to be onboarded through Super
# Admin and for real customers to scan and order.
# ─────────────────────────────────────────────────────────────────────
