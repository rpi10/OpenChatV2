const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const cors = require('cors');
const webpush = require('web-push'); // Added for push notifications
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// CORS configuration
app.use(cors());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for session management
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        maxAge: 24 * 60 * 60 * 1000 // Set cookie expiration to 1 day
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
        push_subscription TEXT -- Store push subscription as JSON
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
const users = {};  // {username: {socketId: socketId, online: boolean}}

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
            socket.emit('login failed', 'An error occurred during login. Please try again.');
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

        // Emit message to the recipient and the sender
        if (users[to] && users[to].online) {
            io.to(users[to].socketId).emit('chat message', message);
            io.to(users[to].socketId).emit('notification', `New message from ${socket.username}`);

            // Send push notification if the user is subscribed
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
        if (socket.username) {
            if (user) {
                loadPrivateMessageHistory(socket.username, user, (messages) => {
                    socket.emit('chat history', messages);
                });
            } else {
                socket.emit('chat history', []);
            }
        }
    });

    // Handle user disconnecting
    socket.on('disconnect', () => {
        if (socket.username) {
            pool.query(
                'UPDATE users SET online = FALSE WHERE username = $1',
                [socket.username],
                (err) => {
                    if (err) {
                        console.error('Error marking user offline:', err);
                    } else {
                        if (users[socket.username]) {
                            users[socket.username].online = false;
                        }
                        updateUsersList(); // Update users list excluding the disconnected user
                    }
                }
            );
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

    // Handle push notifications
    async function sendPushNotification(subscription, message) {
        try {
            await webpush.sendNotification(subscription, JSON.stringify(message));
        } catch (err) {
            console.error('Error sending push notification:', err);
        }
    }
});

// Helper function to login user
async function loginUser(socket, username) {
    await pool.query('UPDATE users SET online = TRUE WHERE username = $1', [username]);
    users[username] = { socketId: socket.id, online: true };
    socket.username = username;
    if (socket.request.session) {
        socket.request.session.username = username;
        socket.request.session.save();
    }
    socket.emit('login success', username);
    updateUsersList(); // Exclude the current user from the list sent to others
    loadPrivateMessageHistory(username, null, (messages) => {
        socket.emit('chat history', messages);
    });
}

// Save messages to the PostgreSQL database
function saveMessage(sender, receiver, message) {
    pool.query(
        'INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)',
        [sender, receiver, message],
        (err) => {
            if (err) {
                console.error('Error saving message:', err);
            }
        }
    );
}

// Load private message history between two users
function loadPrivateMessageHistory(user1, user2, callback) {
    let query, params;
    if (user2) {
        query = `
            SELECT sender, receiver, message, timestamp
            FROM messages
            WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
            ORDER BY timestamp ASC
        `;
        params = [user1, user2];
    } else {
        callback([]);
        return;
    }

    pool.query(query, params, (err, result) => {
        if (err) {
            console.error('Error loading message history:', err);
            callback([]);
            return;
        }
        const messages = result.rows.map(row => ({
            from: row.sender,
            to: row.receiver,
            msg: row.message,
            timestamp: row.timestamp,
        }));
        callback(messages);
    });
}

// Update users list and notify all connected clients
function updateUsersList() {
    pool.query(
        'SELECT username, online FROM users',
        (err, result) => {
            if (err) {
                console.error('Error fetching users list:', err);
                return;
            }

            // Create a map of users to send to clients
            const userList = result.rows.map(row => ({
                username: row.username,
                online: row.online,
            }));

            // Emit updated user list to all connected clients
            io.emit('users', userList);
            console.log('Users list updated:', userList);
        }
    );
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
