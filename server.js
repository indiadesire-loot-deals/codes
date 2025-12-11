// server.js
const express = require('express');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const HTTP_PORT = 8080;       // React client HTTP requests
const WS_PORT = 8081;         // WebSocket port for React client
const TCP_PORT = 46874;       // PktRiot sends audio here
const AUDIO_DIR = './server-recordings';

// Create audio directory if it doesn't exist
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ---------------------
// Express HTTP Endpoints
// ---------------------
app.use(express.json());
app.use(express.raw({ type: 'audio/webm', limit: '50mb' }));

// Start recording endpoint (optional)
app.post('/start-recording', (req, res) => {
  console.log('Start recording command received from client');
  exec('node audio-processor.js', (error, stdout, stderr) => {
    if (error) console.error('Error starting audio processor:', error.message);
  });
  res.json({ status: 'Recording started' });
});

// Upload audio endpoint (backup)
app.post('/upload-audio', (req, res) => {
  const filename = `upload-${Date.now()}.webm`;
  const filepath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filepath, req.body);
  console.log(`Audio uploaded via HTTP: ${filename}`);
  res.json({ status: 'Upload successful', filename });
});

// Start Express HTTP server
app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on http://localhost:${HTTP_PORT}`);
});

// ---------------------
// WebSocket server for React client
// ---------------------
const wss = new WebSocket.Server({ port: WS_PORT });
wss.on('connection', (ws) => {
  console.log('React client connected via WebSocket');

  ws.on('close', () => console.log('React client disconnected'));
});

console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);

// ---------------------
// TCP server for PktRiot
// ---------------------
const tcpServer = net.createServer((socket) => {
  console.log('PktRiot connected via TCP');

  const recordingId = Date.now();
  let audioBuffer = [];

  socket.on('data', (chunk) => {
    audioBuffer.push(chunk);

    // Forward audio to all connected WebSocket clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(chunk);
      }
    });
  });

  socket.on('end', () => {
    const webmFile = path.join(AUDIO_DIR, `recording-${recordingId}.webm`);
    fs.writeFileSync(webmFile, Buffer.concat(audioBuffer));
    console.log(`Audio received from PktRiot saved: ${webmFile}`);

    // Convert to MP3 using ffmpeg
    const mp3File = path.join(AUDIO_DIR, `recording-${recordingId}.mp3`);
    exec(`ffmpeg -i ${webmFile} -codec:a libmp3lame -qscale:a 2 ${mp3File}`, (error) => {
      if (error) console.error('MP3 conversion failed:', error);
      else console.log(`Converted to MP3: ${mp3File}`);
    });
  });

  socket.on('error', (err) => console.error('TCP socket error:', err));
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`TCP server listening for PktRiot on port ${TCP_PORT}`);
});
