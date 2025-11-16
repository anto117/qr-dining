// --- db-setup.js ---
// This script is for one-time setup of your database tables.

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const createTablesQuery = `
  -- Enable UUID extension if not already enabled
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

  -- 1. Restaurant Table
  CREATE TABLE IF NOT EXISTS restaurant (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- 2. Table (for QR codes)
  CREATE TABLE IF NOT EXISTS "table" (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES restaurant(id),
    name VARCHAR(50) NOT NULL
  );

  -- 3. Category (for menus)
  CREATE TABLE IF NOT EXISTS category (
    id SERIAL PRIMARY KEY,
    restaurant_id UUID NOT NULL REFERENCES restaurant(id),
    name VARCHAR(100) NOT NULL,
    display_order INTEGER DEFAULT 0
  );

  -- 4. Menu Item
  CREATE TABLE IF NOT EXISTS menu_item (
    id SERIAL PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    price INTEGER NOT NULL, -- Store price in cents (e.g., 1050 for $10.50)
    image_url VARCHAR(255),
    is_available BOOLEAN DEFAULT TRUE
  );

  -- 5. Order (the "header")
  CREATE TABLE IF NOT EXISTS "order" (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES restaurant(id),
    table_id UUID REFERENCES "table"(id),
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, preparing, ready, completed
    total_price INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- 6. Order Item (the "line items")
  CREATE TABLE IF NOT EXISTS order_item (
    id SERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL REFERENCES menu_item(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    notes TEXT
  );

  -- Add indexes for faster queries
  CREATE INDEX IF NOT EXISTS idx_order_restaurant ON "order" (restaurant_id);
  CREATE INDEX IF NOT EXISTS idx_order_table ON "order" (table_id);
  CREATE INDEX IF NOT EXISTS idx_menu_item_category ON menu_item (category_id);
  CREATE INDEX IF NOT EXISTS idx_category_restaurant ON category (restaurant_id);
`;

// Function to run the setup
async function setupDatabase() {
  console.log('Connecting to database...');
  const client = await pool.connect();
  try {
    console.log('Starting table creation...');
    await client.query(createTablesQuery);
    console.log('--- Database setup successful! ---');
    console.log('Tables created: restaurant, table, category, menu_item, order, order_item');
  } catch (err) {
    console.error('Error during database setup:', err);
  } finally {
    client.release();
    console.log('Connection released.');
    pool.end(); // End the pool connection as this is a one-off script
  }
}

// Run the setup
setupDatabase();