require("dotenv").config();
const { Client } = require("pg");

async function wakeDb() {
  console.log("Connecting to Neon Database to wake it up...");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    const res = await client.query("SELECT 1 AS status");
    console.log("Database is ACTIVE! Response:", res.rows[0]);
  } catch (err) {
    console.error("Failed to connect to database:", err);
  } finally {
    await client.end();
    console.log("Connection closed.");
  }
}

wakeDb();
