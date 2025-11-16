// --- db.js ---
const { Pool } = require('pg');
require('dotenv').config();

// Determine connection configuration based on the presence of the DATABASE_URL
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        // ⭐️ Configuration for Production (Render) ⭐️
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false, // Required for most hosted PostgreSQL services
        }
      }
    : {
        // ⭐️ Fallback for Local Development ⭐️
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_DATABASE,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
      }
);

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool,
};