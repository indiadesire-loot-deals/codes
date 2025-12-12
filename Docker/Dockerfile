# Dockerfile - FIXED VERSION
FROM node:18-bookworm-slim

# 1. Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Python Vosk
RUN pip3 install vosk --break-system-packages

# 3. Download and extract the Vosk model to ROOT
RUN curl -L https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o vosk-model.zip \
    && unzip -q vosk-model.zip \
    && mv vosk-model-small-en-us-0.15 /vosk-model \
    && rm vosk-model.zip

# 4. Create app directory FIRST
WORKDIR /usr/src/app

# 5. Copy package files from build context
COPY package*.json ./

# 6. Install Node.js dependencies
RUN npm install --omit=dev

# 7. Copy the rest of the app
COPY . .

EXPOSE 10000
CMD ["node", "server.js"]
