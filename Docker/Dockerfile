FROM node:18-bookworm-slim

# Install everything
RUN apt-get update && apt-get install -y \
    python3 pipx ffmpeg curl unzip \
    && pipx install vosk \
    && curl -L https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o vosk-model.zip \
    && unzip -q vosk-model.zip \
    && mv vosk-model-small-en-us-0.15 /vosk-model \
    && rm vosk-model.zip

WORKDIR /app
COPY . .
RUN npm install --omit=dev

EXPOSE 10000
CMD ["node", "server.js"]
