// --- index.js (Final Production Version) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const http = require('http');
const { Server } = require('socket.io');
const { upload } = require('./utils/uploads');

// --- 🚀 Import Auth ---
const authMiddleware = require('./authMiddleware');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

// ----------------------------------------
// MIDDLEWARE & SOCKET SETUP
// ----------------------------------------

const io = new Server(server, {
  cors: {
    // Whitelist all necessary domains for CORS and WebSockets
    origin: [
      'http://localhost:5173',
      'https://qr-diine-in.web.app',
      'https://qr-dining.onrender.com'
    ], 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
});

app.use(cors());
app.use(express.json());

// --- Socket.io connection logic ---
io.on('connection', (socket) => {
  console.log(`✅ A client connected: ${socket.id}`);
  
  socket.on('joinRestaurantRoom', (restaurantId) => {
    socket.join(restaurantId);
    console.log(`KDS ${socket.id} joined room: ${restaurantId}`);
  });

  socket.on('joinOrderRoom', (orderId) => {
    socket.join(orderId);
    console.log(`Customer ${socket.id} joined room: ${orderId}`);
  });

  socket.on('callWaiter', (data) => {
    io.to(data.restaurantId).emit('waiterCall', {
      tableId: data.tableId,
      tableName: data.tableName,
      time: new Date().toLocaleTimeString(),
      type: data.type || 'PAYMENT'
    });
    console.log(`Waiter call alert sent from ${data.tableName} to room ${data.restaurantId}`);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// ----------------------------------------
// 1. PUBLIC/TEST ROUTES
// ----------------------------------------

app.get('/', (req, res) => res.send('Kitchen API is running!'));

app.get('/db-test', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.status(200).json({
      message: 'Database connection successful!',
      timestamp: result.rows[0].now,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// ----------------------------------------
// 2. CUSTOMER PWA API ROUTES
// ----------------------------------------

/**
 * GET /api/menu-for-table/:tableId
 * Fetches the customer-facing menu (ONLY available items) AND the live bill.
 */
app.get('/api/menu-for-table/:tableId', async (req, res) => {
  const { tableId } = req.params;

  try {
    const tableQuery = 'SELECT name, restaurant_id FROM "table" WHERE id = $1';
    const tableResult = await db.query(tableQuery, [tableId]);
    if (tableResult.rows.length === 0) {
      return res.status(404).json({ error: 'Table not found' });
    }
    const { name: tableName, restaurant_id } = tableResult.rows[0];

    const catQuery = 'SELECT * FROM category WHERE restaurant_id = $1 ORDER BY display_order';
    const { rows: categories } = await db.query(catQuery, [restaurant_id]);
    
    // Fetch AVAILABLE menu items
    const itemQuery = `
      SELECT mi.* FROM menu_item mi
      WHERE mi.category_id IN (SELECT id FROM category WHERE restaurant_id = $1)
      AND mi.is_available = TRUE 
      ORDER BY mi.name
    `;
    const { rows: allItems } = await db.query(itemQuery, [restaurant_id]);
    
    const menu = categories.map(category => ({
      ...category,
      items: allItems.filter(item => item.category_id === category.id)
    }));

    // Fetch ALL UNPAID orders for this table
    const unpaidOrdersQuery = `
        SELECT 
            o.id, o.total_price, o.status, o.created_at,
            JSONB_AGG(jsonb_build_object('name', mi.name, 'quantity', oi.quantity)) AS items
        FROM "order" o
        LEFT JOIN order_item oi ON o.id = oi.order_id
        LEFT JOIN menu_item mi ON oi.menu_item_id = mi.id
        WHERE o.table_id = $1 AND o.is_paid = FALSE
        GROUP BY o.id
        ORDER BY o.created_at ASC
    `;
    const { rows: unpaidOrders } = await db.query(unpaidOrdersQuery, [tableId]);

    // Send the complete payload
    res.status(200).json({
      table: { id: tableId, name: tableName },
      restaurant: { id: restaurant_id }, // Added for call waiter
      menu: menu,
      unpaidOrders: unpaidOrders,
    });
  } catch (err) {
    console.error('Error fetching menu for table:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

/**
 * POST /api/order
 * Creates a new order and pushes to KDS
 */
app.post('/api/order', async (req, res) => {
  const { table_id, items } = req.body;
  if (!table_id || !items || !items.length) {
    return res.status(400).json({ error: 'Missing table_id or items' });
  }
  const client = await db.pool.connect();
  try {
    const itemIds = items.map(item => item.id);
    const priceQuery = `
      SELECT mi.id, mi.name, mi.price, c.restaurant_id 
      FROM menu_item mi
      JOIN category c ON mi.category_id = c.id
      WHERE mi.id = ANY($1::int[])
    `;
    const { rows: itemDetails } = await db.query(priceQuery, [itemIds]);
    if (itemDetails.length === 0) throw new Error('No items found');
    
    const restaurantId = itemDetails[0].restaurant_id; 
    let totalPrice = 0;
    let itemPayload = [];
    for (const cartItem of items) {
      const dbItem = itemDetails.find(p => p.id === cartItem.id);
      if (!dbItem) throw new Error(`Item ${cartItem.id} not found.`);
      totalPrice += dbItem.price * cartItem.quantity;
      itemPayload.push({ name: dbItem.name, quantity: cartItem.quantity });
    }
    await client.query('BEGIN');
    const orderQuery = `
      INSERT INTO "order" (restaurant_id, table_id, total_price, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *
    `;
    const orderResult = await client.query(orderQuery, [restaurantId, table_id, totalPrice]);
    const newOrder = orderResult.rows[0];
    const orderItemQuery = `
      INSERT INTO order_item (order_id, menu_item_id, quantity)
      VALUES ($1, $2, $3)
    `;
    for (const item of items) {
      await client.query(orderItemQuery, [newOrder.id, item.id, item.quantity]);
    }
    await client.query('COMMIT');
    const tableInfo = await db.query('SELECT name FROM "table" WHERE id = $1', [table_id]);
    const tableName = tableInfo.rows[0]?.name || 'Takeaway';
    const kdsPayload = {
      id: newOrder.id,
      status: newOrder.status,
      tableName: tableName,
      createdAt: newOrder.created_at,
      items: itemPayload 
    };
    io.to(restaurantId).emit('newOrder', kdsPayload);
    console.log(`Sent new order to room: ${restaurantId}`);
    res.status(201).json(newOrder); 
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', err);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/order/:id/status
 * Updates order status and notifies KDS & Customer
 */
app.put('/api/order/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, restaurant_id } = req.body;
  if (!status || !restaurant_id) {
    return res.status(400).json({ error: 'Missing status or restaurant_id' });
  }
  try {
    const query = 'UPDATE "order" SET status = $1 WHERE id = $2 RETURNING id';
    const { rows } = await db.query(query, [status, id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (status === 'completed') {
      io.to(restaurant_id).emit('orderCompleted', { id: id });
      console.log(`Sent order completion for ${id} to room ${restaurant_id}`);
    } else {
      io.to(restaurant_id).emit('orderStatusUpdated', { id: id, newStatus: status });
      console.log(`Sent order update for ${id} to room ${restaurant_id}`);
    }
    io.to(id).emit('orderStatusUpdate', { status: status });
    console.log(`Sent status '${status}' to order room ${id}`);
    res.status(200).json(rows[0]);
  } catch (err) {
    console.error('Error updating order status:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// ----------------------------------------
// 3. ADMIN & AUTH ROUTES
// ----------------------------------------

/**
 * GET /api/menu/:restaurantId
 * Fetches the complete menu (including archived items) for the Admin.
 */
app.get('/api/menu/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const catQuery = 'SELECT * FROM category WHERE restaurant_id = $1 ORDER BY display_order';
    const { rows: categories } = await db.query(catQuery, [restaurantId]);
    const itemQuery = `
      SELECT mi.* FROM menu_item mi
      WHERE mi.category_id IN (SELECT id FROM category WHERE restaurant_id = $1)
      ORDER BY mi.name
    `;
    const { rows: allItems } = await db.query(itemQuery, [restaurantId]);
    const menu = categories.map(category => ({
      ...category,
      items: allItems.filter(item => item.category_id === category.id)
    }));
    res.status(200).json(menu);
  } catch (err) {
    console.error('Error fetching menu:', err);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

/**
 * GET /api/admin/tables
 * Fetches all tables for the logged-in restaurant (Protected Route)
 */
app.get('/api/admin/tables', authMiddleware, async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const query = 'SELECT id, name FROM "table" WHERE restaurant_id = $1 ORDER BY name';
    const { rows } = await db.query(query, [restaurantId]);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Error fetching tables:', err);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

/**
 * POST /api/menu/item (Secured, with Image Upload)
 */
app.post('/api/menu/item', authMiddleware, upload.single('image'), async (req, res) => {
  const { category_id, name, description, price } = req.body;
  const restaurantId = req.user.restaurant_id;
  let imageUrl = null;
  if (req.file) {
    imageUrl = req.file.path;
  }
  if (!category_id || !name || !price) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const catQuery = 'SELECT id FROM category WHERE id = $1 AND restaurant_id = $2';
    const catResult = await db.query(catQuery, [category_id, restaurantId]);
    if (catResult.rowCount === 0) {
      return res.status(403).json({ error: 'Category does not belong to your restaurant' });
    }
    const priceInCents = Math.round(parseFloat(price) * 100);
    const query = `
      INSERT INTO menu_item (category_id, name, description, price, is_available, image_url)
      VALUES ($1, $2, $3, $4, TRUE, $5)
      RETURNING * `;
    const { rows } = await db.query(query, [category_id, name, description, priceInCents, imageUrl]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('--- 🔴 ERROR ADDING ITEM 🔴 ---');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: 'Failed to add menu item' });
  }
});

/**
 * PUT /api/menu/item/:id (Edit Item)
 */
app.put('/api/menu/item/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category_id } = req.body;
  const restaurantId = req.user.restaurant_id;

  if (!name || !price || !category_id) {
    return res.status(400).json({ error: 'Missing name, price, or category_id' });
  }
  try {
    const priceInCents = Math.round(parseFloat(price) * 100);
    const itemQuery = `
      SELECT mi.id FROM menu_item mi
      JOIN category c ON mi.category_id = c.id
      WHERE mi.id = $1 AND c.restaurant_id = $2
    `;
    const itemResult = await db.query(itemQuery, [id, restaurantId]);
    if (itemResult.rowCount === 0) {
      return res.status(403).json({ error: 'This item does not belong to your restaurant' });
    }
    const updateQuery = `
      UPDATE menu_item
      SET name = $1, description = $2, price = $3, category_id = $4
      WHERE id = $5
      RETURNING *
    `;
    const { rows } = await db.query(updateQuery, [name, description, priceInCents, category_id, id]);
    res.status(200).json(rows[0]);
  } catch (err) {
    console.error('Error updating item:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/menu/item/:id/availability (Archive)
 */
app.put('/api/menu/item/:id/availability', authMiddleware, async (req, res) => {
  try {
    const itemId = req.params.id;
    const { is_available } = req.body;
    const restaurantId = req.user.restaurant_id;
    const updateQuery = `
      UPDATE menu_item
      SET is_available = $1
      WHERE id = $2
      AND category_id IN (
        SELECT id FROM category WHERE restaurant_id = $3
      )
    `;
    const result = await db.query(updateQuery, [is_available, itemId, restaurantId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ msg: 'Item not found or you do not own it' });
    }
    res.status(200).json({ msg: 'Item availability updated' });
  } catch (err) {
    console.error('Error updating item availability:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/orders/unpaid/:restaurantId (Admin Billing Fetch)
 */
app.get('/api/admin/orders/unpaid/:restaurantId', authMiddleware, async (req, res) => {
  const { restaurantId } = req.params;
  const loggedInRestaurantId = req.user.restaurant_id;

  if (restaurantId !== loggedInRestaurantId) {
    return res.status(403).json({ msg: 'Unauthorized to view this data' });
  }
  try {
    const unpaidOrdersQuery = `
        SELECT 
            o.id, o.table_id, o.total_price, o.status, o.created_at, t.name AS table_name,
            JSONB_AGG(jsonb_build_object('name', mi.name, 'quantity', oi.quantity)) AS items
        FROM "order" o
        LEFT JOIN "table" t ON o.table_id = t.id
        LEFT JOIN order_item oi ON o.id = oi.order_id
        LEFT JOIN menu_item mi ON oi.menu_item_id = mi.id
        WHERE o.restaurant_id = $1 AND o.is_paid = FALSE 
        GROUP BY o.id, t.name
        ORDER BY o.created_at ASC
    `;
    const { rows } = await db.query(unpaidOrdersQuery, [restaurantId]);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Error fetching unpaid orders:', err);
    res.status(500).json({ error: 'Failed to fetch bills' });
  }
});

/**
 * PUT /api/admin/order/:orderId/paid (Mark Paid)
 */
app.put('/api/admin/order/:orderId/paid', authMiddleware, async (req, res) => {
  const { orderId } = req.params;
  const restaurantId = req.user.restaurant_id;
  try {
    const paidQuery = `
      UPDATE "order" SET is_paid = TRUE 
      WHERE id = $1 AND restaurant_id = $2 
      RETURNING id, total_price, table_id
    `;
    const { rows } = await db.query(paidQuery, [orderId, restaurantId]);
    if (rows.length === 0) {
      return res.status(404).json({ msg: 'Order not found or already paid' });
    }
    res.status(200).json({ msg: 'Order marked as paid', order: rows[0] });
  } catch (err) {
    console.error('Error marking order as paid:', err);
    res.status(500).json({ error: 'Failed to update payment status' });
  }
});

/**
 * AUTH ROUTES
 */
app.post('/api/auth/register', async (req, res) => {
  const { email, password, restaurant_id } = req.body;
  if (!email || !password || !restaurant_id) {
    return res.status(400).json({ error: 'Missing email, password, or restaurant_id' });
  }
  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const query = `
      INSERT INTO "users" (email, password_hash, restaurant_id)
      VALUES ($1, $2, $3)
      RETURNING id, email, restaurant_id
    `;
    const { rows } = await db.query(query, [email, password_hash, restaurant_id]);
    res.status(2JSON.stringify()).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' }); // Fixed the '4all' typo
  }
  try {
    const query = 'SELECT * FROM "users" WHERE email = $1';
    const { rows } = await db.query(query, [email]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const payload = {
      user: {
        id: user.id,
        restaurant_id: user.restaurant_id,
      },
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    res.status(200).json({
      token: token,
      restaurant_id: user.restaurant_id
    });
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------------------------
// START SERVER
// ----------------------------------------
server.listen(PORT, () => {
  console.log(`Server with WebSocket is listening on port ${PORT}`);
});