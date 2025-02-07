// index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const cors = require('cors');
const webpush = require('web-push'); // For push notifications

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// CORS configuration
app.use(cors());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route (ensures the app responds to HTTP requests)
app.get("/", (req, res) => {
  res.send("Welcome to the Webchat App!");
});

// Middleware for session management
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // secure cookies in production
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));

// Initialize PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database:', err);
  } else {
    console.log('Connected to the database successfully');
  }
});

// Create or update tables if necessary
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT,
    online BOOLEAN DEFAULT FALSE,
    push_subscription TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    sender TEXT,
    receiver TEXT,
    message TEXT,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
`, (err) => {
  if (err) {
    console.error('Error creating tables:', err);
  } else {
    console.log('Tables created or verified successfully.');
  }
});

// Track users and their socket connections
const users = {};  // { username: { socketId, online, pushSubscription } }

// Web Push configuration
webpush.setVapidDetails(
  'mailto:jeremie.html@gmail.com', // Use your actual email address
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Handle socket connection
io.on('connection', (socket) => {
  console.log('A user connected');

  // Handle user login with password
  socket.on('login', async ({ username, password }) => {
    try {
      const userQuery = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      const user = userQuery.rows[0];
      if (user) {
        if (!user.password) {
          socket.emit('prompt signup', 'User exists but no password set. Would you like to set a password?');
        } else {
          const match = await bcrypt.compare(password, user.password);
          if (match) {
            await loginUser(socket, username);
          } else {
            socket.emit('login failed', 'Invalid password.');
          }
        }
      } else {
        socket.emit('prompt signup', 'User not found. Would you like to sign up?');
      }
    } catch (err) {
      console.error('Error during login:', err);
      socket.emit('login failed', 'An error occurred during login.');
    }
  });

  // Handle new user signup
  socket.on('signup', async ({ username, password }) => {
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query('INSERT INTO users (username, password, online) VALUES ($1, $2, TRUE)', [username, hashedPassword]);
      await loginUser(socket, username);
    } catch (err) {
      console.error('Error during signup:', err);
      socket.emit('signup failed', 'Signup failed. User may already exist.');
    }
  });

  // Handle sending chat messages
  socket.on('chat message', ({ to, msg }) => {
    if (!socket.username) return;
    const timestamp = new Date().toLocaleTimeString();
    const message = { from: socket.username, msg, to, timestamp };

    saveMessage(socket.username, to, msg);

    // Emit message to recipient and sender
    if (users[to] && users[to].online) {
      io.to(users[to].socketId).emit('chat message', message);
      io.to(users[to].socketId).emit('notification', `New message from ${socket.username}`);
      if (users[to].pushSubscription) {
        sendPushNotification(JSON.parse(users[to].pushSubscription), {
          title: 'New Message',
          body: `You have a new message from ${socket.username}`,
        });
      }
    }
    socket.emit('chat message', message);
  });

  // Load messages between two users
  socket.on('load messages', ({ user }) => {
    if (socket.username && user) {
      loadPrivateMessageHistory(socket.username, user, (messages) => {
        socket.emit('chat history', messages);
      });
    } else {
      socket.emit('chat history', []);
    }
  });

  // Handle user disconnecting
  socket.on('disconnect', () => {
    if (socket.username) {
      pool.query('UPDATE users SET online = FALSE WHERE username = $1', [socket.username], (err) => {
        if (err) console.error('Error marking user offline:', err);
        if (users[socket.username]) {
          users[socket.username].online = false;
        }
        updateUsersList();
      });
    }
    console.log('A user disconnected');
  });

  // Handle new password setup for users without a password
  socket.on('setup password', async ({ username, password }) => {
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashedPassword, username]);
      socket.emit('password setup successful');
      await loginUser(socket, username);
    } catch (err) {
      console.error('Error setting up password:', err);
      socket.emit('setup failed', 'Password setup failed.');
    }
  });

  // Handle push notification subscription
  socket.on('subscribe', async (subscription) => {
    try {
      await pool.query('UPDATE users SET push_subscription = $1 WHERE username = $2', [JSON.stringify(subscription), socket.username]);
      console.log(`User ${socket.username} subscribed to push notifications.`);
    } catch (err) {
      console.error('Error saving push subscription:', err);
    }
  });

  // Function to send push notifications
  async function sendPushNotification(subscription, message) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(message));
    } catch (err) {
      console.error('Error sending push notification:', err);
    }
  }
});

// Helper function to log in a user
async function loginUser(socket, username) {
  await pool.query('UPDATE users SET online = TRUE WHERE username = $1', [username]);
  users[username] = { socketId: socket.id, online: true };
  socket.username = username;
  socket.emit('login success', username);
  updateUsersList();
  loadPrivateMessageHistory(username, null, (messages) => {
    socket.emit('chat history', messages);
  });
}

// Save a message to the database
function saveMessage(sender, receiver, message) {
  pool.query('INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)', [sender, receiver, message], (err) => {
    if (err) console.error('Error saving message:', err);
  });
}

// Load private message history between two users
function loadPrivateMessageHistory(user1, user2, callback) {
  if (!user2) {
    callback([]);
    return;
  }
  const query = `
    SELECT sender, receiver, message, timestamp
    FROM messages
    WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
    ORDER BY timestamp ASC
  `;
  pool.query(query, [user1, user2], (err, result) => {
    if (err) {
      console.error('Error loading message history:', err);
      callback([]);
    } else {
      const messages = result.rows.map(row => ({
        from: row.sender,
        to: row.receiver,
        msg: row.message,
        timestamp: row.timestamp,
      }));
      callback(messages);
    }
  });
}

// Update users list and emit it to all connected clients
function updateUsersList() {
  pool.query('SELECT username, online FROM users', (err, result) => {
    if (err) {
      console.error('Error fetching users list:', err);
      return;
    }
    const userList = result.rows.map(row => ({
      username: row.username,
      online: row.online,
    }));
    io.emit('users', userList);
    console.log('Users list updated:', userList);
  });
}

// Start the server
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
