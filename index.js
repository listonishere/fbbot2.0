const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));
app.use(express.json());

const PORT = process.env.PORT || 8080;
let botStatus = "Offline";
let currentPairingCode = "";
let recentLogs = [];

function addLog(message) {
    const log = { time: new Date().toLocaleTimeString(), message };
    recentLogs.unshift(log);
    if (recentLogs.length > 20) recentLogs.pop();
    io.emit("log_update", recentLogs);
}

async function startBot() {
    const b = await import("@whiskeysockets/baileys");
    const makeWASocket = b.default || b;
    const { 
        useMultiFileAuthState, 
        DisconnectReason, 
        fetchLatestBaileysVersion, 
        makeInMemoryStore 
    } = b;

    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!state.creds.registered) {
        const phoneNumber = process.env.PHONE_NUMBER || "233559871135";
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                currentPairingCode = code;
                io.emit("pairing_code", code);
                addLog(`Pairing code generated for ${phoneNumber}: ${code}`);
            } catch (err) {
                console.error("Error requesting pairing code:", err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            botStatus = "Offline";
            io.emit("status_update", botStatus);
            addLog("Connection closed. Reconnecting...");
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            botStatus = "Online";
            currentPairingCode = "";
            io.emit("status_update", botStatus);
            io.emit("pairing_code", "");
            addLog("Bot is Online!");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (text.includes('facebook.com') || text.includes('fb.watch')) {
            const urlMatch = text.match(/https?:\/\/[^\s]+/);
            if (!urlMatch) return;
            const url = urlMatch[0];

            addLog(`Received link from ${from}: ${url}`);
            await sock.sendMessage(from, { text: "Downloading video... please wait." });

            const fileName = `video_${Date.now()}.mp4`;
            const filePath = path.join(__dirname, fileName);
            const ytDlpPath = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            const command = `${ytDlpPath} -o "${filePath}" "${url}"`;

            exec(command, async (error) => {
                if (error) {
                    addLog(`Download error for ${url}`);
                    await sock.sendMessage(from, { text: "Error downloading video." });
                    return;
                }

                if (fs.existsSync(filePath)) {
                    try {
                        const buffer = fs.readFileSync(filePath);
                        await sock.sendMessage(from, { video: buffer, caption: "Here is your video!" });
                        addLog(`Successfully sent video to ${from}`);
                        fs.unlinkSync(filePath);
                    } catch (sendError) {
                        addLog(`Send error for ${from}`);
                        await sock.sendMessage(from, { text: "Error sending the video." });
                    }
                }
            });
        }
    });

    // Socket.io listeners
    io.on("connection", (socket) => {
        socket.emit("status_update", botStatus);
        socket.emit("pairing_code", currentPairingCode);
        socket.emit("log_update", recentLogs);
    });

    // API Endpoints
    app.post("/api/reset", (req, res) => {
        addLog("Reset requested from Dashboard...");
        try {
            // Delete auth folder (Caution: synchronous for simplicity)
            if (fs.existsSync('auth_info_baileys')) {
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                addLog("Auth folder deleted. Bot will restart.");
                res.status(200).send("Session reset. Bot will logout.");
                process.exit(0); // Let the process manager (Render PM2/Docker) restart it
            } else {
                res.status(404).send("No session found.");
            }
        } catch (err) {
            console.error(err);
            res.status(500).send("Error resetting session.");
        }
    });
}

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startBot();
});
