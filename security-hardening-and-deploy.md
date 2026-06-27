# CAFE PROJECT — SECURITY HARDENING (PRE-DEPLOYMENT)
# Paste this entire file into Cursor / Antigravity / Claude Code
# This works on your EXISTING, working, multi-tenant, database-backed
# codebase. After this prompt is complete and verified, you deploy.
# Deployment instructions are at the very end of this file — read them
# now, but run them AFTER the code changes below, not before.
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior backend engineer who specializes in hardening real
applications before they go live to the public internet. You make
precise, minimal, surgical changes — fixing exactly what's insecure
without touching anything that already works correctly. You do not
add new frameworks. You do not redesign existing flows beyond what's
needed to close the specific gap described.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement every task in the exact
order listed, then verify each one before moving to the next.

---

## CONTEXT — CURRENT STATE OF THIS PROJECT (CONFIRMED BY READING THE ACTUAL CODE)

This is a real, working, multi-tenant café ordering platform: Node.js +
Express + vanilla JS frontend, PostgreSQL (hosted on Neon) for all data,
with a Super Admin layer already built (login, dashboard, café
management) on top of a `cafes` table and `cafe_id` scoping across every
other table.

A security review of the live codebase found the following CONFIRMED
issues, which this prompt fixes one by one:

1. `.env` currently has `SUPER_ADMIN_PASSWORD` set, but is MISSING
   `ADMIN_PASSWORD` and `TABLE_TOKEN_SECRET` entirely — meaning both are
   silently falling back to their hardcoded insecure defaults
   (`"admin123"` and `"change-this-in-production-please"`) right now,
   in the actual running app.
2. There is no rate-limiting anywhere in `server.js` — `express-rate-limit`
   is not even installed. Login-adjacent and super-admin routes are
   brute-forceable with no friction at all.
3. `public/super-admin-login.html` sends the super-admin secret as a
   URL query string (`?key=...`) in a `fetch` GET request — this lands
   in server logs and browser history in plain text.
4. `public/js/utils.js` has `const CAFE_SLUG = "cafe-crafted";` hardcoded
   — this was a deliberate, explicitly-documented decision for when only
   one café existed. It needs to become dynamic now that Super Admin can
   create additional cafés.

This prompt fixes exactly these four things, carefully, then prepares
the project for deployment. It does NOT touch order history, table
delete, pagination, or notification features — those are separate,
smaller follow-up items, intentionally out of scope here so this prompt
stays focused on what's blocking a safe public launch.

---

# PART A — FIX SECRETS (NO CODE CHANGE — CONFIGURATION ONLY)

## TASK A1 — Generate real secrets

This task has no code to write. It is the most important step in this
entire prompt and must not be skipped. Run these commands locally to
generate three strong, random secrets:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Run this three separate times (or once per line above) to get three
DIFFERENT random values. Update your local `.env` file so it contains
all of these, each with a real generated value, none left as a
placeholder:

```
DATABASE_URL=<already set — do not change>
SUPER_ADMIN_PASSWORD=<paste first generated value here>
ADMIN_PASSWORD=<paste second generated value here>
TABLE_TOKEN_SECRET=<paste third generated value here>
```

IMPORTANT CONSEQUENCE — changing `ADMIN_PASSWORD` after cafés already
exist with their own per-café `admin_key` (from the Super Admin
migration) does NOT affect existing cafés, since they no longer read
`ADMIN_PASSWORD` directly — that constant is now only used as the seed
value for brand-new café creation in some code paths. Confirm this by
checking `server.js` for any remaining direct use of `ADMIN_PASSWORD` in
the live request-handling logic (not just as a one-time seed default) —
if found, leave it as is, since it does not block this security fix.

Changing `TABLE_TOKEN_SECRET` DOES have a real consequence: every
table's currently-issued QR token becomes invalid the moment this value
changes, because the signature no longer matches. This is expected and
correct — you must reprint/redistribute QR codes for every existing café
after this change. Do this once, deliberately, not repeatedly.

## TASK A2 — Confirm no code falls back to defaults silently in production

In `server/server.js`, find these three lines:
```js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "superadmin123";
const TABLE_TOKEN_SECRET = process.env.TABLE_TOKEN_SECRET || "change-this-in-production-please";
```

Add a startup check right after these three lines (do not remove the
fallback values themselves — they remain useful for quick local
development without a `.env` file, but the app must loudly warn instead
of silently using them):

```js
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
```

This means: locally, you get a loud warning but the app still runs (so
development isn't blocked). In production (which we will configure to
set `NODE_ENV=production` during deployment later in this prompt), the
app refuses to start at all if any of these three secrets are missing
— a hard safety rail so you cannot accidentally deploy with defaults.

---

# PART B — ADD RATE LIMITING

## TASK B1 — Install the package

```bash
npm install express-rate-limit
```

## TASK B2 — Create the limiters

Create `server/middleware/rateLimiters.js`:

```js
const rateLimit = require("express-rate-limit");

// Applies to anything checking a password/key — café admin login
// attempts, super-admin login attempts. Generous enough for a real
// person mistyping a password a few times, strict enough to make
// scripted brute-forcing impractical.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// Applies broadly across all /api/admin and /api/super-admin routes,
// as a general safety net beyond just the login check — prevents any
// single IP from hammering admin-side endpoints at high volume.
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

// A looser limiter for customer-facing routes — high enough that real
// customers placing orders or browsing the menu are never affected,
// but still a backstop against abuse (e.g. a script spamming orders).
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

module.exports = { authLimiter, adminLimiter, publicLimiter };
```

## TASK B3 — Apply the limiters in server.js

Near the top, after other middleware setup (`app.use(express.json())`,
etc.), add:

```js
const { authLimiter, adminLimiter, publicLimiter } = require("./middleware/rateLimiters");

app.use("/api/admin", adminLimiter);
app.use("/api/super-admin", adminLimiter);
app.use("/api", publicLimiter);
```

IMPORTANT — route ordering matters in Express. These three lines must
be placed BEFORE any `app.get("/api/...")` / `app.post("/api/...")`
route definitions, so the limiter middleware actually runs first for
matching paths. The more specific paths (`/api/admin`, `/api/super-admin`)
must also be registered before the broader `/api` catch-all, otherwise
the broader one would shadow them — the order shown above (specific
first, broad last) is correct, keep it exactly this way.

Then, specifically on the super-admin login check route and any
explicit "verify this admin key" type route, ALSO apply the stricter
`authLimiter` directly on top of the broader one already applied. Find
wherever the super-admin login is verified (this currently happens via
`GET /api/super-admin/platform-stats?key=...` being used as a makeshift
login check — this gets properly fixed into a real login route in Part
C below, and that NEW route is where `authLimiter` actually gets
attached directly).

---

# PART C — FIX THE LOGIN KEY-IN-URL ISSUE

## TASK C1 — Add a real POST-based login endpoint for super admin

Currently, `public/super-admin-login.html` "logs in" by sending the
secret key as a GET query parameter to `/api/super-admin/platform-stats`
— using a stats endpoint as an improvised login check. Fix this by
adding a real, dedicated login endpoint that accepts the key in the
POST body instead.

In `server.js`, add this route near the other super-admin routes:

```js
app.post("/api/super-admin/login", authLimiter, (req, res) => {
  const { key } = req.body;
  if (key !== SUPER_ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect key" });
  }
  res.json({ success: true });
});
```

## TASK C2 — Update the login page to use it

In `public/super-admin-login.html`, replace the existing login script
block:

```js
document.getElementById("loginBtn").addEventListener("click", async () => {
  const key = document.getElementById("superAdminKeyInput").value.trim();
  const errorEl = document.getElementById("loginError");
  errorEl.style.display = "none";

  if (!key) return;

  try {
    const res = await fetch("/api/super-admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error("Invalid key");

    sessionStorage.setItem("superAdminKey", key);
    window.location.href = "/super-admin-dashboard.html";
  } catch (err) {
    errorEl.textContent = "Incorrect key. Please try again.";
    errorEl.style.display = "block";
  }
});
```

This is the ONLY change to this file. Every other super-admin route
(dashboard stats, café list, café detail, etc.) already correctly uses
the `x-super-admin-key` HEADER via `superAdminHeaders()` in
`super-admin.js` and `super-admin-detail.js` — those were never the
problem. Confirm by reading those two files that they already send the
key as a header, not a query string, and leave them unchanged. Only the
initial login check on this one page had the issue.

## TASK C3 — Apply the same fix to café admin login, if it has the same issue

Check `public/admin.html` and its corresponding JS for how café admin
login currently works. If it ALSO sends the admin key as a URL query
string for its initial login check (rather than just using it as a
header on every subsequent request, which is fine), apply the identical
fix: add a `POST /api/admin/login` route mirroring the pattern above but
checking against `db.getCafeByAdminKey(key)` instead of the single
`SUPER_ADMIN_PASSWORD` constant, and update the login form's fetch call
to use it.

If café admin login already only uses the key as a header (not a query
string) for its check, no change is needed here — confirm which case is
true by reading the actual code before making any edit.

---

# PART D — MAKE CAFE_SLUG DYNAMIC

## DESIGN DECISION

Now that Super Admin can create multiple cafés, the hardcoded
`CAFE_SLUG = "cafe-crafted"` would make every newly created café's
customer-facing site show the WRONG café's data. This must become
dynamic. The cleanest fix that requires no changes to your QR code
generation, no subdomain configuration, and no hosting complexity: pass
the café's slug as a URL path segment, and read it from the URL on the
frontend.

## TASK D1 — Update Express to serve the customer site under a café-scoped path

In `server.js`, find where static files are served
(`app.use(express.static(...))` for the `public` folder). Add a new
route, placed BEFORE the static file serving, that captures the café
slug from the URL and serves the same `index.html` / `menu.html` etc.,
but the JS on those pages will read the slug from the URL itself — no
server-side templating needed.

```js
// Customer-facing pages are now accessed as /c/:cafeSlug/ instead of
// the site root. This single route handles the entry point; the
// existing static file serving below continues to handle menu.html,
// cart.html, orders.html, and all CSS/JS/images exactly as before —
// those pages will read the cafeSlug from the URL using the helper
// added in Task D2.
app.get("/c/:cafeSlug", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});
app.get("/c/:cafeSlug/menu", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "menu.html"));
});
app.get("/c/:cafeSlug/cart", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "cart.html"));
});
app.get("/c/:cafeSlug/orders", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "orders.html"));
});
```

Confirm the exact existing static-file-serving line and `path` import
already present in `server.js`, and place these new routes consistent
with that existing setup (adjust the relative path in `path.join` if the
existing static serving uses a different reference point — match
whatever pattern already works for serving these HTML files today).

## TASK D2 — Replace the hardcoded constant with a URL-derived value

In `public/js/utils.js`, replace:

```js
const CAFE_SLUG = "cafe-crafted";
```

with:

```js
// Reads the café slug from the URL path, e.g. /c/blue-tokai-nashik/menu
// → "blue-tokai-nashik". Falls back to a default only for direct local
// testing without the /c/:slug prefix — this fallback should not be
// relied on in production, where every real link includes it.
function getCafeSlugFromUrl() {
  const match = window.location.pathname.match(/^\/c\/([^/]+)/);
  if (match) return match[1];
  console.warn("No cafeSlug found in URL path — falling back to default. This should not happen in production.");
  return "cafe-crafted";
}

const CAFE_SLUG = getCafeSlugFromUrl();
```

Every existing usage of `CAFE_SLUG` and `withCafeSlug(...)` elsewhere in
the codebase continues to work unchanged, since `CAFE_SLUG` is still the
same constant name with the same string value at runtime — just sourced
correctly now instead of hardcoded.

## TASK D3 — Update QR token generation to encode the full café-scoped URL

In `server.js`, find every place `signTableToken` is used to build a
`qrUrl` (in `GET /api/admin/tables`, `POST /api/admin/tables/:id/reset-qr`,
and `POST /api/admin/tables`). These currently build URLs like:
```js
`${baseUrl}/?t=${token}`
```
Update each to include the café's slug in the path, using `req.cafe.slug`
(already attached by `requireAdmin` from the Super Admin migration):
```js
`${baseUrl}/c/${req.cafe.slug}/?t=${token}`
```

This means scanning a table's QR now lands directly on that café's
correctly-scoped page, AND the table token is verified — both layers
of correctness (which café, which table) are satisfied by one URL.

## TASK D4 — Update the existing café's links

Since the original café ("Cafe Crafted") was created before this path
structure existed, its existing printed/shared QR codes point to the
OLD URL format. After this change, click "Reset QR" in the admin panel
for every one of its tables once, to regenerate them with the new
`/c/cafe-crafted/...` format. Document this as a manual one-time action
in your own notes — it is not something the code needs to handle
automatically, since it only needs to happen once per existing café at
the moment this change is deployed.

---

## WHAT NOT TO DO IN THIS PROMPT

- Do not touch order history tracking, table delete, pagination, or
  notification features — explicitly out of scope here
- Do not change how `/api/admin/*` or `/api/super-admin/*` routes
  authenticate beyond the specific login-endpoint fix in Part C — the
  header-based checks on every other route already work correctly
- Do not remove the insecure default fallback VALUES from the three
  secret constants — keep them as local-dev convenience, just add the
  warning/refusal logic around them as specified
- Do not change the visual design of any page

---

## HOW TO VERIFY ALL OF THIS WORKS

1. Update `.env` with the three real generated secrets (Task A1)
2. `npm install` (picks up `express-rate-limit`)
3. Restart the server, confirm NO warning about insecure defaults
   appears in the console
4. Try logging into super admin with the wrong key 25 times quickly —
   confirm you get rate-limited with a clear error after a while
5. Open browser dev tools → Network tab, log into super admin
   correctly — confirm the request is a POST with the key in the request
   body, NOT visible in the URL
6. Visit `/c/cafe-crafted/` — confirm the customer site loads correctly
   exactly as before
7. In super admin, create a brand new test café — view its table QR
   codes — confirm each one's URL starts with `/c/<that-new-café's-slug>/`
8. Scan/open that new café's QR — confirm it loads THAT café's menu, not
   "Cafe Crafted"'s menu
9. In admin panel for "Cafe Crafted", click "Reset QR" on table 1 —
   confirm the new URL now also uses the `/c/cafe-crafted/` format
10. Set `NODE_ENV=production` temporarily and remove one secret from
    `.env` on purpose — confirm the app refuses to start with a clear
    error — then restore the secret and remove `NODE_ENV` before
    continuing normal local development

---

# PART E — DEPLOYMENT: GITHUB → RENDER

Only proceed here after every task above is verified working.

## TASK E1 — Prepare for GitHub

Create a `.env.example` file at the project root (this gets committed —
it has no real values, just the variable names, documenting what anyone
setting this project up needs to provide):

```
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
SUPER_ADMIN_PASSWORD=
ADMIN_PASSWORD=
TABLE_TOKEN_SECRET=
NODE_ENV=production
PORT=3000
```

Confirm `.gitignore` at the project root includes, at minimum:
```
node_modules/
.env
uploads/
```

If `.gitignore` is missing any of these, add them. `uploads/` is
excluded because user-uploaded menu images are runtime data, not source
code — Render will need separate handling for persistent file storage,
covered in Task E3.

## TASK E2 — Push to GitHub

Run these commands from the project root (replace the URL with your
own actual empty GitHub repository's URL, created beforehand on
github.com):

```bash
git init
git add .
git commit -m "Initial commit: multi-tenant cafe ordering platform"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

## TASK E3 — Handle uploaded images before deploying

IMPORTANT LIMITATION TO UNDERSTAND BEFORE DEPLOYING: Render's free tier
uses an EPHEMERAL filesystem — any file written to disk after deployment
(like new menu item images uploaded through the admin panel) gets WIPED
on every redeploy or restart. Your existing `photos/` folder (hero
images already in your git repo) will deploy fine since it's part of
your committed code. But NEW uploads via `multer` after the app is live
will not persist reliably on Render's free tier.

For this initial deployment, accept this limitation consciously: treat
Render's free tier as good enough for getting the platform live and
testable with real users, while understanding that newly uploaded menu
images may need to be re-uploaded after a redeploy. When this becomes a
real problem (frequent menu image updates in production), the fix is
connecting `multer` to Cloudinary or AWS S3 instead of local disk
storage — a separate, future prompt, not part of this one.

## TASK E4 — Create the Render Web Service

This part has no code to write — it's done entirely on render.com:

1. Sign up / log in at render.com, connect your GitHub account
2. Click "New +" → "Web Service"
3. Select your repository
4. Configure:
   - **Name**: your choice, e.g. `cafe-ordering-platform`
   - **Region**: pick one close to your users (Singapore, if available,
     matches your Neon database's region for lowest latency)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (to start)
5. Under "Environment Variables", add every variable from your local
   `.env.example` template, with your REAL values this time:
   - `DATABASE_URL` — your Neon connection string
   - `SUPER_ADMIN_PASSWORD` — your real generated secret
   - `ADMIN_PASSWORD` — your real generated secret
   - `TABLE_TOKEN_SECRET` — your real generated secret
   - `NODE_ENV` — `production`
   - `PORT` — Render sets this automatically; you can omit it, Render
     injects its own `PORT` value and your existing code should already
     read `process.env.PORT` — confirm this is the case in `server.js`
     before deploying; if it currently hardcodes a port number instead,
     fix it to use `process.env.PORT || 3000` first
6. Click "Create Web Service" — Render will pull your repo, run the
   build, and start the app
7. Once live, Render gives you a public URL like
   `https://cafe-ordering-platform.onrender.com`

## TASK E5 — Post-deployment verification

1. Visit your new public Render URL directly — confirm the server
   responds (even a 404 on the bare root is fine if your routes are
   under `/c/:slug`, just confirm it's not a connection error)
2. Visit `https://your-app.onrender.com/super-admin-login.html` — log in
   with your real production `SUPER_ADMIN_PASSWORD`
3. Confirm the dashboard loads and shows your real café data from Neon
   — this confirms the production app is correctly connected to the
   same live database
4. Generate a fresh QR for one table, scan it on your phone with mobile
   data (not WiFi, to genuinely test "from outside your home network")
   — confirm the full ordering flow works end-to-end on the live URL
5. Note: Render's free tier spins down after a period of inactivity and
   takes 30-60 seconds to wake up on the next request — this is normal
   free-tier behavior, not a bug. If this matters for real customer use,
   upgrading to Render's lowest paid tier removes this delay.

---

## SESSION CONTINUITY NOTE

After this prompt, your platform is genuinely live on the public
internet, with real secrets, rate limiting, a fixed login flow, and
proper multi-café URL scoping. Remaining known gaps — table delete in
admin, full multi-order session history display, pagination on long
order lists, and push/SMS notifications — remain open as smaller,
independent follow-up prompts whenever you're ready for them, but none
of them block a safe public launch the way the items in this prompt did.

---

## END OF PROMPT
# ─────────────────────────────────────────────────────────────────────
