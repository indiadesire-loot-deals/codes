FROM node:18-bookworm-slim

# 1. Show what's in the container for debugging
RUN echo "=== Debug: Container contents ===" && ls -la /

# 2. Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# 3. Install Python Vosk
RUN pip3 install vosk --break-system-packages

# 4. Download Vosk model
RUN curl -L https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o vosk-model.zip \
    && unzip -q vosk-model.zip \
    && mv vosk-model-small-en-us-0.15 /vosk-model \
    && rm vosk-model.zip

# 5. Set working directory
WORKDIR /app

# 6. Copy files - show what we're copying
COPY . /app/

# 7. Debug: Show what was copied
RUN echo "=== Debug: App directory contents ===" && ls -la /app

# 8. Install dependencies (skip if no package.json)
RUN if [ -f "package.json" ]; then \
      echo "Found package.json, installing dependencies..." && \
      npm install --omit=dev; \
    else \
      echo "WARNING: No package.json found, skipping npm install"; \
    fi

EXPOSE 10000
CMD ["node", "server.js"]
