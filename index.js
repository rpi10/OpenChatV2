import express from 'express';
import multer from 'multer';
import B2 from 'backblaze-b2';
import path from 'path';
import bcrypt from 'bcrypt';
import session from 'express-session';
import cors from 'cors';
import webpush from 'web-push';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Groq from 'groq-sdk';
import mongoose from 'mongoose';

dotenv.config();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// ----------------------------
// Initialize Backblaze B2 & Multer
// ----------------------------
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY
});
const upload = multer({ storage: multer.memoryStorage() });

// ----------------------------
// Serve Static Files & Fallback Route
// ----------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------
// File Upload Endpoint (Backblaze B2)
// ----------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  try {
    await b2.authorize();
    const { data: { uploadUrl, authorizationToken } } = await b2.getUploadUrl({
      bucketId: process.env.B2_BUCKET_ID
    });
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    await b2.uploadFile({
      uploadUrl,
      uploadAuthToken: authorizationToken,
      fileName,
      data: fileBuffer,
      contentType: req.file.mimetype
    });
    const publicUrl = `${process.env.B2_BUCKET_URL}/${fileName}`;
    res.json({ url: publicUrl });
  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: 'Error uploading the file.' });
  }
});

// ----------------------------
// Transcription Endpoint (Groq API)
// ----------------------------
app.post("/transcribe", upload.single('audio'), async (req, res) => {
  try {
    let audioBuffer;
    let filename;
    
    if (req.file) {
      audioBuffer = req.file.buffer;
      filename = req.file.originalname;
      const MAX_FILE_SIZE = 25 * 1024 * 1024;
      if (req.file.size > MAX_FILE_SIZE) {
        return res.status(400).json({ error: "File size exceeds 25MB limit." });
      }
      const supportedTypes = [
        'audio/flac', 'audio/mp3', 'audio/mp4', 'audio/mpeg',
        'audio/mpga', 'audio/m4a', 'audio/ogg', 'audio/wav', 'audio/webm'
      ];
      if (!supportedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ 
          error: "Unsupported file type. Supported types: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm" 
        });
      }
    } else if (req.body && req.body.url) {
      const audioUrl = req.body.url;
      console.log("Fetching audio from URL:", audioUrl);
      const response = await fetch(audioUrl);
      if (!response.ok) {
        return res.status(400).json({ error: `Failed to fetch audio from URL. Status: ${response.status}` });
      }
      const contentType = response.headers.get('content-type');
      if (contentType) console.log("Fetched content-type:", contentType);
      audioBuffer = Buffer.from(await response.arrayBuffer());
      filename = path.basename(audioUrl) || `audio_${Date.now()}.mp3`;
      const MAX_FILE_SIZE = 25 * 1024 * 1024;
      if (audioBuffer.length > MAX_FILE_SIZE) {
        return res.status(400).json({ error: "File size exceeds 25MB limit." });
      }
    } else {
      return res.status(400).json({ error: "No audio provided. Please upload a file or provide a URL." });
    }
    
    if (!audioBuffer) {
      return res.status(400).json({ error: "Failed to process audio." });
    }
    
    const tempDir = path.join(__dirname, "temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    const tempPath = path.join(tempDir, `temp_${Date.now()}_${filename}`);
    fs.writeFileSync(tempPath, audioBuffer);
    console.log(`Temporary file created: ${tempPath}`);
    
    const fileStream = fs.createReadStream(tempPath);
    
    console.log("Calling Groq API for transcription...");
    const transcription = await groq.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-large-v3-turbo",
      response_format: "json",
      temperature: 0.0,
    });
    console.log("Transcription result:", transcription);
    
    fs.unlinkSync(tempPath);
    console.log(`Temporary file deleted: ${tempPath}`);
    
    res.json({ text: transcription.text });
  } catch (error) { 
    console.error("Transcription error:", error); 
    res.status(500).json({ error: error.message }); 
  }
});

// ----------------------------
// Session Middleware
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
// Initialize PostgreSQL Personal Database Pool
// ----------------------------
const personalPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

personalPool.query('SELECT NOW()', (err, result) => {
  if (err) {
    console.error('Error connecting to the personal database:', err);
  } else {
    console.log('Connected to the personal database successfully');
  }
});

// ----------------------------
// Initialize MongoDB (General Database) with Mongoose
// ----------------------------
const dbName = "openchat";
const generalDbURI = process.env.GENERAL_MONGO_URI ||
  `mongodb+srv://londonjeremie:Narnia2010@cluster0.mtuev.mongodb.net/${dbName}?retryWrites=true&w=majority`;

mongoose.connect(generalDbURI)
  .then(() => {
    console.log(`✅ Connected to MongoDB general database: "${dbName}" created successfully!`);
  })
  .catch((error) => console.error('❌ Connection error to MongoDB general database:', error));

// Define a Mongoose schema and model for general users
const generalUserSchema = new mongoose.Schema({
  authentificator: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: String,
  database_url: { type: String, required: true }
});
const GeneralUser = mongoose.model('GeneralUser', generalUserSchema);

// ----------------------------
// Create or Update Tables in Personal Database
// ----------------------------
personalPool.query(`
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

  CREATE TABLE IF NOT EXISTS external_databases (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    authentificator TEXT NOT NULL,
    database_url TEXT NOT NULL
  );
`, (err) => {
  if (err) {
    console.error('Error creating tables in personal database:', err);
  } else {
    console.log('Personal database tables created or verified successfully.');
  }
});

// ----------------------------
// Helper Functions for Authenticator and Registration
// ----------------------------
function generateAuthenticator() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function registerGeneralUser(username, password) {
  // Generate unique authenticator
  const generateUniqueAuthenticator = async () => {
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      const code = generateAuthenticator();
      const existing = await GeneralUser.findOne({ authentificator: code }).exec();
      if (!existing) {
        return code;
      }
      attempts++;
    }
    throw new Error('Could not generate unique authenticator after multiple attempts');
  };
  
  const databaseURL = process.env.DATABASE_URL;
  
  try {
    // Double-check if username already exists
    const existingUser = await GeneralUser.findOne({ username }).exec();
    if (existingUser) {
      throw new Error(`Username '${username}' already exists in general database`);
    }
    
    // Generate unique authenticator
    const authentificator = await generateUniqueAuthenticator();
    
    // Create and save the user
    const newGeneralUser = new GeneralUser({
      authentificator,
      username,
      password, // Should already be hashed
      database_url: databaseURL
    });
    
    await newGeneralUser.save();
    return authentificator;
  } catch (err) {
    console.error(`Error registering user '${username}' in general database:`, err);
    
    // Better error handling
    if (err.code === 11000) { // MongoDB duplicate key error
      if (err.keyPattern?.username) {
        throw new Error(`Username '${username}' already exists in general database`);
      } else if (err.keyPattern?.authentificator) {
        throw new Error('Authentication key collision. Please try again.');
      }
    }
    
    throw err;
  }
}
// ----------------------------
// New Endpoint to Link External Databases (Bidirectional Insertion)
// ----------------------------
// When a user (e.g. Alice) submits another user's authenticator (e.g. Bob's),
//   - Step 1: Insert a record into the central external_databases for the current user (Alice)
//             using her own username as owner and storing Bob's authenticator and Bob's database URL.
//   - Step 2: Retrieve Alice's general record.
//   - Step 3: Connect to Bob's external database (using Bob's database URL) and insert a record
//             so that Bob's external database now has a reciprocal record for Alice.
// ----------------------------
// New Endpoint to Link External Databases (Bidirectional Insertion)
// ----------------------------
app.post('/link-database', async (req, res) => {
  // The linking user (e.g. Alice) sends in her own username and the authenticator of the target user (e.g. Bob)
  const { externalAuthenticator, username } = req.body;
  // currentUser is the linking user (Alice)
  const currentUser = req.session.username || username;
  
  if (!externalAuthenticator || !currentUser) {
    return res.status(400).json({ error: 'Authenticator and username are required.' });
  }
  
  try {
    // 0. First, check if the authenticator belongs to the current user to prevent self-linking
    const currentUserRecord = await GeneralUser.findOne({ username: currentUser }).exec();
    if (!currentUserRecord) {
      return res.status(404).json({ error: 'Current user not found in general database.' });
    }
    
    if (currentUserRecord.authentificator === externalAuthenticator) {
      return res.status(400).json({ error: 'Cannot link to your own database.' });
    }
    
    // 1. Look up the target user (Bob) by his authenticator.
    const targetUser = await GeneralUser.findOne({ authentificator: externalAuthenticator }).exec();
    if (!targetUser) {
      return res.status(404).json({ error: 'Authenticator not found.' });
    }
    
    // Check if the databases are already linked
    const existingLink = await personalPool.query(
      'SELECT * FROM external_databases WHERE username = $1 AND authentificator = $2',
      [targetUser.username, externalAuthenticator]
    );
    
    if (existingLink.rows.length > 0) {
      return res.status(400).json({ error: 'Databases are already linked.' });
    }
    
    // 2. Insert Bob into Alice's users table
    try {
      await personalPool.query(
        `INSERT INTO users (username, password, online)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (username) DO NOTHING`,
        [targetUser.username, null]
      );
    } catch (err) {
      console.error('Error inserting user into local database:', err);
      return res.status(500).json({ error: 'Error inserting user into local database.' });
    }
    
    // 3. Insert into Alice's external_databases table a record for Bob
    try {
      await personalPool.query(
        'INSERT INTO external_databases (username, authentificator, database_url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [targetUser.username, externalAuthenticator, targetUser.database_url]
      );
    } catch (err) {
      console.error('Error inserting external database record:', err);
      return res.status(500).json({ error: 'Error inserting external database record.' });
    }
    
    // 4. Connect to Bob's database using Bob's database URL
    let targetExtPool = null;
    try {
      targetExtPool = new Pool({
        connectionString: targetUser.database_url,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      });
      
      // 5. Test connection to target database
      await targetExtPool.query('SELECT NOW()');
      
      // 6. Insert Alice into Bob's users table
      await targetExtPool.query(
        `INSERT INTO users (username, password, online)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (username) DO NOTHING`,
        [currentUser, null]
      );
      
      // 7. Insert Alice's details into Bob's external_databases table
      await targetExtPool.query(
        'INSERT INTO external_databases (username, authentificator, database_url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [currentUser, currentUserRecord.authentificator, currentUserRecord.database_url]
      );
      
      res.json({ 
        message: 'External database linked successfully.',
        linkedUser: targetUser.username
      });
    } catch (err) {
      console.error('Error connecting to or inserting into target database:', err);
      return res.status(500).json({ 
        error: 'Error connecting to target database. Please verify the authenticator is correct.'
      });
    } finally {
      if (targetExtPool) {
        targetExtPool.end();
      }
    }
  } catch (err) {
    console.error('Error linking database:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// ----------------------------
// Helper Function: Save Message to an External Database
// ----------------------------
async function saveMessageExternal(database_url, sender, receiver, msg, fileData) {
  const extPool = new Pool({
    connectionString: database_url,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  try {
    if (fileData) {
      const query = `
        INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      const placeholderMessage = 'File attachment';
      await extPool.query(query, [sender, receiver, placeholderMessage, fileData.fileUrl, fileData.name, fileData.type, fileData.size]);
    } else {
      await extPool.query('INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)', [sender, receiver, msg]);
    }
  } catch (err) {
    console.error('Error inserting message into external DB:', err);
  } finally {
    extPool.end();
  }
}

// ----------------------------
// Track Users and Their Socket Connections
// ----------------------------
const users = {}; // { username: { socketId, online, pushSubscription } }

// ----------------------------
// Web Push Configuration
// ----------------------------
webpush.setVapidDetails(
  'mailto:jeremie.html@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ----------------------------
// Create HTTP Server and Attach Socket.IO
// ----------------------------
const server = createServer(app);
const io = new Server(server);

// ----------------------------
// Load Combined Users for a Socket (Local + External)
// ----------------------------
async function loadCombinedUsers(socket) {
  const currentUser = socket.username;
  try {
    const localResult = await personalPool.query(
      'SELECT username, online FROM users WHERE username <> $1',
      [currentUser]
    );
    let allUsers = localResult.rows;
    const externalLinksResult = await personalPool.query(
      'SELECT * FROM external_databases WHERE username = $1',
      [currentUser]
    );
    for (const link of externalLinksResult.rows) {
      const externalPool = new Pool({
        connectionString: link.database_url,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      });
      const externalUsersResult = await externalPool.query(
        'SELECT username, online FROM users WHERE username <> $1',
        [currentUser]
      );
      allUsers = allUsers.concat(externalUsersResult.rows);
      externalPool.end();
    }
    const uniqueUsers = {};
    allUsers.forEach(u => { uniqueUsers[u.username] = u; });
    const userList = Object.values(uniqueUsers);
    socket.emit('users', userList);
    console.log(`Users list for ${currentUser} updated:`, userList);
  } catch (err) {
    console.error(`Error fetching users list for ${currentUser}:`, err);
  }
}

// ----------------------------
// Socket.IO Events
// ----------------------------
io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('login', async ({ username, password }) => {
    try {
      const userQuery = await personalPool.query('SELECT * FROM users WHERE username = $1', [username]);
      const user = userQuery.rows[0];
      const existingGeneralUser = await GeneralUser.findOne({ username }).exec();

      if (existingGeneralUser) {
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
      } 
      else {
        socket.emit('prompt signup', 'User not found. Would you like to sign up?');
      }
    } catch (err) {
      console.error('Error during login:', err);
      socket.emit('login failed', 'An error occurred during login.');
    }
  });

  socket.on('signup', async ({ username, password }) => {
  try {
    // Validate inputs
    if (!username || username.trim() === '') {
      return socket.emit('signup failed', 'Username cannot be empty.');
    }
    
    if (!password || password.length < 6) {
      return socket.emit('signup failed', 'Password must be at least 6 characters long.');
    }
    
    // FIRST: Check if user exists in the general database (MongoDB)
    console.log(`Checking if username '${username}' exists in general database...`);
    const existingGeneralUser = await GeneralUser.findOne({ username }).exec();
    
    if (existingGeneralUser) {
      console.log(`Username '${username}' already exists in general database.`);
      return socket.emit('signup failed', 'Username already exists in our system.');
    }
    
    // THEN: Check if user exists in personal database (PostgreSQL)
    console.log(`Checking if username '${username}' exists in personal database...`);
    const userQuery = await personalPool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (userQuery.rows.length > 0) {
      console.log(`Username '${username}' already exists in personal database.`);
      return socket.emit('signup failed', 'Username already exists in local database.');
    }
    
    console.log(`Username '${username}' is available. Creating account...`);
    
    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert user into both databases in correct order
    try {
      // First register in general database to get authenticator
      const generalAuthenticator = await registerGeneralUser(username, hashedPassword);
      console.log(`User ${username} registered in general database with authenticator: ${generalAuthenticator}`);
      
      // Then insert into personal database
      await personalPool.query(
        'INSERT INTO users (username, password, online) VALUES ($1, $2, TRUE)', 
        [username, hashedPassword]
      );
      
      await loginUser(socket, username);
    } catch (err) {
      console.error(`Error during account creation for ${username}:`, err);
      
      // If the general DB insertion succeeded but the personal DB failed,
      // we should roll back the general DB entry
      try {
        await GeneralUser.deleteOne({ username });
        console.log(`Rolled back general DB entry for ${username} due to error.`);
      } catch (rollbackErr) {
        console.error(`Failed to roll back general DB entry for ${username}:`, rollbackErr);
      }
      
      return socket.emit('signup failed', 'Error creating account. Please try again.');
    }
    
  } catch (err) {
    console.error('Error during signup:', err);
    socket.emit('signup failed', 'Registration failed. Please try again later.');
  }
});
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

  // Save message to local database - message is stored in sender's database (current user's database)
  saveMessage(socket.username, to, msg);
  
  // Send to recipient if they are online
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
  
  // Send back to sender for UI update
  socket.emit('chat message', message);

  // Cross-database messaging
  (async () => {
    try {
      // First, check if recipient is an external user by checking the external_databases table
      const recipientExternalResult = await personalPool.query(
        'SELECT * FROM external_databases WHERE username = $1', 
        [to]
      );
      
      // If recipient is found in external_databases, send the message to their database
      if (recipientExternalResult.rows.length > 0) {
        const recipientDB = recipientExternalResult.rows[0];
        const recipientPool = new Pool({
          connectionString: recipientDB.database_url,
          ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        });
        
        try {
          // Store the message in the recipient's database
          await recipientPool.query(
            'INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)', 
            [socket.username, to, msg]
          );
          console.log(`Message from ${socket.username} to ${to} saved to recipient's database`);
        } catch (err) {
          console.error('Error saving message to recipient database:', err);
        } finally {
          recipientPool.end();
        }
      }
    } catch (err) {
      console.error('Error in cross-database messaging:', err);
    }
  })();
});

// Similarly update the file message handler
socket.on('file message', ({ to, fileUrl, name, type, size, transcription }) => {
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
    messageId: generateMessageId(),
    recorded: true
  };

  // Save to sender's database
  saveFileMessage(socket.username, to, fileUrl, name, type, size);
  
  // Send to recipient if online
  if (users[to] && users[to].online) {
    io.to(users[to].socketId).emit('file message', message);
  }

  socket.emit('file message', message)
  

  // Cross-database file message handling - DON'T emit a second time to sender
  (async () => {
    try {
      // Check if recipient is external
      const recipientExternalResult = await personalPool.query(
        'SELECT * FROM external_databases WHERE username = $1', 
        [to]
      );
      
      // If recipient is external, save to their database
      if (recipientExternalResult.rows.length > 0) {
        const recipientDB = recipientExternalResult.rows[0];
        saveMessageToExternalDB(recipientDB.database_url, socket.username, to, null, { fileUrl, name, type, size });
      }
    } catch (err) {
      console.error('Error in cross-database file messaging:', err);
    }
  })();
});

// Helper function to save messages to external DBs without duplicating events
async function saveMessageToExternalDB(databaseUrl, sender, receiver, msg, fileData) {
  const extPool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  
  try {
    if (fileData) {
      const query = `
        INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      const placeholderMessage = 'File attachment';
      await extPool.query(query, [sender, receiver, placeholderMessage, fileData.fileUrl, fileData.name, fileData.type, fileData.size]);
    } else {
      await extPool.query('INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)', [sender, receiver, msg]);
    }
  } catch (err) {
    console.error('Error inserting message into external DB:', err);
  } finally {
    extPool.end();
  }
}
  socket.on('file message', ({ to, fileUrl, name, type, size, transcription }) => {
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
      messageId: generateMessageId(),
      recorded: true
    };

    saveFileMessage(socket.username, to, fileUrl, name, type, size);
    if (users[to] && users[to].online) {
      io.to(users[to].socketId).emit('file message', message);
    }

    (async () => {
      try {
        const extLinksSender = await personalPool.query('SELECT * FROM external_databases WHERE username = $1', [socket.username]);
        for (const link of extLinksSender.rows) {
          const extUser = await GeneralUser.findOne({ authentificator: link.authentificator }).exec();
          if (extUser && extUser.username === to) {
            await saveMessageExternal(link.database_url, socket.username, to, null, { fileUrl, name, type, size });
          }
        }
        const extLinksReceiver = await personalPool.query('SELECT * FROM external_databases WHERE username = $1', [to]);
        for (const link of extLinksReceiver.rows) {
          const extUser = await GeneralUser.findOne({ authentificator: link.authentificator }).exec();
          if (extUser && extUser.username === socket.username) {
            await saveMessageExternal(link.database_url, socket.username, to, null, { fileUrl, name, type, size });
          }
        }
      } catch (err) {
        console.error('Error saving external file message:', err);
      }
    })();
  });

  socket.on('load messages', ({ user }) => {
    if (socket.username && user) {
      loadPrivateMessageHistory(socket.username, user, (messages) => {
        socket.emit('chat history', messages);
      });
    } else {
      socket.emit('chat history', []);
    }
  });

  socket.on('load users', () => {
    if (socket.username) {
      loadCombinedUsers(socket);
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      personalPool.query('UPDATE users SET online = FALSE WHERE username = $1', [socket.username], (err) => {
        if (err) console.error('Error marking user offline:', err);
        if (users[socket.username]) {
          users[socket.username].online = false;
        }
        for (const [id, sock] of io.of("/").sockets) {
          if (sock.username) {
            loadCombinedUsers(sock);
          }
        }
      });
    }
    console.log('A user disconnected');
  });

  socket.on('setup password', async ({ username, password }) => {
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      await personalPool.query('UPDATE users SET password = $1 WHERE username = $2', [hashedPassword, username]);
      socket.emit('password setup successful');
      await loginUser(socket, username);
    } catch (err) {
      console.error('Error setting up password:', err);
      socket.emit('setup failed', 'Password setup failed.');
    }
  });

  socket.on('subscribe', async (subscription) => {
    try {
      await personalPool.query('UPDATE users SET push_subscription = $1 WHERE username = $2', [JSON.stringify(subscription), socket.username]);
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
// Helper Functions (Outside Socket.IO)
// ----------------------------
async function loginUser(socket, username) {
  await personalPool.query('UPDATE users SET online = TRUE WHERE username = $1', [username]);
  users[username] = { socketId: socket.id, online: true };
  socket.username = username;

  let authentificator = 'Not set';
  try {
    const generalUser = await GeneralUser.findOne({ username }).exec();
    if (generalUser && generalUser.authentificator) {
      authentificator = generalUser.authentificator;
    }
  } catch (error) {
    console.error('Error retrieving authentificator for', username, error);
  }

  console.log(`User ${username} logging in with authentificator: ${authentificator}`);
  socket.emit('login success', { username, authentificator });
  
  loadCombinedUsers(socket);
}

function saveMessage(sender, receiver, message) {
  personalPool.query('INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)', [sender, receiver, message], (err) => {
    if (err) console.error('Error saving message:', err);
  });
}

function saveFileMessage(sender, receiver, fileUrl, name, type, size) {
  const query = `
    INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `;
  const placeholderMessage = 'File attachment';
  personalPool.query(query, [sender, receiver, placeholderMessage, fileUrl, name, type, size], (err) => {
    if (err) console.error('Error saving file message:', err);
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
  personalPool.query(query, [user1, user2], (err, result) => {
    if (err) {
      console.error('Error loading message history:', err);
      callback([]);
    } else {
      const messages = result.rows.map(row => {
        const isFileMessage = row.file_url && row.file_name;
        return {
          from: row.sender,
          to: row.receiver,
          msg: isFileMessage ? 'File attachment' : row.message,
          fileUrl: row.file_url,
          fileName: row.file_name,
          fileType: row.file_type,
          fileSize: row.file_size,
          timestamp: formatTime(row.timestamp),
          dayLabel: formatDayLabel(row.timestamp),
          isFileMessage: isFileMessage
        };
      });
      callback(messages);
    }
  });
}

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
// Start the Server
// ----------------------------
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
