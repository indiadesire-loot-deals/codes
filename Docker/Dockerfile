# Dockerfile - WITH VIRTUAL ENVIRONMENT
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

# 2. Create and activate virtual environment, install Vosk
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install vosk

# 3. Download Vosk model
RUN curl -L https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o vosk-model.zip \
    && unzip -q vosk-model.zip \
    && mv vosk-model-small-en-us-0.15 vosk-model \
    && rm vosk-model.zip

# 4. Set up Node.js app
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .

# 5. Make Python Vosk available system-wide
ENV PATH="/opt/venv/bin:$PATH"
ENV VIRTUAL_ENV="/opt/venv"

EXPOSE 10000
CMD ["node", "server.js"]
