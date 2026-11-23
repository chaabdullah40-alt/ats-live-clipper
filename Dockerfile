# ATS Live Clipper - Render (free) Docker image
# Vercel cannot cut videos: its serverless functions have no yt-dlp or ffmpeg
# and a 60s limit. Render free runs the same Node app as a real server with
# ffmpeg + yt-dlp installed, so Analyse AND cutting both work.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip fonts-dejavu-core fontconfig ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm", "start"]
