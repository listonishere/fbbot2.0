# Use Node.js LTS image
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of the application
COPY . .

# Environment variables
ENV PORT=10000
ENV NODE_ENV=production

# Expose port
EXPOSE 10000

# Start the bot
CMD ["node", "index.js"]

