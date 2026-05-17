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

// Global state
let botStatus = "Offline";
let currentPairingCode = "";
let recentLogs = [];
let socketInstance = null;
let downloadQueue = [];
let isProcessingQueue = false;

// Keep the process alive
setInterval(() => {}, 1000 * 60 * 60); 

function addLog(message) {
    const log = { time: new Date().toLocaleTimeString(), message };
    recentLogs.unshift(log);
    if (recentLogs.length >= 20) recentLogs.pop();
    io.emit("log_update", recentLogs);
    console.log(`[${log.time}] ${message}`);
}

async function processQueue() {
    if (isProcessingQueue || downloadQueue.length === 0) return;
    isProcessingQueue = true;

    while (downloadQueue.length > 0) {
        const { from, url } = downloadQueue.shift();
        addLog(`Processing queued link: ${url}`);
        
        try {
            await socketInstance.sendMessage(from, { text: "📥 Currently downloading your video... (Queued)" });

            const fileName = `video_${Date.now()}.mp4`;
            const filePath = path.join(__dirname, fileName);
            const ytDlpPath = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            
            const command = `${ytDlpPath} -f "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best" --no-playlist --merge-output-format mp4 --postprocessor-args "ffmpeg:-vcodec libx264 -acodec aac -pix_fmt yuv420p" -o "${filePath}" "${url}"`;

            await new Promise((resolve) => {
                exec(command, async (error) => {
                    if (error) {
                        addLog(`Download error: ${error.message}`);
                        const fallbackCmd = `${ytDlpPath} -f "mp4" --no-playlist -o "${filePath}" "${url}"`;
                        exec(fallbackCmd, async (e2) => {
                            if (e2) {
                                await socketInstance.sendMessage(from, { text: "❌ Failed to download. Link might be private or invalid." });
                            } else {
                                await sendVideo();
                            }
                            resolve();
                        });
                    } else {
                        await sendVideo();
                        resolve();
                    }

                    async function sendVideo() {
                        if (fs.existsSync(filePath)) {
                            try {
                                const stream = fs.createReadStream(filePath);
                                await socketInstance.sendMessage(from, { 
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
            });
        } catch (err) {
            addLog("Queue processing error: " + err.message);
        }
        
        // Brief pause between downloads to prevent resource spikes
        await new Promise(r => setTimeout(r, 2000));
    }

    isProcessingQueue = false;
}

async function startBot() {
    try {
        // Cleanup existing instance if any
        if (socketInstance) {
            socketInstance.ev.removeAllListeners('connection.update');
            socketInstance.ev.removeAllListeners('creds.update');
            socketInstance.ev.removeAllListeners('messages.upsert');
            try { socketInstance.end(); } catch (e) {}
        }

        const { state, saveCreds } = await useMongoDBAuthState(MONGO_URL);
        
        const b = await import('@whiskeysockets/baileys');
        const baileysMod = (b.default && (b.default.initAuthCreds || b.default.initCreds)) ? b.default : b;
        
        const makeWASocket = baileysMod.makeWASocket || baileysMod.default || baileysMod;
        const { DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileysMod;

        const { version } = await fetchLatestBaileysVersion();

        socketInstance = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        });

        if (!state.creds.registered) {
            const PHONE_NUMBER = await getSetting("phone_number", process.env.PHONE_NUMBER || "233559871135");
            
            // Wait for connection to be active before requesting code
            const requestPairing = async () => {
                if (botStatus === "Online" || state.creds.registered) return;
                try {
                    addLog(`Requesting pairing code for ${PHONE_NUMBER}...`);
                    const code = await socketInstance.requestPairingCode(PHONE_NUMBER);
                    currentPairingCode = code;
                    io.emit("pairing_code", code);
                    addLog(`Pairing code generated: ${code}`);
                } catch (err) {
                    addLog("Pairing error: " + err.message);
                    if (err.message.includes('Closed')) {
                        addLog("Retrying pairing code request in 10s...");
                        setTimeout(requestPairing, 10000);
                    }
                }
            };
            
            setTimeout(requestPairing, 10000);
        }

        socketInstance.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            console.log("Connection update:", update); // Added log
            if (connection === 'close') {
                botStatus = "Offline";
                io.emit("status_update", botStatus);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                addLog(`Connection closed. Reason: ${statusCode || 'unknown'}. Reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(() => {
                        addLog("Attempting reconnection...");
                        startBot();
                    }, 5000);
                }
            } else if (connection === 'open') {
                botStatus = "Online";
                currentPairingCode = "";
                io.emit("pairing_code", "");
                io.emit("status_update", botStatus);
                addLog("Bot is now ONLINE!");
            }
        });

        socketInstance.ev.on('creds.update', saveCreds);

        socketInstance.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            
            const from = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
            
            if (text.match(/https?:\/\/(www\.)?(facebook\.com|fb\.watch|fb\.com)/)) {
                const urlMatch = text.match(/https?:\/\/[^\s]+/);
                if (!urlMatch) return;
                const url = urlMatch[0];
                
                downloadQueue.push({ from, url });
                addLog(`Link added to queue: ${url} (Queue size: ${downloadQueue.length})`);
                
                if (downloadQueue.length > 1) {
                    await socketInstance.sendMessage(from, { text: `🕒 Link added to queue. Position: ${downloadQueue.length}. Please wait.` });
                }
                
                processQueue();
            }
        });

    } catch (error) {
        addLog("Fatal Bot Error: " + error.message);
        console.error("Fatal Bot Error:", error);
        setTimeout(startBot, 10000);
    }
}

io.on("connection", (socket) => {
    socket.emit("status_update", botStatus);
    socket.emit("pairing_code", currentPairingCode);
    socket.emit("log_update", recentLogs);
});


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
        
        // Instead of exiting, we just trigger a restart of the bot
        startBot();
    } catch (err) {
        res.status(500).send("Error resetting session.");
    }
});

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startBot();
});

