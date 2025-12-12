// server.js - COMPLETE VERSION WITH PYTHON VOSK STT
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

const PORT = process.env.PORT || 10000;
const AUDIO_DIR = path.join(__dirname, 'server-recordings');
const USER_RECORDINGS_DIR = path.join(AUDIO_DIR, 'user-recordings');

// Ensure directories exist
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(USER_RECORDINGS_DIR)) fs.mkdirSync(USER_RECORDINGS_DIR, { recursive: true });

const activeConnections = new Map();

// ========== HEALTH & DEBUG ENDPOINTS ==========
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    endpoints: ['/health', '/debug/storage', '/api/recordings/:userId']
  });
});

app.get('/debug/storage', (req, res) => {
  try {
    const users = fs.existsSync(USER_RECORDINGS_DIR) ? fs.readdirSync(USER_RECORDINGS_DIR) : [];
    res.json({ storagePath: USER_RECORDINGS_DIR, totalUsers: users.length });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/upload-audio', (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'User ID required' });
    
    const cleanUserId = userId.endsWith('i') ? userId.slice(0, -1) : userId;
    const userDir = path.join(USER_RECORDINGS_DIR, cleanUserId);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    
    const filename = `upload-${Date.now()}.webm`;
    const filepath = path.join(userDir, filename);
    fs.writeFileSync(filepath, req.body);
    
    res.json({ 
      status: 'Upload successful', 
      filename, 
      userId: cleanUserId,
      size: req.body.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/recordings/:userId', (req, res) => {
  const { userId } = req.params;
  const cleanUserId = userId.endsWith('i') ? userId.slice(0, -1) : userId;
  const userDir = path.join(USER_RECORDINGS_DIR, cleanUserId);
  
  if (!fs.existsSync(userDir)) {
    return res.json({ userId: cleanUserId, recordings: [], exists: false });
  }
  
  const files = fs.readdirSync(userDir)
    .filter(file => file.endsWith('.webm') || file.endsWith('.mp3') || file.endsWith('.json'))
    .map(file => ({
      filename: file,
      url: file.endsWith('.json') ? null : `/recordings/${cleanUserId}/${file}`,
      size: fs.statSync(path.join(userDir, file)).size
    }));
  
  res.json({ userId: cleanUserId, recordings: files, exists: true });
});

app.use('/recordings', express.static(USER_RECORDINGS_DIR));

// ========== PYTHON VOSK TRANSCRIPTION ==========
async function transcribeWithPythonVosk(audioBuffer, userId, recordingId, clientWs) {
  console.log(`🎤 Starting Python Vosk transcription for ${userId} (${audioBuffer.length} bytes)`);
  
  try {
    // 1. Save audio to temporary file
    const tempWebm = `/tmp/audio-${recordingId}.webm`;
    const tempWav = `/tmp/audio-${recordingId}.wav`;
    
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
        .on('error', reject);
    });
    
    console.log(`✅ Audio converted: ${fs.statSync(tempWav).size} bytes`);
    
    // 3. Create Python script for Vosk transcription
    const pythonScript = `
import sys
import json
import wave
from vosk import Model, KaldiRecognizer
import os

# Load model from current directory
model_path = "/vosk-model"
if not os.path.exists(model_path):
    print(json.dumps({"error": "Vosk model not found at: " + model_path}))
    sys.exit(1)

model = Model(model_path)

# Read WAV file
try:
    wf = wave.open('${tempWav}', 'rb')
except Exception as e:
    print(json.dumps({"error": f"Cannot open audio file: {str(e)}"}))
    sys.exit(1)

# Check audio format
if wf.getnchannels() != 1:
    print(json.dumps({"error": "Audio file must be mono (1 channel)"}))
    sys.exit(1)

if wf.getsampwidth() != 2:
    print(json.dumps({"error": "Audio file must be 16-bit PCM"}))
    sys.exit(1)

if wf.getframerate() not in [8000, 16000, 32000, 48000]:
    print(json.dumps({"error": f"Unsupported sample rate: {wf.getframerate()}"}))
    sys.exit(1)

# Create recognizer
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(True)

# Process audio
full_text = ""
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        result = json.loads(rec.Result())
        if 'text' in result and result['text']:
            full_text += " " + result['text']

# Get final result
final_result = json.loads(rec.FinalResult())
if 'text' in final_result and final_result['text']:
    full_text += " " + final_result['text']

# Return result
print(json.dumps({
    "text": full_text.strip(),
    "success": True,
    "model": "vosk-model-small-en-us-0.15"
}))
`;
    
    // 4. Save Python script to temporary file
    const pythonScriptFile = `/tmp/vosk-transcribe-${recordingId}.py`;
    fs.writeFileSync(pythonScriptFile, pythonScript);
    
    // 5. Execute Python script
    console.log('🔤 Running Python Vosk transcription...');
    const { stdout, stderr } = await execAsync(`cd /usr/src/app && python3 ${pythonScriptFile}`);
    
    // 6. Clean up temporary files
    fs.unlinkSync(tempWebm);
    fs.unlinkSync(tempWav);
    fs.unlinkSync(pythonScriptFile);
    
    // 7. Parse result
    const result = JSON.parse(stdout);
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    const transcript = result.text || "[No speech detected]";
    
    if (transcript) {
      console.log(`📝 Python Vosk Transcript: "${transcript}"`);
      
      // Send to client
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'transcript',
          userId: userId,
          recordingId: recordingId,
          text: transcript,
          timestamp: new Date().toISOString(),
          engine: 'python-vosk'
        }));
        console.log(`✅ Transcript sent to ${userId}`);
      }
      
      return transcript;
    } else {
      throw new Error('Empty transcription received');
    }
    
  } catch (error) {
    console.error('❌ Python Vosk transcription error:', error.message);
    
    // Clean up any remaining temp files
    try {
      const tempFiles = [
        `/tmp/audio-${recordingId}.webm`,
        `/tmp/audio-${recordingId}.wav`,
        `/tmp/vosk-transcribe-${recordingId}.py`
      ];
      tempFiles.forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
    } catch (e) {
      // Ignore cleanup errors
    }
    
    // Send error to client
    if (clientWs.readyState === WebSocket.OPEN) {
      const errorText = `[Transcription Error: ${error.message}]`;
      clientWs.send(JSON.stringify({
        type: 'transcript',
        userId: userId,
        recordingId: recordingId,
        text: errorText,
        timestamp: new Date().toISOString(),
        engine: 'error'
      }));
    }
    
    return `[Transcription failed: ${error.message}]`;
  }
}

// ========== WEBSOCKET SERVER ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HTTP server running on port ${PORT}`);
  console.log(`📁 Audio files saved to: ${AUDIO_DIR}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔤 Using Python Vosk for transcription`);
});

const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// Function to save recording
const saveRecording = (userId, recordingId, buffer) => {
  if (!recordingId || buffer.length === 0) return null;
  
  const cleanUserId = userId.endsWith('i') ? userId.slice(0, -1) : userId;
  const userDir = path.join(USER_RECORDINGS_DIR, cleanUserId);
  const webmFile = path.join(userDir, `recording-${recordingId}.webm`);
  
  try {
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    
    const combinedBuffer = Buffer.concat(buffer);
    fs.writeFileSync(webmFile, combinedBuffer);
    console.log(`✅ Audio saved: ${webmFile} (${combinedBuffer.length} bytes)`);
    
    // Save metadata
    const metaFile = path.join(userDir, `metadata-${recordingId}.json`);
    const metadata = {
      userId: cleanUserId,
      recordingId,
      fileSize: combinedBuffer.length,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
    
    return combinedBuffer;
  } catch (error) {
    console.error(`❌ Error saving recording:`, error);
    return null;
  }
};

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  let userId = urlParams.get('userId') || `anonymous_${uuidv4().substring(0, 8)}`;
  
  console.log(`👤 User connected: ${userId}`);
  
  const userDir = path.join(USER_RECORDINGS_DIR, userId);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  
  const connectionData = {
    userId,
    connectedAt: new Date(),
    currentRecordingId: null,
    audioBuffer: [],
    userDir,
    ws
  };
  
  activeConnections.set(ws, connectionData);
  
  ws.send(JSON.stringify({
    type: 'connected',
    userId,
    timestamp: new Date().toISOString(),
    message: 'Connected to audio streaming server with Python Vosk STT'
  }));
  
  ws.on('message', async (data, isBinary) => {
    const connData = activeConnections.get(ws);
    if (!connData) return;
    
    try {
      if (!isBinary) {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'start-recording':
            connData.currentRecordingId = Date.now();
            connData.audioBuffer = [];
            
            ws.send(JSON.stringify({
              type: 'recording-started',
              recordingId: connData.currentRecordingId,
              timestamp: new Date().toISOString()
            }));
            break;
            
          case 'stop-recording':
            if (connData.currentRecordingId && connData.audioBuffer.length > 0) {
              // Save recording
              const audioBuffer = saveRecording(
                connData.userId, 
                connData.currentRecordingId, 
                connData.audioBuffer
              );
              
              // Send confirmation
              ws.send(JSON.stringify({
                type: 'recording-stopped',
                recordingId: connData.currentRecordingId,
                timestamp: new Date().toISOString(),
                message: 'Audio saved. Transcribing with Python Vosk...'
              }));
              
              // Transcribe with Python Vosk (async)
              if (audioBuffer) {
                transcribeWithPythonVosk(
                  audioBuffer, 
                  connData.userId, 
                  connData.currentRecordingId, 
                  ws
                ).then(transcript => {
                  console.log(`✅ Python Vosk transcription completed for ${connData.userId}`);
                }).catch(err => {
                  console.error(`❌ Transcription failed:`, err);
                });
              }
              
              // Clear buffer
              connData.currentRecordingId = null;
              connData.audioBuffer = [];
            }
            break;
            
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        }
      } else {
        // BINARY audio data
        if (connData.currentRecordingId) {
          let buffer;
          if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
          else if (Buffer.isBuffer(data)) buffer = data;
          else if (data instanceof Uint8Array) buffer = Buffer.from(data);
          else return;
          
          connData.audioBuffer.push(buffer);
          
          // Log progress every 10 chunks
          if (connData.audioBuffer.length % 10 === 0) {
            const totalBytes = connData.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
            console.log(`📊 ${connData.userId}: ${connData.audioBuffer.length} chunks, ${totalBytes} bytes`);
          }
        }
      }
    } catch (error) {
      console.error(`❌ Error processing message:`, error);
    }
  });
  
  ws.on('close', () => {
    const connData = activeConnections.get(ws);
    if (connData) {
      if (connData.currentRecordingId && connData.audioBuffer.length > 0) {
        console.log(`💾 Auto-saving on disconnect for ${connData.userId}`);
        saveRecording(connData.userId, connData.currentRecordingId, connData.audioBuffer);
      }
      activeConnections.delete(ws);
    }
  });
  
  ws.on('error', (error) => {
    console.error(`⚠️ WebSocket error:`, error);
    activeConnections.delete(ws);
  });
});

console.log(`🔌 WebSocket server listening on ws://localhost:${PORT}`);

// ========== GRACEFUL SHUTDOWN ==========
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });
  
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

module.exports = { app, wss };
