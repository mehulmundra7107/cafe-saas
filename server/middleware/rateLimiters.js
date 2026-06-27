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
