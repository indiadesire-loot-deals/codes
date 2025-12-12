// server.js - FIXED VERSION WITH DEBUGGING
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
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

// Python-based Vosk transcription
async function transcribeWithVosk(audioBuffer, userId, recordingId, clientWs) {
  console.log(`🎤 Starting Python Vosk STT for ${userId} (${audioBuffer.length} bytes)`);
  
  try {
    // 1. Save audio to temporary file
    const tempWebm = `/tmp/temp-${recordingId}.webm`;
    const tempWav = `/tmp/temp-${recordingId}.wav`;
    
    fs.writeFileSync(tempWebm, audioBuffer);
    
    // 2. Convert WebM to WAV using ffmpeg
    console.log('🔄 Converting audio to WAV format...');
    await new Promise((resolve, reject) => {
      ffmpeg(tempWebm)
        .audioFrequency(16000)
        .audioChannels(1)
        .format('wav')
        .save(tempWav)
        .on('end', resolve)
        .on('error', (err) => {
          console.error('FFmpeg conversion error:', err.message);
          reject(err);
        });
    });
    
    console.log(`✅ Audio converted: ${fs.statSync(tempWav).size} bytes`);
    
    // 3. Run Python vosk transcription script
    console.log('🔤 Transcribing with Python Vosk...');
    
    // Create a Python script as a string
    const pythonScript = `
import sys
import json
import wave
from vosk import Model, KaldiRecognizer

# Load model from current directory
model = Model('vosk-model')

# Read WAV file
try:
    wf = wave.open('${tempWav}', 'rb')
except Exception as e:
    print(json.dumps({'error': f'Cannot open audio file: {str(e)}'}))
    sys.exit(1)

# Check audio format
if wf.getnchannels() != 1:
    print(json.dumps({'error': 'Audio file must be mono (1 channel)'}))
    sys.exit(1)

if wf.getsampwidth() != 2:
    print(json.dumps({'error': 'Audio file must be 16-bit PCM'}))
    sys.exit(1)

if wf.getframerate() not in [8000, 16000, 32000, 48000]:
    print(json.dumps({'error': f'Unsupported sample rate: {wf.getframerate()}'}))
    sys.exit(1)

# Create recognizer
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(True)

# Process audio
transcript_parts = []
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        result = json.loads(rec.Result())
        if 'text' in result and result['text']:
            transcript_parts.append(result['text'])

# Get final result
final_result = json.loads(rec.FinalResult())
if 'text' in final_result and final_result['text']:
    transcript_parts.append(final_result['text'])

# Combine all parts
full_transcript = ' '.join(transcript_parts).strip()

# Return result
print(json.dumps({
    'text': full_transcript,
    'model': 'vosk-model-small-en-us-0.15'
}))
`;
    
    // Save Python script to temp file
    const pythonScriptFile = `/tmp/vosk-script-${recordingId}.py`;
    fs.writeFileSync(pythonScriptFile, pythonScript);
    
    // Execute Python script
    const { stdout, stderr } = await execAsync(`cd ${__dirname} && python3 ${pythonScriptFile}`);
    
    // Clean up temp files
    fs.unlinkSync(tempWebm);
    fs.unlinkSync(tempWav);
    fs.unlinkSync(pythonScriptFile);
    
    // Parse result
    const result = JSON.parse(stdout);
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    const transcript = result.text.trim();
    
    if (transcript) {
      console.log(`📝 Vosk Transcript: "${transcript}"`);
      
      // Send to client
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'transcript',
          userId: userId,
          recordingId: recordingId,
          text: transcript,
          timestamp: new Date().toISOString(),
          engine: 'vosk-offline'
        }));
        console.log(`✅ Vosk transcript sent to ${userId}`);
      }
      
      return transcript;
    } else {
      console.log('⚠️ Empty transcription received');
      throw new Error('Empty transcription');
    }
    
  } catch (error) {
    console.error('❌ Vosk STT error:', error.message);
    
    // Try to clean up temp files if they exist
    try {
      const tempFiles = [
        `/tmp/temp-${recordingId}.webm`,
        `/tmp/temp-${recordingId}.wav`,
        `/tmp/vosk-script-${recordingId}.py`
      ];
      tempFiles.forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
    } catch (e) {
      // Ignore cleanup errors
    }
    
    // Fallback message
    if (clientWs.readyState === WebSocket.OPEN) {
      const fallbackText = `[Vosk: ${error.message}] Said something like "Hello"`;
      clientWs.send(JSON.stringify({
        type: 'transcript',
        userId: userId,
        recordingId: recordingId,
        text: fallbackText,
        timestamp: new Date().toISOString(),
        engine: 'vosk-fallback'
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
    const combinedBuffer = Buffer.concat(connData.audioBuffer);
    
    // Save recording
    saveRecording(connData.userId, connData.currentRecordingId, connData.audioBuffer);
    
    // Send confirmation
    ws.send(JSON.stringify({
      type: 'recording-stopped',
      recordingId: connData.currentRecordingId,
      timestamp: new Date().toISOString()
    }));
    
    // 🎯 CHANGE THIS LINE: Use VOSK instead of Replicate
    transcribeWithVosk(combinedBuffer, connData.userId, connData.currentRecordingId, ws)
      .then(transcript => {
        console.log(`✅ Vosk transcription completed for ${connData.userId}`);
      })
      .catch(err => {
        console.error(`❌ Vosk failed: ${err.message}`);
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
