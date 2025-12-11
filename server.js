// server.js - PERFECT VERSION FOR YOUR CLIENT CODE
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

app.use(cors({
  origin: 'https://gff.lovable.app',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// Get port from environment variable
const PORT = process.env.PORT || 8080;

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
  const userDir = path.join(USER_RECORDINGS_DIR, userId);
  
  try {
    if (!fs.existsSync(userDir)) {
      return res.json({ recordings: [] });
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
          url: file.endsWith('.json') ? null : `/recordings/${userId}/${file}`
        };
      });
    
    res.json({ 
      userId,
      recordings: files,
      count: files.length
    });
  } catch (error) {
    console.error('Error getting user recordings:', error);
    res.status(500).json({ error: 'Failed to get recordings' });
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
app.post('/api/upload-audio', express.raw({ type: 'audio/webm', limit: '50mb' }), (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required as query parameter' });
    }
    
    const userDir = path.join(USER_RECORDINGS_DIR, userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    const filename = `upload-${Date.now()}.webm`;
    const filepath = path.join(userDir, filename);
    
    fs.writeFileSync(filepath, req.body);
    console.log(`Audio uploaded for user ${userId}: ${filename} (${req.body.length} bytes)`);
    
    res.json({ 
      status: 'Upload successful', 
      filename,
      userId,
      filepath,
      size: req.body.length,
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

// Start HTTP server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${PORT}`);
  console.log(`Audio files will be saved to: ${AUDIO_DIR}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Create WebSocket server with same HTTP server
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

// Function to save recording
const saveRecording = (userId, recordingId, buffer) => {
  if (!recordingId || buffer.length === 0) {
    console.log(`No audio data to save for recording ${recordingId}`);
    return;
  }
  
  const userDir = path.join(USER_RECORDINGS_DIR, userId);
  const webmFile = path.join(userDir, `recording-${recordingId}.webm`);
  
  try {
    // Combine all chunks
    const combinedBuffer = Buffer.concat(buffer);
    
    // Save WebM file
    fs.writeFileSync(webmFile, combinedBuffer);
    console.log(`Audio saved for user ${userId}: ${webmFile} (${combinedBuffer.length} bytes)`);
    
    // Try to convert to MP3 if ffmpeg is available
    convertToMP3(webmFile, recordingId, userId);
    
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
    console.error(`Error saving recording ${recordingId} for user ${userId}:`, error);
  }
};

// Function to convert WebM to MP3
const convertToMP3 = (inputFile, recordingId, userId) => {
  const { exec } = require('child_process');
  
  // Check if ffmpeg is available
  exec('which ffmpeg || where ffmpeg', (error) => {
    if (error) {
      console.log('FFmpeg not available, skipping MP3 conversion');
      return;
    }
    
    const mp3File = inputFile.replace('.webm', '.mp3');
    const userDir = path.join(USER_RECORDINGS_DIR, userId);
    
    exec(`ffmpeg -i "${inputFile}" -codec:a libmp3lame -qscale:a 2 "${mp3File}"`, (ffmpegError) => {
      if (ffmpegError) {
        console.error(`MP3 conversion failed for recording ${recordingId}:`, ffmpegError);
      } else {
        console.log(`Converted to MP3: ${mp3File}`);
        
        // Update metadata
        const metaFile = path.join(userDir, `metadata-${recordingId}.json`);
        if (fs.existsSync(metaFile)) {
          const metadata = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          metadata.mp3File = mp3File;
          fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
        }
      }
    });
  });
};

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from:', req.socket.remoteAddress);
  
  // Extract userId from query params
  const url = new URL(req.url, `http://${req.headers.host}`);
  let userId = url.searchParams.get('userId');
  
  if (!userId) {
    userId = `anonymous_${uuidv4().substring(0, 8)}`;
  }
  
  console.log(`User connected: ${userId}`);
  
  // Create user directory
  const userDir = path.join(USER_RECORDINGS_DIR, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  
  // Store connection data
  const connectionData = {
    userId,
    connectedAt: new Date(),
    currentRecordingId: null,
    audioBuffer: [],
    userDir
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
  ws.on('message', (data) => {
    try {
      // Check if data is text (JSON) or binary
      if (typeof data === 'string') {
        // Text message (JSON)
        const message = JSON.parse(data);
        const connData = activeConnections.get(ws);
        
        if (!connData) return;
        
        switch (message.type) {
          case 'register':
            console.log(`User registered: ${message.userId} (${message.userName || 'Anonymous'})`);
            // Update userId if different
            if (message.userId && message.userId !== connData.userId) {
              connData.userId = message.userId;
            }
            break;
            
          case 'start-recording':
            console.log(`Starting recording for user: ${message.userId || connData.userId}`);
            connData.currentRecordingId = Date.now();
            connData.audioBuffer = [];
            
            // Create metadata file
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
            console.log(`Stopping recording for user: ${connData.userId}`);
            if (connData.currentRecordingId) {
              saveRecording(connData.userId, connData.currentRecordingId, connData.audioBuffer);
              
              ws.send(JSON.stringify({
                type: 'recording-stopped',
                recordingId: connData.currentRecordingId,
                timestamp: new Date().toISOString()
              }));
              
              connData.currentRecordingId = null;
              connData.audioBuffer = [];
            }
            break;
            
          case 'stop-streaming':
            console.log(`User ${connData.userId} stopped streaming`);
            if (connData.currentRecordingId && connData.audioBuffer.length > 0) {
              saveRecording(connData.userId, connData.currentRecordingId, connData.audioBuffer);
            }
            connData.currentRecordingId = null;
            connData.audioBuffer = [];
            break;
        }
      } else {
        // Binary message (audio data)
        const connData = activeConnections.get(ws);
        
        if (connData && connData.currentRecordingId) {
          // Convert ArrayBuffer to Buffer
          let buffer;
          if (data instanceof ArrayBuffer) {
            buffer = Buffer.from(data);
          } else if (Buffer.isBuffer(data)) {
            buffer = data;
          } else if (data instanceof Uint8Array) {
            buffer = Buffer.from(data);
          } else {
            console.error('Unknown binary data type:', typeof data);
            return;
          }
          
          // Store audio chunk
          connData.audioBuffer.push(buffer);
          
          // Send acknowledgement
          ws.send(JSON.stringify({
            type: 'chunk-received',
            size: buffer.length,
            timestamp: Date.now()
          }));
        }
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
      
      // Send error to client
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to process message',
        error: error.message
      }));
    }
  });
  
  // Handle connection close
  ws.on('close', () => {
    console.log(`User disconnected: ${userId}`);
    
    const connData = activeConnections.get(ws);
    if (connData) {
      // Save any pending recording
      if (connData.currentRecordingId && connData.audioBuffer.length > 0) {
        saveRecording(connData.userId, connData.currentRecordingId, connData.audioBuffer);
      }
      
      activeConnections.delete(ws);
    }
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for user ${userId}:`, error);
    activeConnections.delete(ws);
  });
});

// Broadcast to all connections
wss.broadcast = function(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
};

console.log(`WebSocket server listening on ws://localhost:${PORT}`);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  // Close WebSocket connections
  wss.clients.forEach(client => {
    client.close();
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, wss };
