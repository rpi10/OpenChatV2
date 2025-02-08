import express from 'express';
import multer from 'multer';
import B2 from 'backblaze-b2';
import path from 'path';
import url from 'url';
import bcrypt from 'bcrypt';
import session from 'express-session';
import cors from 'cors';
import webpush from 'web-push';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Resolve __dirname in ES modules
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Initialize Backblaze B2 with credentials from .env
const b2 = new B2({
    applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
    applicationKey: process.env.B2_APPLICATION_KEY
});

// Set up multer for file handling (using memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route: serve index.html
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------
// File upload endpoint using Backblaze B2
// ----------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }
    try {
        // Authorize with Backblaze B2
        await b2.authorize();
        // Get upload URL from B2
        const { data: { uploadUrl, authorizationToken } } = await b2.getUploadUrl({
            bucketId: process.env.B2_BUCKET_ID
        });
        // Upload file to B2
        const fileBuffer = req.file.buffer;
        const fileName = req.file.originalname;
        await b2.uploadFile({
            uploadUrl,
            uploadAuthToken: authorizationToken,
            fileName,
            data: fileBuffer,
            contentType: req.file.mimetype
        });
        // Generate the public URL
        const publicUrl = `${process.env.B2_BUCKET_URL}/${fileName}`;
        // Return JSON response with the public URL
        res.json({ url: publicUrl });
    } catch (err) {
        console.error('Error uploading file:', err);
        res.status(500).json({ error: 'Error uploading the file.' });
    }
});

// ----------------------------
// Session middleware
// ----------------------------
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// ----------------------------
// Initialize PostgreSQL pool
// ----------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Test database connection
pool.query('SELECT NOW()', (err, result) => {
    if (err) {
        console.error('Error connecting to the database:', err);
    } else {
        console.log('Connected to the database successfully');
    }
});

// ----------------------------
// Create or update tables (including file attachment columns)
// ----------------------------
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
    file_url TEXT,
    file_name TEXT,
    file_type TEXT,
    file_size INT,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
`, (err) => {
    if (err) {
        console.error('Error creating tables:', err);
    } else {
        console.log('Tables created or verified successfully.');
    }
});

// ----------------------------
// Track users and their socket connections
// ----------------------------
const users = {};  // { username: { socketId, online, pushSubscription } }

// ----------------------------
// Web Push configuration
// ----------------------------
webpush.setVapidDetails(
    'mailto:jeremie.html@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

// ----------------------------
// Create HTTP server and attach Socket.IO
// ----------------------------
const server = createServer(app);
const io = new Server(server);

// ----------------------------
// Helper functions for formatting and message IDs
// ----------------------------
function formatDate(date) {
    const options = { year: '2-digit', month: '2-digit', day: '2-digit' };
    return new Date(date).toLocaleDateString('en-GB', options);
}

function formatTime(date) {
    const d = new Date(date);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDayLabel(date) {
    const today = new Date();
    const messageDate = new Date(date);
    const todayString = today.toDateString();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const yesterdayString = yesterday.toDateString();
    if (todayString === messageDate.toDateString()) {
        return "Today";
    } else if (yesterdayString === messageDate.toDateString()) {
        return "Yesterday";
    } else {
        return formatDate(messageDate);
    }
}

function generateMessageId() {
    return `${Date.now()}${Math.random().toString(36).substring(2, 9)}`;
}

// ----------------------------
// Socket.IO events (single consolidated connection block)
// ----------------------------
io.on('connection', (socket) => {
    console.log('A user connected');

    // Handle user login
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
        const now = new Date();
        const message = {
            from: socket.username,
            msg,
            to,
            timestamp: formatTime(now),
            dayLabel: formatDayLabel(now),
            messageId: generateMessageId()
        };

        // Save text message in the database
        saveMessage(socket.username, to, msg);

        // Emit message to recipient and sender
        if (users[to] && users[to].online) {
            io.to(users[to].socketId).emit('chat message', message);
            io.to(users[to].socketId).emit('notification', `New message from ${socket.username}`);
            if (users[to].pushSubscription) {
                sendPushNotification(JSON.parse(users[to].pushSubscription), {
                    title: 'New Message',
                    body: `You have a new message from ${socket.username}`
                });
            }
        }
        socket.emit('chat message', message);
    });

    // Handle sending file messages
    socket.on('file message', ({ to, fileUrl, name, type, size, timestamp, dayLabel }) => {
        if (!socket.username) return;
        const now = new Date();
        const message = {
            from: socket.username,
            fileUrl,
            name,
            type,
            size,
            to,
            timestamp: formatTime(now),
            dayLabel: formatDayLabel(now),
            messageId: generateMessageId()
        };

        // Save the file message in the database
        saveFileMessage(socket.username, to, fileUrl, name, type, size);

        // Emit the file message to recipient and sender
        if (users[to] && users[to].online) {
            io.to(users[to].socketId).emit('file message', message);
        }
        socket.emit('file message', message);
    });

    // Handle loading messages between two users
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

    async function sendPushNotification(subscription, message) {
        try {
            await webpush.sendNotification(subscription, JSON.stringify(message));
        } catch (err) {
            console.error('Error sending push notification:', err);
        }
    }
});

// ----------------------------
// Helper functions (outside io.on('connection'))
// ----------------------------

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

function saveMessage(sender, receiver, message) {
    pool.query('INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)', [sender, receiver, message], (err) => {
        if (err) console.error('Error saving message:', err);
    });
}

function saveFileMessage(sender, receiver, fileUrl, name, type, size) {
    const query = `
      INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    const placeholderMessage = 'File attachment';
    pool.query(query, [sender, receiver, placeholderMessage, fileUrl, name, type, size], (err) => {
        if (err) {
            console.error('Error saving file message:', err);
        }
    });
}

function loadPrivateMessageHistory(user1, user2, callback) {
  if (!user2) {
      callback([]);
      return;
  }
  const query = `
  SELECT sender, receiver, message, file_url, file_name, file_type, file_size, timestamp
  FROM messages
  WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
  ORDER BY timestamp ASC
`;
  pool.query(query, [user1, user2], (err, result) => {
      if (err) {
          console.error('Error loading message history:', err);
          callback([]);
      } else {
          const messages = result.rows.map(row => {
              // Check if it's a file message
              const isFileMessage = row.file_url && row.file_name;

              return {
                  from: row.sender,
                  to: row.receiver,
                  msg: isFileMessage ? 'File attachment' : row.message, // Show "File attachment" for file messages
                  fileUrl: row.file_url,
                  fileName: row.file_name,
                  fileType: row.file_type,
                  fileSize: row.file_size,
                  timestamp: formatTime(row.timestamp),
                  dayLabel: formatDayLabel(row.timestamp),
                  isFileMessage: isFileMessage // Add flag for file message
              };
          });
          callback(messages);
      }
  });
}


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

// ----------------------------
// Start the server
// ----------------------------
server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
