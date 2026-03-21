const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const mongoose = require("mongoose");
const axios = require("axios");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const MONGO_URL = process.env.MONGO_URL || "mongodb+srv://blvck_db_user:kt4kdnltgkbIUngs@cluster0.ofzc3yh.mongodb.net/?appName=Cluster0";
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://myfbbot2.onrender.com`; // Update with your actual URL

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

// MongoDB Schema for Baileys Session
const AuthSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    data: String
});
const Auth = mongoose.model("Auth", AuthSchema);

// MongoDB Schema for Settings
const SettingSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: String
});
const Setting = mongoose.model("Setting", SettingSchema);

// Custom Auth Provider for MongoDB
async function useMongoDBAuthState() {
    const writeData = async (data, id) => {
        const json = JSON.stringify(data);
        await Auth.findOneAndUpdate({ id }, { data: json }, { upsert: true });
    };

    const readData = async (id) => {
        const res = await Auth.findOne({ id });
        return res ? JSON.parse(res.data) : null;
    };

    const removeData = async (id) => {
        await Auth.deleteOne({ id });
    };

    let creds = await readData("creds");
    if (!creds) {
        creds = (await import("@whiskeysockets/baileys")).BufferJSON.reviveJSON(
            JSON.parse(JSON.stringify((await import("@whiskeysockets/baileys")).initAuthCreds()))
        );
        await writeData(creds, "creds");
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = (await import("@whiskeysockets/baileys")).proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            if (value) {
                                await writeData(value, `${type}-${id}`);
                            } else {
                                await removeData(`${type}-${id}`);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, "creds")
    };
}

async function startBot() {
    try {
        await mongoose.connect(MONGO_URL);
        addLog("Connected to MongoDB for Session Storage.");
    } catch (err) {
        addLog("MongoDB Connection Error: " + err.message);
        return;
    }

    const b = await import("@whiskeysockets/baileys");
    const makeWASocket = b.default || b;
    const { DisconnectReason, fetchLatestBaileysVersion } = b;

    const { state, saveCreds } = await useMongoDBAuthState();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!state.creds.registered) {
        let phoneNumber = process.env.PHONE_NUMBER || "233559871135";
        
        // Try to get phone number from database
        try {
            const storedPhone = await Setting.findOne({ key: "phoneNumber" });
            if (storedPhone) {
                phoneNumber = storedPhone.value;
                addLog(`Using stored phone number: ${phoneNumber}`);
            } else {
                addLog(`Using default phone number: ${phoneNumber}`);
            }
        } catch (e) {
            addLog("Error reading phone number from DB: " + e.message);
        }

        setTimeout(async () => {
            try {
                addLog(`Requesting pairing code for ${phoneNumber}...`);
                const code = await sock.requestPairingCode(phoneNumber);
                currentPairingCode = code;
                io.emit("pairing_code", code);
                addLog(`Pairing code generated for ${phoneNumber}: ${code}`);
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
            addLog("Bot is now ONLINE and permanent!");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (text.match(/https?:\/\/(www\.)?(facebook\.com|fb\.watch)/)) {
            const url = text.match(/https?:\/\/[^\s]+/)[0];
            addLog(`Link received: ${url}`);
            await sock.sendMessage(from, { text: "📥 Downloading video... using high-speed servers." });

            const fileName = `video_${Date.now()}.mp4`;
            const filePath = path.join(__dirname, fileName);
            const ytDlpPath = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            
            // WHATSAPP COMPATIBLE yt-dlp flags (H.264 + AAC + YUV420P)
            const command = `${ytDlpPath} -f "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best" --no-playlist --merge-output-format mp4 --postprocessor-args "ffmpeg:-vcodec libx264 -acodec aac -pix_fmt yuv420p" -o "${filePath}" "${url}"`;

            exec(command, async (error) => {
                if (error) {
                    addLog(`Error downloading: ${error.message}`);
                    await sock.sendMessage(from, { text: "❌ High-quality download failed. Trying low quality..." });
                    
                    // Fallback to simpler format if high-quality fails
                    const fallbackCmd = `${ytDlpPath} -f "mp4" --no-playlist -o "${filePath}" "${url}"`;
                    exec(fallbackCmd, async (e2) => {
                        if (e2) {
                             await sock.sendMessage(from, { text: "❌ Link invalid or private." });
                        } else {
                            handleSend();
                        }
                    });
                } else {
                    handleSend();
                }

                async function handleSend() {
                    if (fs.existsSync(filePath)) {
                        try {
                            const buffer = fs.readFileSync(filePath);
                            await sock.sendMessage(from, { video: buffer, caption: "✅ Here is your video!" });
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

    app.post("/api/reset", async (req, res) => {
        const { phoneNumber } = req.body;
        addLog("Reset requested from Dashboard...");
        try {
            await Auth.deleteMany({});
            if (phoneNumber) {
                await Setting.findOneAndUpdate({ key: "phoneNumber" }, { value: phoneNumber }, { upsert: true });
                addLog(`Phone number updated to ${phoneNumber}.`);
            }
            addLog("Database cleared. Bot will restart in 2 seconds.");
            res.status(200).send("Session reset.");
            setTimeout(() => process.exit(0), 2000); // Small delay to send response before exit
        } catch (err) {
            console.error(err);
            res.status(500).send("Error resetting session.");
        }
    });
}

// Self-pinger to prevent Render sleep
setInterval(() => {
    axios.get(RENDER_URL).then(() => addLog("Self-ping: Staying awake.")).catch(() => {});
}, 10 * 60 * 1000); // Every 10 minutes

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT}`);
    startBot();
});
