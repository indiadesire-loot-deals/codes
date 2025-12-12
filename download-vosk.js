// download-vosk.js
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');

const modelUrl = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const outputPath = 'vosk-model.zip';

console.log('📥 Downloading Vosk model (40MB)...');
console.log('URL:', modelUrl);

const file = fs.createWriteStream(outputPath);

https.get(modelUrl, (response) => {
  const totalSize = parseInt(response.headers['content-length'], 10);
  let downloaded = 0;
  
  response.on('data', (chunk) => {
    downloaded += chunk.length;
    const percent = ((downloaded / totalSize) * 100).toFixed(1);
    process.stdout.write(`\r📥 Downloading: ${percent}% (${Math.floor(downloaded/1024/1024)}MB/${Math.floor(totalSize/1024/1024)}MB)`);
  });
  
  response.pipe(file);
  
  file.on('finish', () => {
    file.close();
    console.log('\n✅ Download complete!');
    
    try {
      console.log('📦 Extracting ZIP file...');
      
      // Check if unzip command exists
      try {
        execSync('which unzip');
      } catch (e) {
        console.log('❌ "unzip" command not found. Please install:');
        console.log('   macOS: brew install unzip');
        console.log('   Ubuntu/Debian: sudo apt-get install unzip');
        console.log('   Windows: Use 7-Zip or similar');
        return;
      }
      
      // Extract
      execSync(`unzip -q ${outputPath}`);
      console.log('✅ Extraction complete');
      
      // Rename folder
      if (fs.existsSync('vosk-model-small-en-us-0.15')) {
        if (fs.existsSync('vosk-model')) {
          console.log('⚠️ Removing old vosk-model folder...');
          execSync('rm -rf vosk-model');
        }
        fs.renameSync('vosk-model-small-en-us-0.15', 'vosk-model');
        console.log('✅ Renamed to vosk-model/');
        
        // Clean up ZIP file
        fs.unlinkSync(outputPath);
        console.log('🗑️ Removed ZIP file');
        
        console.log('\n🎉 Vosk model ready!');
        console.log('📁 Location: vosk-model/');
        console.log('📦 Size:', Math.floor(fs.statSync('vosk-model').size / 1024 / 1024), 'MB');
      } else {
        console.log('❌ Expected folder not found after extraction');
      }
      
    } catch (error) {
      console.error('❌ Error:', error.message);
      console.log('\n📝 Manual steps:');
      console.log('1. Extract vosk-model.zip manually');
      console.log('2. Rename folder to "vosk-model"');
      console.log('3. Place in your project root');
    }
    
  });
}).on('error', (error) => {
  console.error('❌ Download failed:', error.message);
  console.log('\n📥 Manual download:');
  console.log('1. Visit: https://alphacephei.com/vosk/models');
  console.log('2. Download: vosk-model-small-en-us-0.15.zip');
  console.log('3. Extract and rename to "vosk-model"');
});
