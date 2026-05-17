const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const axios = require("axios");
const { useMongoDBAuthState, getSetting, setSetting } = require("./mongoState");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));
app.use(express.json());

// Global Error Catchers
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    addLog("Unhandled Rejection: " + reason);
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
    addLog("Uncaught Exception: " + err.message);
});

// Port configuration for Railway/Render
const PORT = process.env.PORT || 10000;
const MONGO_URL = process.env.MONGO_URL || "mongodb+srv://blvck_db_user:kt4kdnltgkbIUngs@cluster0.ofzc3yh.mongodb.net/?appName=Cluster0";

let botStatus = "Offline";
let currentPairingCode = "";
let recentLogs = [];

function addLog(message) {
    const log = { time: new Date().toLocaleTimeString(), message };
    recentLogs.unshift(log);
    if (recentLogs.length >= 20) recentLogs.pop();
    io.emit("log_update", recentLogs);
    console.log(`[${log.time}] ${message}`);
}

async function startBot() {
    try {
        addLog("Connecting to MongoDB for session storage...");
        const { state, saveCreds } = await useMongoDBAuthState(MONGO_URL);
        
        const b = await import("@whiskeysockets/baileys");
        const makeWASocket = b.default || b;
        const { DisconnectReason, fetchLatestBaileysVersion } = b;

        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        if (!state.creds.registered) {
            const PHONE_NUMBER = await getSetting("phone_number", process.env.PHONE_NUMBER || "233559871135");
            addLog(`Requesting pairing code for ${PHONE_NUMBER}...`);
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    currentPairingCode = code;
                    io.emit("pairing_code", code);
                    addLog(`Pairing code generated: ${code}`);
                } catch (err) {
                    addLog("Pairing error: " + err.message);
                }
            }, 5000);
        }

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                botStatus = "Offline";
                io.emit("status_update", botStatus);
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    addLog("Reconnecting...");
                    startBot();
                }
            } else if (connection === 'open') {
                botStatus = "Online";
                io.emit("status_update", botStatus);
                addLog("Bot is now ONLINE!");
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            
            const from = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
            
            if (text.match(/https?:\/\/(www\.)?(facebook\.com|fb\.watch|fb\.com)/)) {
                const urlMatch = text.match(/https?:\/\/[^\s]+/);
                if (!urlMatch) return;
                const url = urlMatch[0];
                addLog(`Processing link: ${url}`);
                await sock.sendMessage(from, { text: "📥 Downloading video... please wait." });

                const fileName = `video_${Date.now()}.mp4`;
                const filePath = path.join(__dirname, fileName);
                const ytDlpPath = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
                
                const command = `${ytDlpPath} -f "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best" --no-playlist --merge-output-format mp4 --postprocessor-args "ffmpeg:-vcodec libx264 -acodec aac -pix_fmt yuv420p" -o "${filePath}" "${url}"`;

                exec(command, async (error) => {
                    if (error) {
                        addLog(`Download error: ${error.message}`);
                        const fallbackCmd = `${ytDlpPath} -f "mp4" --no-playlist -o "${filePath}" "${url}"`;
                        exec(fallbackCmd, async (e2) => {
                            if (e2) {
                                await sock.sendMessage(from, { text: "❌ Failed to download. Link might be private or invalid." });
                            } else {
                                await sendVideo();
                            }
                        });
                    } else {
                        await sendVideo();
                    }

                    async function sendVideo() {
                        if (fs.existsSync(filePath)) {
                            try {
                                // Efficiently send video using stream
                                const stream = fs.createReadStream(filePath);
                                await sock.sendMessage(from, { 
                                    video: { stream }, 
                                    caption: "✅ Video downloaded successfully!",
                                    mimetype: 'video/mp4'
                                });
                                addLog(`Video sent to ${from}`);
                                fs.unlinkSync(filePath);
                            } catch (e) {
                                addLog("Send error: " + e.message);
                            }
                        }
                    }
                });
            }
        });

        io.on("connection", (socket) => {
            socket.emit("status_update", botStatus);
            socket.emit("pairing_code", currentPairingCode);
            socket.emit("log_update", recentLogs);
        });
    } catch (error) {
        addLog("Fatal Bot Error: " + error.message);
        console.error("Fatal Bot Error:", error);
    }
}

app.post("/api/reset", async (req, res) => {
    const { phoneNumber } = req.body;
    addLog(`Reset requested for ${phoneNumber || "current session"}...`);
    try {
        if (phoneNumber) {
            await setSetting("phone_number", phoneNumber);
        }
        const mongoose = require('mongoose');
        await mongoose.connection.db.dropCollection('auths').catch(() => {});
        addLog("Session cleared. Restarting...");
        res.status(200).send("Session reset.");
        setTimeout(() => process.exit(0), 2000);
    } catch (err) {
        res.status(500).send("Error resetting session.");
    }
});

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startBot();
});

