
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
import crypto from 'crypto';

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
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
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
  DO $$ 
  BEGIN
    -- Create users table if it doesn't exist
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema='public' AND table_name='users'
    ) THEN
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT,
        online BOOLEAN DEFAULT FALSE,
        push_subscription TEXT,
        public_key TEXT,
        private_key TEXT,
        symmetric_key TEXT
      );
    ELSE
      -- Add symmetric_key column if it doesn't exist
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='users' AND column_name='symmetric_key'
      ) THEN
        ALTER TABLE users ADD COLUMN symmetric_key TEXT;
      END IF;
    END IF;

    -- Create messages table if it doesn't exist
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema='public' AND table_name='messages'
    ) THEN
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY,
        sender TEXT,
        receiver TEXT,
        message TEXT,
        file_url TEXT,
        file_name TEXT,
        file_type TEXT,
        file_size INT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        is_encrypted BOOLEAN DEFAULT TRUE
      );
    END IF;

    -- Create external_databases table if it doesn't exist
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema='public' AND table_name='external_databases'
    ) THEN
      CREATE TABLE external_databases (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        authentificator TEXT NOT NULL,
        database_url TEXT NOT NULL,
        public_key TEXT
      );
    END IF;

    -- Add columns if they don't exist (for existing tables)
    -- For users table
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='users' AND column_name='public_key'
    ) THEN
      ALTER TABLE users ADD COLUMN public_key TEXT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='users' AND column_name='private_key'
    ) THEN
      ALTER TABLE users ADD COLUMN private_key TEXT;
    END IF;

    -- For external_databases table
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='external_databases' AND column_name='public_key'
    ) THEN
      ALTER TABLE external_databases ADD COLUMN public_key TEXT;
    END IF;

  END $$;
`, (err) => {
  if (err) {
    console.error('Error setting up database schema:', err);
  } else {
    console.log('Database schema setup successfully.');
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
  
  const databaseURL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  
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

// Add these improved encryption utility functions
function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
}

// Generate a random symmetric key for local message encryption
function generateSymmetricKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Encrypt with public key (for E2E encryption)
function encryptWithPublicKey(publicKey, message) {
  if (!message || !publicKey) return message;
  try {
    return crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
      },
      Buffer.from(String(message))
    ).toString('base64');
  } catch (err) {
    console.error('RSA encryption error:', err);
    return message;
  }
}

// Decrypt with private key (for E2E encryption)
function decryptWithPrivateKey(privateKey, encryptedMessage) {
  if (!encryptedMessage || !privateKey) return encryptedMessage;
  try {
    // Check if the message is actually encrypted (base64)
    if (!/^[A-Za-z0-9+/=]+$/.test(encryptedMessage)) {
      return encryptedMessage;
    }
    
    return crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
      },
      Buffer.from(encryptedMessage, 'base64')
    ).toString();
  } catch (err) {
    console.error('RSA decryption error:', err);
    return encryptedMessage;
  }
}

// AES encryption for local storage (symmetric)
function encryptWithSymmetricKey(key, message) {
  if (!message || !key) return message;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
    let encrypted = cipher.update(String(message), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return iv.toString('hex') + ':' + encrypted; // Store IV with the message
  } catch (err) {
    console.error('AES encryption error:', err);
    return message;
  }
}

// AES decryption for local storage (symmetric)
function decryptWithSymmetricKey(key, encryptedMessage) {
  if (!encryptedMessage || !key || !encryptedMessage.includes(':')) return encryptedMessage;
  try {
    const parts = encryptedMessage.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('AES decryption error:', err);
    return encryptedMessage;
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
    
    // Get current user's public key
    const currentUserKeyQuery = await personalPool.query(
      'SELECT public_key FROM users WHERE username = $1',
      [currentUser]
    );
    
    if (currentUserKeyQuery.rows.length === 0 || !currentUserKeyQuery.rows[0].public_key) {
      return res.status(400).json({ error: 'Current user public key not found.' });
    }
    
    const currentUserPublicKey = currentUserKeyQuery.rows[0].public_key;
    
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
    
    // 3. Connect to Bob's database to get his public key
    let targetExtPool = null;
    let targetUserPublicKey = null;
    
    try {
      targetExtPool = new Pool({
        connectionString: targetUser.database_url,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      });
      
      // Get Bob's public key
      const targetUserKeyQuery = await targetExtPool.query(
        'SELECT public_key FROM users WHERE username = $1',
        [targetUser.username]
      );
      
      if (targetUserKeyQuery.rows.length > 0 && targetUserKeyQuery.rows[0].public_key) {
        targetUserPublicKey = targetUserKeyQuery.rows[0].public_key;
      }
    } catch (err) {
      console.error('Error retrieving target user public key:', err);
    }
    
    // 4. Insert into Alice's external_databases table a record for Bob with his public key
    try {
      await personalPool.query(
        'INSERT INTO external_databases (username, authentificator, database_url, public_key) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [targetUser.username, externalAuthenticator, targetUser.database_url, targetUserPublicKey]
      );
    } catch (err) {
      console.error('Error inserting external database record:', err);
      return res.status(500).json({ error: 'Error inserting external database record.' });
    }
    
    // 5. Insert Alice into Bob's users table
    try {
      if (targetExtPool) {
        // Insert Alice into Bob's users table
        await targetExtPool.query(
          `INSERT INTO users (username, password, online)
           VALUES ($1, $2, FALSE)
           ON CONFLICT (username) DO NOTHING`,
          [currentUser, null]
        );
        
        // Insert Alice's details into Bob's external_databases table with her public key
        await targetExtPool.query(
          'INSERT INTO external_databases (username, authentificator, database_url, public_key) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [currentUser, currentUserRecord.authentificator, currentUserRecord.database_url, currentUserPublicKey]
        );
      }
      
      // Ensure current user record has the public URL
      if (currentUserRecord.database_url !== process.env.DATABASE_PUBLIC_URL && process.env.DATABASE_PUBLIC_URL) {
        // Update the record to use the public URL
        currentUserRecord.database_url = process.env.DATABASE_PUBLIC_URL;
        await currentUserRecord.save();
        console.log(`Updated ${currentUser}'s database URL to public URL in general database`);
      }
      
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
      const existingGeneralUser = await GeneralUser.findOne({ username }).exec();
      const userQuery = await personalPool.query('SELECT * FROM users WHERE username = $1', [username]);
      const user = userQuery.rows[0];
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
      } else {
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
      
      // Generate RSA keypair for E2E encryption
      const { publicKey, privateKey } = generateKeyPair();
      
      // Insert user into both databases in correct order
      try {
        // First register in general database to get authenticator
        const generalAuthenticator = await registerGeneralUser(username, hashedPassword);
        console.log(`User ${username} registered in general database with authenticator: ${generalAuthenticator}`);
        
        // Then insert into personal database with keypair
        await personalPool.query(
          'INSERT INTO users (username, password, online, public_key, private_key) VALUES ($1, $2, TRUE, $3, $4)', 
          [username, hashedPassword, publicKey, privateKey]
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

  socket.on('chat message', async ({ to, msg }) => {
    if (!socket.username) return;
    const now = new Date();
    const messageId = generateMessageId();
    const message = {
      from: socket.username,
      msg,
      to,
      timestamp: formatTime(now),
      dayLabel: formatDayLabel(now),
      messageId
    };

    try {
      // Get recipient's public key for E2E encryption
      let recipientPublicKey = null;
      const userQuery = await personalPool.query(
        'SELECT public_key FROM users WHERE username = $1',
        [to]
      );
      
      if (userQuery.rows.length > 0 && userQuery.rows[0].public_key) {
        recipientPublicKey = userQuery.rows[0].public_key;
      }
      
      // Also check external database users
      if (!recipientPublicKey) {
        const externalUserQuery = await personalPool.query(
          'SELECT public_key FROM external_databases WHERE username = $1',
          [to]
        );
        
        if (externalUserQuery.rows.length > 0 && externalUserQuery.rows[0].public_key) {
          recipientPublicKey = externalUserQuery.rows[0].public_key;
        }
      }
      
      // Get sender's symmetric key for local encryption
      const senderQuery = await personalPool.query(
        'SELECT symmetric_key FROM users WHERE username = $1',
        [socket.username]
      );
      
      const symmetricKey = senderQuery.rows.length > 0 ? senderQuery.rows[0].symmetric_key : null;
      
      // For recipient DB: encrypt with recipient's public key (E2E)
      let recipientEncryptedMsg = recipientPublicKey ? 
        encryptWithPublicKey(recipientPublicKey, msg) : msg;
      
      // For sender DB: encrypt with sender's symmetric key
      let senderStoredMsg = symmetricKey ? 
        encryptWithSymmetricKey(symmetricKey, msg) : msg;
      
      // Both are encrypted, just with different methods
      const isEncrypted = true;
      
      // Save message to local database (encrypted with symmetric key)
      saveMessage(socket.username, to, senderStoredMsg, isEncrypted);
      
      // Send to recipient if online
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
      const recipientExternalResult = await personalPool.query(
        'SELECT * FROM external_databases WHERE username = $1', 
        [to]
      );
      
      if (recipientExternalResult.rows.length > 0) {
        const recipientDB = recipientExternalResult.rows[0];
        saveMessageToExternalDB(
          recipientDB.database_url, 
          socket.username, 
          to, 
          recipientEncryptedMsg, 
          null,
          true // E2E encrypted
        );
      }
    } catch (err) {
      console.error('Error in chat message:', err);
    }
  });

  socket.on('file message', async ({ to, fileUrl, name, type, size, transcription }) => {
    if (!socket.username) return;
    const now = new Date();
    const messageId = generateMessageId();
    const message = {
      from: socket.username,
      fileUrl: fileUrl,
      fileName: name,
      fileType: type,
      fileSize: size,
      to,
      timestamp: formatTime(now),
      dayLabel: formatDayLabel(now),
      messageId,
      isFileMessage: true
    };

    try {
      // Get recipient's public key for encryption
      let recipientPublicKey = null;
      const userQuery = await personalPool.query(
        'SELECT public_key FROM users WHERE username = $1',
        [to]
      );
      
      if (userQuery.rows.length > 0 && userQuery.rows[0].public_key) {
        recipientPublicKey = userQuery.rows[0].public_key;
      }
      
      // Also check external database users
      if (!recipientPublicKey) {
        const externalUserQuery = await personalPool.query(
          'SELECT public_key FROM external_databases WHERE username = $1',
          [to]
        );
        
        if (externalUserQuery.rows.length > 0 && externalUserQuery.rows[0].public_key) {
          recipientPublicKey = externalUserQuery.rows[0].public_key;
        }
      }
      
      // Get sender's symmetric key for self-encryption
      const senderQuery = await personalPool.query(
        'SELECT symmetric_key FROM users WHERE username = $1',
        [socket.username]
      );
      
      const symmetricKey = senderQuery.rows.length > 0 ? senderQuery.rows[0].symmetric_key : null;
      
      // For recipient: encrypt with recipient's key if available
      let recipientEncryptedUrl = recipientPublicKey ? encryptWithPublicKey(recipientPublicKey, fileUrl) : fileUrl;
      let recipientEncryptedName = recipientPublicKey ? encryptWithPublicKey(recipientPublicKey, name) : name;
      let recipientEncryptedType = recipientPublicKey ? encryptWithPublicKey(recipientPublicKey, type) : type;
      
      // For sender: encrypt with symmetric key
      let senderEncryptedUrl = symmetricKey ? encryptWithSymmetricKey(symmetricKey, fileUrl) : fileUrl;
      let senderEncryptedName = symmetricKey ? encryptWithSymmetricKey(symmetricKey, name) : name;
      let senderEncryptedType = symmetricKey ? encryptWithSymmetricKey(symmetricKey, type) : type;
      
      // All data is encrypted (with different methods)
      const isEncrypted = true;
      
      // Save to sender's database (encrypted with symmetric key)
      saveFileMessage(socket.username, to, senderEncryptedUrl, senderEncryptedName, senderEncryptedType, size, isEncrypted);
      
      // Send to recipient if online
      if (users[to] && users[to].online) {
        io.to(users[to].socketId).emit('file message', message);
        io.to(users[to].socketId).emit('notification', `New file from ${socket.username}`);
      }
      
      // Send back to sender for UI update (just once)
      socket.emit('file message', message);
      
      // Cross-database file message handling
      const recipientExternalResult = await personalPool.query(
        'SELECT * FROM external_databases WHERE username = $1', 
        [to]
      );
      
      if (recipientExternalResult.rows.length > 0) {
        const recipientDB = recipientExternalResult.rows[0];
        saveMessageToExternalDB(
          recipientDB.database_url, 
          socket.username, 
          to, 
          null, 
          { 
            fileUrl: recipientEncryptedUrl, 
            name: recipientEncryptedName, 
            type: recipientEncryptedType, 
            size 
          },
          true
        );
      }
    } catch (err) {
      console.error('Error in file message:', err);
    }
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

  // Check if user has encryption keys (public, private, and symmetric)
  try {
    const userQuery = await personalPool.query(
      'SELECT public_key, private_key, symmetric_key FROM users WHERE username = $1',
      [username]
    );
    
    if (userQuery.rows.length > 0) {
      const user = userQuery.rows[0];
      
      if (!user.public_key || !user.private_key) {
        console.log(`User ${username} is missing RSA keys. Generating...`);
        const { publicKey, privateKey } = generateKeyPair();
        await personalPool.query(
          'UPDATE users SET public_key = $1, private_key = $2 WHERE username = $3',
          [publicKey, privateKey, username]
        );
      }
      
      if (!user.symmetric_key) {
        console.log(`User ${username} is missing symmetric key. Generating...`);
        const symmetricKey = generateSymmetricKey();
        await personalPool.query(
          'UPDATE users SET symmetric_key = $1 WHERE username = $2',
          [symmetricKey, username]
        );
      }
    }
  } catch (error) {
    console.error('Error checking/generating keys for', username, error);
  }

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
  
  loadPrivateMessageHistory(username, null, (messages) => {
    socket.emit('chat history', messages);
  });
}

function saveMessage(sender, receiver, message, isEncrypted = true) {
  personalPool.query(
    'INSERT INTO messages (sender, receiver, message, is_encrypted) VALUES ($1, $2, $3, $4)', 
    [sender, receiver, message, isEncrypted], 
    (err) => {
      if (err) console.error('Error saving message:', err);
    }
  );
}

// Update saveFileMessage function to handle column existence checking
function saveFileMessage(sender, receiver, fileUrl, name, type, size, isEncrypted = true) {
  // First check if is_encrypted column exists
  personalPool.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='messages' AND column_name='is_encrypted'
  `, (columnErr, columnResult) => {
    if (columnErr) {
      console.error('Error checking for is_encrypted column:', columnErr);
      return;
    }
    
    const isEncryptedExists = columnResult && columnResult.rows.length > 0;
    
    // Adjust query based on column existence
    const placeholderMessage = 'File attachment';
    const query = isEncryptedExists ?
      `INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size, is_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)` :
      `INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    
    const params = isEncryptedExists ? 
      [sender, receiver, placeholderMessage, fileUrl, name, type, size, isEncrypted] :
      [sender, receiver, placeholderMessage, fileUrl, name, type, size];
    
    personalPool.query(query, params, (err) => {
      if (err) console.error('Error saving file message:', err);
      else console.log('File message saved successfully');
    });
  });
}

// Update loadPrivateMessageHistory to match the working file logic
function loadPrivateMessageHistory(user1, user2, callback) {
  if (!user2) {
    callback([]);
    return;
  }
  
  // Get the user's keys for decryption
  personalPool.query(
    'SELECT private_key, symmetric_key FROM users WHERE username = $1',
    [user1],
    (keyErr, keyResult) => {
      if (keyErr) {
        console.error('Error fetching keys:', keyErr);
        fallbackToUnencrypted();
        return;
      }
      
      const privateKey = keyResult.rows.length > 0 ? keyResult.rows[0].private_key : null;
      const symmetricKey = keyResult.rows.length > 0 ? keyResult.rows[0].symmetric_key : null;
      
      // Check if is_encrypted column exists
      personalPool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='messages' AND column_name='is_encrypted'
      `, (columnErr, columnResult) => {
        if (columnErr) {
          console.error('Error checking for is_encrypted column:', columnErr);
          fallbackToUnencrypted();
          return;
        }
        
        const isEncryptedExists = columnResult.rows.length > 0;
        
        // Adjust query based on column existence
        const query = isEncryptedExists ? 
          `SELECT sender, receiver, message, file_url, file_name, file_type, file_size, timestamp, is_encrypted
           FROM messages
           WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
           ORDER BY timestamp ASC` :
          `SELECT sender, receiver, message, file_url, file_name, file_type, file_size, timestamp
           FROM messages
           WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
           ORDER BY timestamp ASC`;
        
        personalPool.query(query, [user1, user2], (err, result) => {
          if (err) {
            console.error('Error loading message history:', err);
            callback([]);
            return;
          }
          
          const messages = result.rows.map(row => {
            // Important: Use the same isFileMessage detection logic as the working file
            const isFileMessage = row.file_url && row.file_name;
            
            // Determine sender and receiver
            const isSentByMe = row.sender === user1;
            
            // Decide if we should try to decrypt based on:
            // 1. If is_encrypted exists and is true
            // 2. Which key to use (private key for E2E, symmetric for self-messages)
            const shouldDecrypt = isEncryptedExists ? row.is_encrypted : false;
            
            let finalMessage = row.message;
            let finalFileUrl = row.file_url;
            let finalFileName = row.file_name;
            let finalFileType = row.file_type;
            
            if (shouldDecrypt) {
              try {
                if (isSentByMe && symmetricKey) {
                  // Decrypt self-messages with symmetric key
                  if (!isFileMessage && row.message) {
                    finalMessage = decryptWithSymmetricKey(symmetricKey, row.message);
                  }
                  
                  if (isFileMessage) {
                    if (row.file_url) finalFileUrl = decryptWithSymmetricKey(symmetricKey, row.file_url);
                    if (row.file_name) finalFileName = decryptWithSymmetricKey(symmetricKey, row.file_name);
                    if (row.file_type) finalFileType = decryptWithSymmetricKey(symmetricKey, row.file_type);
                  }
                } else if (!isSentByMe && privateKey) {
                  // Decrypt messages from others with private key (E2E)
                  if (!isFileMessage && row.message) {
                    finalMessage = decryptWithPrivateKey(privateKey, row.message);
                  }
                  
                  if (isFileMessage) {
                    if (row.file_url) finalFileUrl = decryptWithPrivateKey(privateKey, row.file_url);
                    if (row.file_name) finalFileName = decryptWithPrivateKey(privateKey, row.file_name);
                    if (row.file_type) finalFileType = decryptWithPrivateKey(privateKey, row.file_type);
                  }
                }
              } catch (decryptError) {
                console.error('Error decrypting message content:', decryptError);
                // Keep the original values if decryption fails
              }
            }
            
            // Use the exact same property names as in the working file
            return {
              from: row.sender,
              to: row.receiver,
              msg: isFileMessage ? 'File attachment' : finalMessage,
              fileUrl: finalFileUrl,
              fileName: finalFileName, // Note: Changed from name to fileName
              fileType: finalFileType, // Note: Changed from type to fileType
              fileSize: row.file_size, // Note: Changed from size to fileSize
              timestamp: formatTime(row.timestamp),
              dayLabel: formatDayLabel(row.timestamp),
              messageId: generateMessageId(),
              isFileMessage: isFileMessage // This is critical for file display
            };
          });
          
          callback(messages);
        });
      });
    }
  );
  
  // Fallback function to match working file
  function fallbackToUnencrypted() {
    const query = `
      SELECT sender, receiver, message, file_url, file_name, file_type, file_size, timestamp
      FROM messages
      WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
      ORDER BY timestamp ASC
    `;
    
    personalPool.query(query, [user1, user2], (err, result) => {
      if (err) {
        console.error('Error in fallback message loading:', err);
        callback([]);
        return;
      }
      
      const messages = result.rows.map(row => {
        const isFileMessage = row.file_url && row.file_name;
        return {
          from: row.sender,
          to: row.receiver,
          msg: isFileMessage ? 'File attachment' : row.message,
          fileUrl: row.file_url,
          fileName: row.file_name, // Match working file property names
          fileType: row.file_type,
          fileSize: row.file_size,
          timestamp: formatTime(row.timestamp),
          dayLabel: formatDayLabel(row.timestamp),
          messageId: generateMessageId(),
          isFileMessage: isFileMessage
        };
      });
      
      callback(messages);
    });
  }
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

// Updated saveMessageToExternalDB function
async function saveMessageToExternalDB(databaseUrl, sender, receiver, msg, fileData, isEncrypted = false) {
  if (!databaseUrl) {
    console.error('Missing database URL for external message');
    return;
  }
  
  const extPool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  
  try {
    // First check if schema is compatible with our current code
    const schemaCheck = await extPool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'messages'
        AND column_name = 'is_encrypted'
      ) as has_is_encrypted
    `);
    
    const hasIsEncrypted = schemaCheck.rows[0]?.has_is_encrypted || false;
    
    if (fileData) {
      // Construct the query based on schema compatibility
      const query = hasIsEncrypted ?
        `INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size, is_encrypted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)` :
        `INSERT INTO messages (sender, receiver, message, file_url, file_name, file_type, file_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`;
      
      const placeholderMessage = 'File attachment';
      const params = hasIsEncrypted ?
        [sender, receiver, placeholderMessage, fileData.fileUrl, fileData.name, fileData.type, fileData.size, isEncrypted] :
        [sender, receiver, placeholderMessage, fileData.fileUrl, fileData.name, fileData.type, fileData.size];
      
      await extPool.query(query, params);
    } else if (msg) {
      // Text message
      const query = hasIsEncrypted ?
        'INSERT INTO messages (sender, receiver, message, is_encrypted) VALUES ($1, $2, $3, $4)' :
        'INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)';
      
      const params = hasIsEncrypted ?
        [sender, receiver, msg, isEncrypted] :
        [sender, receiver, msg];
      
      await extPool.query(query, params);
    }
  } catch (err) {
    console.error('Error inserting message into external DB:', err);
  } finally {
    extPool.end().catch(err => console.error('Error closing external pool:', err));
  }
}

// ----------------------------
// Start the Server
// ----------------------------
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
