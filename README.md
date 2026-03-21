# Anti-Bo (WhatsApp Bot)

A powerful, high-performance WhatsApp bot built with Node.js, Baileys, and Express. It features a real-time web dashboard for easy pairing and session management, and uses `yt-dlp` for lightning-fast video downloads from Facebook and other platforms.

## Features

- **Real-time Dashboard**: Monitor bot status, view live logs, and pair with a new number via an 8-character code.
- **Persistent Sessions**: Your login status is stored securely in MongoDB, so you don't have to re-pair every time the server restarts.
- **High-Speed Downloads**: Automatically detects Facebook/FB Watch links and downloads high-quality videos using optimized server-side processing.
- **Self-Healing**: Automatically reconnects if disconnected or if the server sleeps (optimized for Render/Koyeb).

## How It Works

1.  **Connection**: The bot uses `@whiskeysockets/baileys` to connect to WhatsApp. If not registered, it requests a pairing code using the phone number provided in the dashboard.
2.  **Dashboard**: The `public/index.html` page communicates with the server via `Socket.io` to show real-time logs and the pairing status.
3.  **Media Processing**: When a video link is received, the bot executes `yt-dlp` to download and convert the video into a WhatsApp-compatible format (H.264 + AAC).
4.  **Database**: MongoDB stores both the Baileys authentication data and the user-defined phone number settings.

## Setup & Configuration

### Environment Variables
- `MONGO_URL`: Your MongoDB connection string.
- `PHONE_NUMBER`: Default phone number for pairing (can be overridden in the dashboard).
- `PORT`: Port for the web dashboard (default: 8080).
- `RENDER_EXTERNAL_URL`: (Optional) Your bot's public URL for self-pinging.

### Installation
```bash
npm install
node index.js
```

---

## Author

**Jason Fosu Birikorang**

## License

© 2026 Jason Fosu Birikorang. All Rights Reserved.
Unauthorized copying, modification, or distribution of this software is strictly prohibited.
