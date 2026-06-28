# CAFE PROJECT — DEPLOYMENT READINESS, PART 1
# Fix Super Admin Page Flash + Add a Root Landing Page
# Paste this entire file into Cursor / Antigravity / Claude Code
# ─────────────────────────────────────────────────────────────────────

---

## WHO YOU ARE

You are a senior full-stack engineer fixing a specific, confirmed bug
before a public deployment. You make precise, minimal changes. You do
not redesign anything beyond what's described here.

Read this entire prompt before writing any code.
Do not ask clarifying questions. Implement every task in order.

---

## CONTEXT — THE EXACT BUG, CONFIRMED BY READING THE ACTUAL CODE

This project has THREE admin-style pages, and only ONE of them is built
correctly. Here is the precise difference:

**`public/admin.html` is CORRECT.** It has a `<div id="loginScreen">`
and a separate `<div id="adminShell">`. The page's JS (`admin.js`) only
reveals `adminShell` and loads any real data AFTER `checkAuth()` confirms
a valid session. Before that, the visitor only ever sees the login form.
This file needs NO changes — it already works exactly as it should.

**`public/super-admin-dashboard.html` and
`public/super-admin-cafe-detail.html` are BROKEN in a subtle way.** They
do NOT have an equivalent `loginScreen` / hidden-shell pattern. Instead,
their full page layout (headers, stat card containers, buttons, empty
list containers) renders immediately and unconditionally. Only
afterward, when `super-admin.js` / `super-admin-detail.js` run, do they
check `sessionStorage` for a key and redirect if missing — but by then,
the empty page structure has already painted on screen. This is exactly
why visiting these pages without being logged in looks like "broken
fragments" rather than a clean login prompt — because what's on screen
IS broken: real layout, no data, about to redirect, all visible for a
brief moment.

You are fixing this specific gap. You are also adding a simple root
landing page, since `server.js` currently has no route at all for the
bare `/` path.

---

## TASK 1 — Fix super-admin-dashboard.html: gate before render

Open `public/super-admin-dashboard.html`. Wrap the ENTIRE visible body
content in a container that starts hidden, exactly mirroring the working
pattern already used successfully in `admin.html`.

Find the current body content (topbar, stats grid, cafés list, modals)
and wrap all of it like this:

```html
<body>
  <div id="superAdminGate" style="display:flex; align-items:center; justify-content:center; height:100vh;">
    <p style="color: var(--text-muted);">Checking your session…</p>
  </div>

  <div id="superAdminShell" style="display:none;">
    <!-- ALL existing content goes here unchanged: admin-topbar, statsGrid,
         the "All Cafés" section, addCafeModal, newCafeCredentialsModal —
         move it all inside this div, do not change any of it internally -->
  </div>

  <script src="/js/super-admin.js"></script>
</body>
```

---

## TASK 2 — Update super-admin.js to control the gate explicitly

In `public/js/super-admin.js`, replace the function that currently
checks the key (`getSuperAdminKey`) and the bottom-of-file initialization
block with this corrected version:

```js
function getSuperAdminKey() {
  return sessionStorage.getItem("superAdminKey");
}

function superAdminHeaders() {
  return { "x-super-admin-key": getSuperAdminKey() };
}

// Runs once, immediately, before anything else on this page. Shows the
// real dashboard ONLY after confirming the stored key is still valid
// against the server — never assumes a key in sessionStorage is still
// good, since it could be stale, revoked, or simply wrong.
async function gateSuperAdminPage() {
  const key = getSuperAdminKey();

  if (!key) {
    window.location.href = "/super-admin-login.html";
    return;
  }

  try {
    const res = await fetch("/api/super-admin/platform-stats", {
      headers: { "x-super-admin-key": key },
    });

    if (!res.ok) {
      sessionStorage.removeItem("superAdminKey");
      window.location.href = "/super-admin-login.html";
      return;
    }

    document.getElementById("superAdminGate").style.display = "none";
    document.getElementById("superAdminShell").style.display = "block";

    loadPlatformStats();
    loadCafesList();
  } catch (err) {
    console.error("Could not verify super admin session", err);
    window.location.href = "/super-admin-login.html";
  }
}

gateSuperAdminPage();
```

Remove the old bottom-of-file block that looked like:
```js
if (document.getElementById("statsGrid")) {
  loadPlatformStats();
  loadCafesList();
}
```
— this is now fully replaced by `gateSuperAdminPage()` calling those same
two functions only after a confirmed-valid session.

Leave `loadPlatformStats()` and `loadCafesList()` themselves completely
unchanged — they already correctly fetch and render data; the only
problem was WHEN they were allowed to run and what was visible before
they did.

---

## TASK 3 — Apply the identical fix to super-admin-cafe-detail.html

In `public/super-admin-cafe-detail.html`, apply the exact same wrapping
pattern as Task 1 — wrap all existing visible content (the back link,
logout button, `cafeDetailContent` div) inside a `superAdminShell` div,
hidden by default, with a `superAdminGate` loading message shown first.

In `public/js/super-admin-detail.js`, replace the bottom-of-file
`loadCafeDetail();` call and the `getSuperAdminKey` function with:

```js
function getSuperAdminKey() {
  return sessionStorage.getItem("superAdminKey");
}
function superAdminHeaders() {
  return { "x-super-admin-key": getSuperAdminKey() };
}

async function gateSuperAdminPage() {
  const key = getSuperAdminKey();

  if (!key) {
    window.location.href = "/super-admin-login.html";
    return;
  }

  try {
    const res = await fetch("/api/super-admin/platform-stats", {
      headers: { "x-super-admin-key": key },
    });

    if (!res.ok) {
      sessionStorage.removeItem("superAdminKey");
      window.location.href = "/super-admin-login.html";
      return;
    }

    document.getElementById("superAdminGate").style.display = "none";
    document.getElementById("superAdminShell").style.display = "block";

    loadCafeDetail();
  } catch (err) {
    console.error("Could not verify super admin session", err);
    window.location.href = "/super-admin-login.html";
  }
}

gateSuperAdminPage();
```

Leave `loadCafeDetail()` itself unchanged — same reasoning as Task 2.

---

## TASK 4 — Add a simple root landing page

Currently `server.js` has no route at all for the bare `/` path, meaning
`express.static` falls through to whatever is in `public/` by default
(likely nothing useful, or a confusing fallback). Add a clean, minimal
landing page so visiting the bare domain is intentional, not accidental.

Create `public/index-landing.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Café Ordering Platform</title>
  <link rel="stylesheet" href="/css/admin.css" />
  <style>
    body { display:flex; align-items:center; justify-content:center; height:100vh; text-align:center; }
    .landing-box { max-width: 420px; padding: 2rem; }
    .landing-links { display:flex; flex-direction:column; gap:0.75rem; margin-top:1.5rem; }
  </style>
</head>
<body>
  <div class="landing-box">
    <h1>Café Ordering Platform</h1>
    <p style="color:var(--text-muted); margin-top:0.5rem;">
      This is the backend platform for café staff. Customers should never
      land here directly — they access their café's menu by scanning the
      QR code on their table.
    </p>
    <div class="landing-links">
      <a href="/admin.html" class="btn btn-primary">Café Admin Login</a>
      <a href="/super-admin-login.html" class="btn btn-ghost">Super Admin Login</a>
    </div>
  </div>
</body>
</html>
```

In `server.js`, find where `express.static` is configured for the
`public` folder and add this route IMMEDIATELY BEFORE it (route order
matters — this must be registered first so it takes priority over the
static file handler for this exact one path):

```js
app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index-landing.html"));
});
```

Confirm `ROOT` (or whatever the existing path constant is called in
this file — check the exact variable name already used in the
`/c/:cafeSlug` routes added previously, and reuse that same constant
here for consistency) is already defined near the top of `server.js`.
If a `path` import is not already present, add
`const path = require("path");` near the other top-level requires.

---

## WHAT NOT TO DO IN THIS PART

- Do not touch `admin.html` or `admin.js` — they are already correct
- Do not change any `/api/...` route's logic — this prompt only touches
  static page gating and one new landing route
- Do not remove the existing `/c/:cafeSlug` customer-facing routes
- Do not change how QR generation works — that's Part 2

---

## HOW TO VERIFY THIS PART WORKS

1. Restart the server locally
2. Open an incognito/private browser window (guarantees no leftover
   `sessionStorage`)
3. Visit `/super-admin-dashboard.html` directly — confirm you see ONLY
   a brief "Checking your session…" message, then an immediate redirect
   to `/super-admin-login.html` — no flash of empty stat cards or broken
   layout
4. Log in correctly — confirm the dashboard now shows real data, gate
   message is gone, shell is visible
5. Repeat steps 2–4 for `/super-admin-cafe-detail.html?id=1`
6. Visit the bare domain root `/` — confirm the new landing page appears
   with both login links, instead of nothing or a confusing fallback
7. Confirm `/admin.html` still works exactly as before — login screen
   first, real panel only after correct password (this should need zero
   changes, just confirm nothing broke)

---

## END OF PART 1
# ─────────────────────────────────────────────────────────────────────
# Part 2 (next prompt) will add:
# A "Regenerate All QR Codes" bulk action in admin.html's Tables panel,
# plus a plain checklist for verifying Render's environment variables
# before this deploys cleanly
# ─────────────────────────────────────────────────────────────────────
