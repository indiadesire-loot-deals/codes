// server.js - FIXED VERSION WITH DEBUGGING
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const Replicate = require("replicate");
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN || "r8_I7SAJnqr9649BhIG0PWfHdFJZl51Kad3Istr3",
});

app.use(cors({
  origin: ['https://gff.lovable.app', 'https://preview--gff.lovable.app', 'http://localhost:3000', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'audio/webm', limit: '50mb' }));

// Get port from environment variable
const PORT = process.env.PORT || 10000;

// Create directories for recordings
const AUDIO_DIR = path.join(__dirname, 'server-recordings');
const USER_RECORDINGS_DIR = path.join(AUDIO_DIR, 'user-recordings');

// Ensure directories exist
const createDirectories = () => {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
  if (!fs.existsSync(USER_RECORDINGS_DIR)) {
    fs.mkdirSync(USER_RECORDINGS_DIR, { recursive: true });
  }
  console.log(`Directories created at: ${AUDIO_DIR}`);
};

createDirectories();

// Store active connections
const activeConnections = new Map();

// ========== DEBUG ENDPOINTS ==========

// Debug endpoint to check storage
app.get('/debug/storage', (req, res) => {
  try {
    const users = fs.existsSync(USER_RECORDINGS_DIR) 
      ? fs.readdirSync(USER_RECORDINGS_DIR)
      : [];
    
    const userStats = users.map(user => {
      const userDir = path.join(USER_RECORDINGS_DIR, user);
      const files = fs.readdirSync(userDir);
      return {
        userId: user,
        fileCount: files.length,
        files: files.slice(0, 10), // First 10 files
        directory: userDir
      };
    });
    
    res.json({
      storagePath: USER_RECORDINGS_DIR,
      exists: fs.existsSync(USER_RECORDINGS_DIR),
      totalUsers: users.length,
      users: userStats,
      diskInfo: {
        AUDIO_DIR: AUDIO_DIR,
        USER_RECORDINGS_DIR: USER_RECORDINGS_DIR
      }
    });
  } catch (error) {
    res.json({ 
      error: error.message,
      stack: error.stack,
      storagePath: USER_RECORDINGS_DIR 
    });
  }
});

// Test endpoint to create a dummy file
app.get('/test-save/:userId', (req, res) => {
  const userId = req.params.userId;
  const userDir = path.join(USER_RECORDINGS_DIR, userId);
  
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
    console.log(`Created directory: ${userDir}`);
  }
  
  const recordingId = Date.now();
  const testFile = path.join(userDir, `test-recording-${recordingId}.webm`);
  
  // Create a dummy audio file
  const testData = Buffer.from('test audio data - ' + new Date().toISOString());
  fs.writeFileSync(testFile, testData);
  
  console.log(`Test file created: ${testFile}`);
  
  res.json({
    success: true,
    message: `Test file created for ${userId}`,
    file: testFile,
    url: `/recordings/${userId}/test-recording-${recordingId}.webm`,
    fullUrl: `${req.protocol}://${req.get('host')}/recordings/${userId}/test-recording-${recordingId}.webm`,
    size: testData.length
  });
});

// List all WebSocket connections
app.get('/debug/connections', (req, res) => {
  const connections = Array.from(activeConnections.entries()).map(([ws, data]) => ({
    userId: data.userId,
    connectedAt: data.connectedAt,
    duration: Math.floor((Date.now() - data.connectedAt.getTime()) / 1000),
    recordingId: data.currentRecordingId,
    bufferSize: data.audioBuffer?.length || 0,
    totalBufferBytes: data.audioBuffer?.reduce((sum, buf) => sum + buf.length, 0) || 0
  }));
  
  res.json({ 
    activeConnections: connections.length,
    connections: connections 
  });
});

// ========== MAIN ENDPOINTS ==========

// HTTP endpoint to start recording
app.post('/api/start-recording', (req, res) => {
  console.log('Starting audio recording session');
  
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }
  
  // Create user-specific directory
  const userDir = path.join(USER_RECORDINGS_DIR, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  
  res.json({ 
    status: 'Recording started',
    userId,
    directory: userDir,
    timestamp: new Date().toISOString()
  });
});

// HTTP endpoint to list recordings
app.get('/api/recordings', (req, res) => {
  try {
    if (!fs.existsSync(AUDIO_DIR)) {
      return res.json({ recordings: [] });
    }
    
    const files = fs.readdirSync(AUDIO_DIR)
      .filter(file => file.endsWith('.webm') || file.endsWith('.mp3'))
      .map(file => {
        const filePath = path.join(AUDIO_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          created: stats.birthtime,
          path: filePath
        };
      });
    
    res.json({ recordings: files });
  } catch (error) {
    console.error('Error listing recordings:', error);
    res.status(500).json({ error: 'Failed to list recordings' });
  }
});

// HTTP endpoint to get user recordings
app.get('/api/recordings/:userId', (req, res) => {
  const { userId } = req.params;
  
  try {
    // Clean userId - remove any trailing 'i' (from logs)
    const cleanUserId = userId.endsWith('i') ? userId.slice(0, -1) : userId;
    
    const userDir = path.join(USER_RECORDINGS_DIR, cleanUserId);
    
    if (!fs.existsSync(userDir)) {
      console.log(`Directory does not exist: ${userDir}`);
      return res.json({ 
        userId: cleanUserId,
        recordings: [],
        count: 0,
        directory: userDir,
        exists: false
      });
    }
    
    const files = fs.readdirSync(userDir)
      .filter(file => file.endsWith('.webm') || file.endsWith('.mp3') || file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(userDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          created: stats.birthtime,
          url: file.endsWith('.json') ? null : `/recordings/${cleanUserId}/${file}`,
          fullUrl: `${req.protocol}://${req.get('host')}/recordings/${cleanUserId}/${file}`
        };
      });
    
    res.json({ 
      userId: cleanUserId,
      recordings: files,
      count: files.length,
      directory: userDir,
      exists: true
    });
  } catch (error) {
    console.error('Error getting user recordings:', error);
    res.status(500).json({ 
      error: 'Failed to get recordings',
      message: error.message,
      userId: req.params.userId
    });
  }
});

// Serve audio files statically
app.use('/recordings', express.static(USER_RECORDINGS_DIR));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connections: activeConnections.size,
    storage: {
      audioDir: AUDIO_DIR,
      userRecordingsDir: USER_RECORDINGS_DIR,
      exists: fs.existsSync(AUDIO_DIR)
    },
    endpoints: {
      debugStorage: '/debug/storage',
      debugConnections: '/debug/connections',
      userRecordings: '/api/recordings/:userId',
      testSave: '/test-save/:userId'
    }
  });
});

// Get active connections
app.get('/api/connections', (req, res) => {
  const connections = Array.from(activeConnections.entries()).map(([ws, data]) => ({
    userId: data.userId,
    connectedAt: data.connectedAt,
    duration: Math.floor((Date.now() - data.connectedAt.getTime()) / 1000)
  }));
  
  res.json({ connections });
});

// Endpoint to upload audio directly
app.post('/api/upload-audio', (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required as query parameter' });
    }
    
    // Clean userId
    const cleanUserId = userId.endsWith('i') ? userId.slice(0, -1) : userId;
    
    const userDir = path.join(USER_RECORDINGS_DIR, cleanUserId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    const filename = `upload-${Date.now()}.webm`;
    const filepath = path.join(userDir, filename);
    
    fs.writeFileSync(filepath, req.body);
    console.log(`Audio uploaded for user ${cleanUserId}: ${filename} (${req.body.length} bytes)`);
    
    res.json({ 
      status: 'Upload successful', 
      filename,
      userId: cleanUserId,
      filepath,
      size: req.body.length,
      url: `/recordings/${cleanUserId}/${filename}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Audio Streaming Server',
    version: '1.0.0',
    debug: {
      storage: '/debug/storage',
      connections: '/debug/connections',
      testSave: '/test-save/:userId'
    },
    endpoints: {
      health: '/health',
      startRecording: 'POST /api/start-recording',
      uploadAudio: 'POST /api/upload-audio',
      getRecordings: 'GET /api/recordings',
      getUserRecordings: 'GET /api/recordings/:userId',
      connections: 'GET /api/connections',
      webSocket: 'Connect via WebSocket on the same port'
    },
    instructions: 'Connect via WebSocket for real-time streaming or use HTTP endpoints for file upload'
  });
});

// ========== WEBSOCKET SERVER ==========

// Start HTTP server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HTTP server running on port ${PORT}`);
  console.log(`📁 Audio files will be saved to: ${AUDIO_DIR}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔍 Debug storage: http://localhost:${PORT}/debug/storage`);
});

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

// Function to save recording
const saveRecording = (userId, recordingId, buffer) => {
  if (!recordingId || buffer.length === 0) {
    console.log(`⚠️ No audio data to save for recording ${recordingId}`);
    return;
  }
  
  // Clean userId
  const cleanUserId = userId.endsWith('i') ? userId.slice(0, -1) : userId;
  
  const userDir = path.join(USER_RECORDINGS_DIR, cleanUserId);
  const webmFile = path.join(userDir, `recording-${recordingId}.webm`);
  
  try {
    // Combine all chunks
    const combinedBuffer = Buffer.concat(buffer);
    
    console.log(`💾 Saving recording for ${cleanUserId}: ${webmFile} (${combinedBuffer.length} bytes)`);
    
    // Ensure directory exists
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
      console.log(`📁 Created directory: ${userDir}`);
    }
    
    // Save WebM file
    fs.writeFileSync(webmFile, combinedBuffer);
    console.log(`✅ Audio saved for user ${cleanUserId}: ${webmFile} (${combinedBuffer.length} bytes)`);
    
    // Update metadata
    const metaFile = path.join(userDir, `metadata-${recordingId}.json`);
    if (fs.existsSync(metaFile)) {
      const metadata = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      metadata.endTime = new Date().toISOString();
      metadata.fileSize = combinedBuffer.length;
      metadata.filePath = webmFile;
      fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
    }
 } catch (error) {
    console.error(`❌ Error saving recording ${recordingId} for user ${cleanUserId}:`, error);
  }
};

// ✅ ADD THIS FUNCTION HERE (AFTER saveRecording, BEFORE wss.on('connection'))
async function transcribeWithReplicate(audioBuffer, userId, recordingId, clientWs) {
  console.log(`🎤 Starting Replicate Whisper transcription for user: ${userId}`);

  try {
    // Convert audio buffer to base64 data URL
    const audioBase64 = audioBuffer.toString('base64');
    const dataUrl = `data:audio/webm;base64,${audioBase64}`;

    const input = {
      audio: dataUrl,
      model: "base", // Can change to "small", "medium", "large" for better accuracy
      transcription: "plain text",
    };

    console.log(`⏳ Sending ${audioBuffer.length} bytes audio to Replicate Whisper...`);
    
    // Run the Whisper model
    const output = await replicate.run(
      "openai/whisper:30414ee7c4fffc37e260fcab7842b5be470b9b840f2b608f5b2a8c6d6ba96e5c",
      { input }
    );

    // Get the transcript from response
    const transcript = output?.transcription || "";
    console.log(`📝 Replicate Whisper Result: "${transcript.substring(0, 100)}..."`);

    // Send the REAL transcript back to the client
    if (clientWs.readyState === WebSocket.OPEN && transcript) {
      clientWs.send(JSON.stringify({
        type: 'transcript',
        userId: userId,
        recordingId: recordingId,
        text: transcript.trim(),
        timestamp: new Date().toISOString(),
        engine: 'replicate-whisper'
      }));
      console.log(`✅ REAL transcript sent to user ${userId}`);
    }

    return transcript;

  } catch (error) {
    console.error('❌ Replicate Whisper transcription failed:', error.message);
    
    // Fallback: Send a generic message if STT fails
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'transcript',
        userId: userId,
        recordingId: recordingId,
        text: "I spoke something but couldn't transcribe it properly.",
        timestamp: new Date().toISOString(),
        engine: 'fallback'
      }));
    }
    return "";
  }
}
// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`🔌 New WebSocket connection from: ${clientIp}`);
  
  // Extract userId from query params
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  let userId = urlParams.get('userId');
  
  if (!userId) {
    userId = `anonymous_${uuidv4().substring(0, 8)}`;
  }
  
  console.log(`👤 User connected: ${userId}`);
  
  // Create user directory
  const userDir = path.join(USER_RECORDINGS_DIR, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
    console.log(`📁 Created user directory: ${userDir}`);
  }
  
  // Store connection data
  const connectionData = {
    userId,
    connectedAt: new Date(),
    currentRecordingId: null,
    audioBuffer: [],
    userDir,
    ws
  };
  
  activeConnections.set(ws, connectionData);
  
  // Send connection confirmation
  ws.send(JSON.stringify({
    type: 'connected',
    userId,
    timestamp: new Date().toISOString(),
    message: 'Connected to audio streaming server'
  }));
  
  // Handle incoming messages
// Handle incoming messages - COMPLETE FIXED VERSION
ws.on('message', (data, isBinary) => {
  const connData = activeConnections.get(ws);
  if (!connData) return;
  
  console.log(`📨 MESSAGE from ${connData.userId}:`, 
    isBinary ? `[BINARY: ${data.length} bytes]` : `[TEXT: ${data.toString().substring(0, 100)}]`);
  
  try {
    if (!isBinary) {
      // TEXT message (JSON)
      const message = JSON.parse(data.toString());
      console.log(`📨 Text message type: ${message.type}`);
      
      switch (message.type) {
        case 'register':
          console.log(`📝 User registered: ${message.userId || connData.userId}`);
          if (message.userId && message.userId !== connData.userId) {
            connData.userId = message.userId;
          }
          break;
          
        case 'start-recording':
          console.log(`🎤 STARTING recording for user: ${connData.userId}`);
          connData.currentRecordingId = Date.now();
          connData.audioBuffer = [];
          
          const metadata = {
            userId: connData.userId,
            recordingId: connData.currentRecordingId,
            startTime: new Date().toISOString(),
            sampleRate: message.sampleRate || 44100,
            channels: message.channels || 1,
            userName: message.userName || 'Anonymous'
          };
          
          const metaFile = path.join(connData.userDir, `metadata-${connData.currentRecordingId}.json`);
          fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
          
          ws.send(JSON.stringify({
            type: 'recording-started',
            recordingId: connData.currentRecordingId,
            timestamp: new Date().toISOString()
          }));
          break;
          
        case 'stop-recording':
  console.log(`⏹️ STOPPING recording for user: ${connData.userId}`);
  if (connData.currentRecordingId && connData.audioBuffer.length > 0) {
    // Combine all audio chunks
    const combinedBuffer = Buffer.concat(connData.audioBuffer);
    
    // Save recording
    saveRecording(connData.userId, connData.currentRecordingId, connData.audioBuffer);
    
    // Send recording stopped confirmation
    ws.send(JSON.stringify({
      type: 'recording-stopped',
      recordingId: connData.currentRecordingId,
      timestamp: new Date().toISOString()
    }));
    
    // 🎯 NEW: Send for REAL transcription with Replicate
    transcribeWithReplicate(combinedBuffer, connData.userId, connData.currentRecordingId, ws)
      .then(transcript => {
        console.log(`✅ Replicate transcription completed for ${connData.userId}`);
      })
      .catch(err => {
        console.error(`❌ Transcription failed: ${err.message}`);
      });
    
    // Clear buffer
    connData.currentRecordingId = null;
    connData.audioBuffer = [];
  }
  break;
          
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
          break;
      }
    } else {
      // BINARY message (audio data)
      if (connData.currentRecordingId) {
        let buffer;
        if (data instanceof ArrayBuffer) {
          buffer = Buffer.from(data);
        } else if (Buffer.isBuffer(data)) {
          buffer = data;
        } else if (data instanceof Uint8Array) {
          buffer = Buffer.from(data);
        } else {
          console.error('❓ Unknown binary data type:', data.constructor.name);
          return;
        }
        
        connData.audioBuffer.push(buffer);
        
        if (connData.audioBuffer.length % 10 === 0) {
          console.log(`📊 ${connData.userId}: ${connData.audioBuffer.length} chunks, ${connData.audioBuffer.reduce((sum, buf) => sum + buf.length, 0)} bytes`);
        }
      } else {
        console.log(`⚠️ Audio data but no active recording for ${connData.userId}`);
      }
    }
  } catch (error) {
    console.error(`❌ Error processing message from ${connData.userId}:`, error);
  }
});
  
  // Handle connection close
  ws.on('close', () => {
    console.log(`👋 User disconnected: ${userId}`);
    
    const connData = activeConnections.get(ws);
    if (connData) {
      // Save any pending recording
      if (connData.currentRecordingId && connData.audioBuffer.length > 0) {
        console.log(`💾 Auto-saving recording on disconnect for ${connData.userId}`);
        saveRecording(connData.userId, connData.currentRecordingId, connData.audioBuffer);
      }
      
      activeConnections.delete(ws);
    }
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`⚠️ WebSocket error for ${userId}:`, error);
    activeConnections.delete(ws);
  });
});

console.log(`🔌 WebSocket server listening on ws://localhost:${PORT}`);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  
  // Close WebSocket connections
  wss.clients.forEach(client => {
    client.close();
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

module.exports = { app, wss };
