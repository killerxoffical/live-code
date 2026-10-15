const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 500 * 1024 * 1024 // 500MB
});

const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // NOTE: normalize to UPPERCASE so lowercase URLs still map to same folder
    const code = normalizeCode(req.params.roomCode);
    const roomDir = path.join(uploadsDir, code);
    if (!fs.existsSync(roomDir)) {
      fs.mkdirSync(roomDir, { recursive: true });
    }
    cb(null, roomDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory room storage
const rooms = new Map();

// Generate 5-character room code (guaranteed unique)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function isValidCode(code) {
  return /^[A-Z0-9]{5}$/.test(code);
}

// API Routes

// Create a new room
app.post('/api/rooms', (req, res) => {
  const roomCode = generateRoomCode();
  const room = {
    code: roomCode,
    createdAt: new Date(),
    files: [],
    members: [],
    creator: req.body.username || 'Anonymous'
  };
  rooms.set(roomCode, room);
  res.json({ success: true, room });
});

// Get room info
app.get('/api/rooms/:roomCode', (req, res) => {
  const code = normalizeCode(req.params.roomCode);
  if (!isValidCode(code)) {
    return res.status(400).json({ success: false, message: 'Invalid room code. Must be 5 characters (A-Z, 0-9).' });
  }
  const room = rooms.get(code);
  if (!room) {
    return res.status(404).json({ success: false, message: 'Room not found. It may have expired or the code is wrong.' });
  }
  res.json({ success: true, room });
});

// Health check (useful for debugging "can't create/join")
app.get('/api/health', (req, res) => {
  res.json({ success: true, rooms: rooms.size, uptime: process.uptime() });
});

// Generate QR code for room
app.get('/api/rooms/:roomCode/qr', async (req, res) => {
  try {
    const roomCode = normalizeCode(req.params.roomCode);
    const room = rooms.get(roomCode);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }
    
    // Get the host from the request
    const protocol = req.protocol;
    const host = req.get('host');
    const url = `${protocol}://${host}/?room=${roomCode}`;
    
    // Light-theme friendly QR: dark modules on white background (high contrast, scannable)
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: {
        dark: '#1E1B4B',
        light: '#FFFFFF'
      }
    });
    
    res.json({ success: true, qr: qrDataUrl, url });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate QR code' });
  }
});

// Upload file to room
app.post('/api/rooms/:roomCode/upload', upload.single('file'), (req, res) => {
  const roomCode = normalizeCode(req.params.roomCode);
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ success: false, message: 'Room not found' });
  }
  
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }
  
  const fileInfo = {
    id: Date.now().toString(),
    originalName: req.file.originalname,
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedAt: new Date(),
    uploadedBy: req.body.username || 'Anonymous'
  };
  
  room.files.push(fileInfo);
  
  // Notify room members
  io.to(roomCode).emit('file-uploaded', fileInfo);
  
  res.json({ success: true, file: fileInfo });
});

// Download file
app.get('/api/rooms/:roomCode/files/:filename', (req, res) => {
  const roomCode = normalizeCode(req.params.roomCode);
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ success: false, message: 'Room not found' });
  }
  
  const filePath = path.join(uploadsDir, roomCode, req.params.filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  
  const fileInfo = room.files.find(f => f.filename === req.params.filename);
  const originalName = fileInfo ? fileInfo.originalName : req.params.filename;
  
  res.download(filePath, originalName);
});

// Delete file
app.delete('/api/rooms/:roomCode/files/:fileId', (req, res) => {
  const roomCode = normalizeCode(req.params.roomCode);
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ success: false, message: 'Room not found' });
  }
  
  const fileIndex = room.files.findIndex(f => f.id === req.params.fileId);
  if (fileIndex === -1) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  
  const file = room.files[fileIndex];
  const filePath = path.join(uploadsDir, roomCode, file.filename);
  
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  
  room.files.splice(fileIndex, 1);
  io.to(roomCode).emit('file-deleted', { fileId: req.params.fileId });
  
  res.json({ success: true });
});

// Socket.IO for real-time
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join-room', ({ roomCode, username }) => {
    const code = normalizeCode(roomCode);
    if (!isValidCode(code)) {
      socket.emit('room-error', { message: 'Invalid room code format.' });
      socket.emit('error', { message: 'Invalid room code format.' });
      return;
    }
    const room = rooms.get(code);
    
    if (!room) {
      socket.emit('room-error', { message: 'Room not found. It may have expired or the code is wrong.' });
      // 'error' is a reserved socket.io event — keep for backwards compat
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    socket.join(code);
    socket.roomCode = code;
    socket.username = username || 'Anonymous';
    
    // Add to members
    if (!room.members.includes(username)) {
      room.members.push(username);
    }
    
    // Notify others
    socket.to(code).emit('user-joined', { username: socket.username, members: room.members });
    socket.emit('room-joined', { room, members: room.members });
  });
  
  socket.on('leave-room', () => {
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        room.members = room.members.filter(m => m !== socket.username);
        socket.to(socket.roomCode).emit('user-left', { username: socket.username, members: room.members });
      }
      socket.leave(socket.roomCode);
    }
  });
  
  // Chat message in room
  socket.on('chat-message', ({ message }) => {
    if (socket.roomCode) {
      io.to(socket.roomCode).emit('chat-message', {
        username: socket.username,
        message,
        timestamp: new Date()
      });
    }
  });
  
  socket.on('disconnect', () => {
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        room.members = room.members.filter(m => m !== socket.username);
        socket.to(socket.roomCode).emit('user-left', { username: socket.username, members: room.members });
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

// Clean up old rooms (older than 24 hours)
setInterval(() => {
  const now = new Date();
  for (const [code, room] of rooms) {
    const age = now - room.createdAt;
    if (age > 24 * 60 * 60 * 1000) {
      // Delete room files
      const roomDir = path.join(uploadsDir, code);
      if (fs.existsSync(roomDir)) {
        fs.rmSync(roomDir, { recursive: true, force: true });
      }
      rooms.delete(code);
    }
  }
}, 60 * 60 * 1000); // Check every hour

server.listen(PORT, () => {
  console.log(`\n🚀 ShareDrop is running!`);
  console.log(`📁 Open http://localhost:${PORT} in your browser\n`);
});
