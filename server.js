// In server.js, update the ws.on('message') handler:

ws.on('message', async (data) => {
  try {
    // Check if data is JSON or binary
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'register':
          console.log(`User registered: ${message.userId} (${message.userName || 'Anonymous'})`);
          ws.send(JSON.stringify({
            type: 'connected',
            userId: message.userId,
            timestamp: new Date().toISOString(),
            message: 'Connected to audio streaming server'
          }));
          break;
          
        case 'start-recording':
          console.log(`Starting recording for user: ${message.userId}`);
          currentRecordingId = Date.now();
          audioBuffer = [];
          
          // Create metadata file
          const metadata = {
            userId: message.userId,
            recordingId: currentRecordingId,
            startTime: new Date().toISOString(),
            sampleRate: message.sampleRate || 44100,
            channels: message.channels || 1,
            userName: message.userName || 'Anonymous'
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
          console.log(`Stopping recording for user: ${message.userId}`);
          saveRecording(userId, currentRecordingId, audioBuffer);
          
          ws.send(JSON.stringify({
            type: 'recording-stopped',
            recordingId: currentRecordingId,
            timestamp: new Date().toISOString()
          }));
          
          currentRecordingId = null;
          audioBuffer = [];
          break;
          
        case 'stop-streaming':
          console.log(`User ${message.userId} stopped streaming`);
          if (currentRecordingId && audioBuffer.length > 0) {
            saveRecording(userId, currentRecordingId, audioBuffer);
          }
          currentRecordingId = null;
          audioBuffer = [];
          break;
      }
    } else {
      // Binary data (audio chunks)
      if (currentRecordingId && Buffer.isBuffer(data)) {
        audioBuffer.push(data);
        
        // Send acknowledgement if needed
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
