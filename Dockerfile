FROM node:18-bookworm-slim

# 1. Install Python, pip, ffmpeg, and basic tools
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Python Vosk (no compilation needed)
RUN pip3 install vosk

# 3. Download the Vosk model
RUN curl -L https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o vosk-model.zip \
    && unzip -q vosk-model.zip \
    && mv vosk-model-small-en-us-0.15 vosk-model \
    && rm vosk-model.zip

# 4. Set up Node.js app
WORKDIR /usr/src/app

# Copy package files first for better caching
COPY package*.json ./

# 5. Install Node.js dependencies (EXCLUDING 'vosk')
RUN npm install --production

# Copy the rest of your app
COPY . .

# Expose your port
EXPOSE 10000

# Start command
CMD [ "node", "server.js" ]
