require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const bcrypt = require("bcrypt");
const pool = require("./pool");

async function setPassword() {
  const newPassword = process.argv[2];

  if (!newPassword) {
    console.error("Usage: node server/db/set-super-admin-password.js YOUR_NEW_PASSWORD");
    process.exit(1);
  }

  if (newPassword.length < 10) {
    console.error("❌ Please choose a password at least 10 characters long.");
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 12);

  const { rows } = await pool.query("SELECT id FROM super_admin_settings LIMIT 1");

  if (rows.length > 0) {
    await pool.query(
      "UPDATE super_admin_settings SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [hash, rows[0].id]
    );
    console.log("✅ Super admin password updated.");
  } else {
    await pool.query(
      "INSERT INTO super_admin_settings (password_hash) VALUES ($1)",
      [hash]
    );
    console.log("✅ Super admin password set for the first time.");
  }

  await pool.end();
}

setPassword().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
