const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Get port from environment variable (Render provides this)
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
      .filter(file => file.endsWith('.webm') || file.endsWith('.mp3'))
      .map(file => {
        const filePath = path.join(userDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          created: stats.birthtime,
          url: `/recordings/${userId}/${file}`
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

// WebSocket server for real-time audio streaming
const createWebSocketServer = (server) => {
  const wss = new WebSocket.Server({ server });
  
  wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');
    
    // Extract userId from query params if provided
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const userId = urlParams.get('userId') || `anonymous_${Date.now()}`;
    
    console.log(`User connected: ${userId}`);
    activeConnections.set(ws, { userId, connectedAt: new Date() });
    
    // Create user directory
    const userDir = path.join(USER_RECORDINGS_DIR, userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    let currentRecordingId = null;
    let audioBuffer = [];
    let mediaRecorder = null;
    
    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        // Check if data is JSON or binary
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          
          switch (message.type) {
            case 'start-recording':
              console.log(`Starting recording for user: ${userId}`);
              currentRecordingId = Date.now();
              audioBuffer = [];
              
              // Create metadata file
              const metadata = {
                userId,
                recordingId: currentRecordingId,
                startTime: new Date().toISOString(),
                sampleRate: message.sampleRate || 44100,
                channels: message.channels || 1
              };
              
              const metaFile = path.join(userDir, `metadata-${currentRecordingId}.json`);
              fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
              
              ws.send(JSON.stringify({
                type: 'recording-started',
                recordingId: currentRecordingId,
                timestamp: new Date().toISOString()
              }));
              break;
              
            case 'stop-recording':
              console.log(`Stopping recording for user: ${userId}`);
              saveRecording(userId, currentRecordingId, audioBuffer);
              
              ws.send(JSON.stringify({
                type: 'recording-stopped',
                recordingId: currentRecordingId,
                timestamp: new Date().toISOString()
              }));
              
              currentRecordingId = null;
              audioBuffer = [];
              break;
              
            case 'audio-chunk':
              if (currentRecordingId) {
                audioBuffer.push(Buffer.from(data.slice('audio-chunk:'.length)));
              }
              break;
          }
        } else {
          // Binary data (audio chunks)
          if (currentRecordingId && Buffer.isBuffer(data)) {
            audioBuffer.push(data);
            
            // Send acknowledgement
            ws.send(JSON.stringify({
              type: 'chunk-received',
              size: data.length,
              timestamp: Date.now()
            }));
          }
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    });
    
    ws.on('close', () => {
      console.log(`User disconnected: ${userId}`);
      
      // Save any pending recording
      if (currentRecordingId && audioBuffer.length > 0) {
        saveRecording(userId, currentRecordingId, audioBuffer);
      }
      
      activeConnections.delete(ws);
    });
    
    ws.on('error', (error) => {
      console.error(`WebSocket error for user ${userId}:`, error);
    });
    
    // Send initial connection message
    ws.send(JSON.stringify({
      type: 'connected',
      userId,
      timestamp: new Date().toISOString(),
      message: 'Connected to audio streaming server'
    }));
  });
  
  // Function to save recording
  const saveRecording = (userId, recordingId, buffer) => {
    if (buffer.length === 0) {
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
    // Check if ffmpeg is available
    const { exec } = require('child_process');
    
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
  
  // Broadcast to all connections
  wss.broadcast = function(data) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  };
  
  console.log('WebSocket server created');
  return wss;
};

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
      webSocket: 'ws://https://codes-ak8j.onrender.com/
    },
    instructions: 'Connect via WebSocket for real-time streaming or use HTTP endpoints for file upload'
  });
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
  console.log(`Audio files will be saved to: ${AUDIO_DIR}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Create WebSocket server
const wss = createWebSocketServer(server);

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
