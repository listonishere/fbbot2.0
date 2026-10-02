const dns = require("dns");
try {
    dns.setDefaultResultOrder("ipv4first");
} catch (e) {}

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const { getAuthState, getSetting, setSetting, clearAuths } = require("./authState");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" }
});

app.use(express.static("public"));
app.use(express.json());

// Global Error Catchers
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection:", reason);
    addLog("Unhandled Rejection: " + (reason?.message || reason));
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
    addLog("Uncaught Exception: " + err.message);
});

// Port configuration
const PORT = process.env.PORT || 10000;

// Global state
let botStatus = "Offline";
let currentPairingCode = "";
let currentQrCode = "";
let recentLogs = [];
let socketInstance = null;

// Sequential 1-by-1 Queue
let downloadQueue = [];
let isProcessingQueue = false;
let queueItemCounter = 0;
const MAX_CONCURRENT_DOWNLOADS = 1; // Strict 1-by-1 sequential downloading

function addLog(message) {
    const log = { time: new Date().toLocaleTimeString(), message };
    recentLogs.unshift(log);
    if (recentLogs.length > 50) recentLogs.pop();
    io.emit("log_update", recentLogs);
    io.emit("queue_update", { length: downloadQueue.length, isProcessing: isProcessingQueue });
    console.log(`[${log.time}] ${message}`);
}

function extractTextFromMessage(msg) {
    if (!msg || !msg.message) return "";
    const m = msg.message;
    if (m.ephemeralMessage?.message) return extractTextFromMessage({ message: m.ephemeralMessage.message });
    if (m.viewOnceMessage?.message) return extractTextFromMessage({ message: m.viewOnceMessage.message });
    if (m.viewOnceMessageV2?.message) return extractTextFromMessage({ message: m.viewOnceMessageV2.message });
    if (m.documentWithCaptionMessage?.message) return extractTextFromMessage({ message: m.documentWithCaptionMessage.message });
    if (m.editedMessage?.message) return extractTextFromMessage({ message: m.editedMessage.message });

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        ""
    );
}

function cleanUrl(rawUrl) {
    if (!rawUrl) return "";
    return rawUrl.replace(/[.,!?;:)>"'\]]+$/, "").trim();
}

function extractAllUrls(text) {
    if (!text) return [];
    const matches = text.match(/https?:\/\/[^\s]+/g);
    if (!matches) return [];
    return matches.map(cleanUrl).filter((url) => url.length > 8);
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (downloadQueue.length > 0) {
        const item = downloadQueue.shift();
        const { id, from, url, quotedMsg, totalInBatch, batchIndex } = item;
        const remaining = downloadQueue.length;

        const startTime = Date.now();
        const batchInfo = totalInBatch > 1 ? ` [${batchIndex}/${totalInBatch}]` : "";
        addLog(`▶️ [Queue Item #${id}]${batchInfo} Starting download: ${url} (${remaining} remaining in queue)`);

        const fileName = `video_${Date.now()}_${id}.mp4`;
        const filePath = path.join(__dirname, fileName);
        const ytDlpPath = process.platform === "win32" ? ".\\yt-dlp.exe" : "yt-dlp";

        try {
            // Send starting message to user for this item
            if (socketInstance) {
                try {
                    await socketInstance.sendMessage(
                        from,
                        { text: `📥 Downloading link${batchInfo}...\n🔗 ${url}` },
                        { quoted: quotedMsg }
                    );
                } catch (e) {}
            }

            // High quality merged format with fallback
            const command = `${ytDlpPath} -f "bv*+ba/b" --merge-output-format mp4 --no-playlist --no-warnings -o "${filePath}" "${url}"`;

            await new Promise((resolve) => {
                exec(command, { maxBuffer: 1024 * 1024 * 20 }, async (error) => {
                    if (error) {
                        addLog(`Standard download failed for #${id} (${error.message}). Trying fallback format...`);
                        const fallbackCmd = `${ytDlpPath} -f "mp4/best" --no-playlist --no-warnings -o "${filePath}" "${url}"`;

                        exec(fallbackCmd, { maxBuffer: 1024 * 1024 * 20 }, async (err2) => {
                            if (err2) {
                                addLog(`Fallback download failed for #${id}: ${err2.message}`);
                                if (socketInstance) {
                                    try {
                                        await socketInstance.sendMessage(
                                            from,
                                            { text: `❌ Failed to download link${batchInfo}.\nLink may be private or unsupported: ${url}` },
                                            { quoted: quotedMsg }
                                        );
                                    } catch (e) {}
                                }
                            } else {
                                await sendVideoResult();
                            }
                            resolve();
                        });
                    } else {
                        await sendVideoResult();
                        resolve();
                    }

                    async function sendVideoResult() {
                        if (!fs.existsSync(filePath)) {
                            addLog(`File not found on disk for #${id}: ${filePath}`);
                            if (socketInstance) {
                                await socketInstance.sendMessage(
                                    from,
                                    { text: `❌ Download error: file was not generated for ${url}` },
                                    { quoted: quotedMsg }
                                );
                            }
                            return;
                        }

                        try {
                            const stats = fs.statSync(filePath);
                            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

                            addLog(`File downloaded for #${id}: ${fileSizeMB}MB in ${elapsed}s. Sending to chat...`);

                            const queueNote = remaining > 0 ? `\n⏳ ${remaining} item(s) left in queue.` : "";

                            if (stats.size > 100 * 1024 * 1024) {
                                await socketInstance.sendMessage(
                                    from,
                                    { text: `⚠️ Video (${fileSizeMB}MB) exceeds WhatsApp's 100MB file limit.${queueNote}` },
                                    { quoted: quotedMsg }
                                );
                            } else if (stats.size > 64 * 1024 * 1024) {
                                const videoBuffer = fs.readFileSync(filePath);
                                await socketInstance.sendMessage(
                                    from,
                                    {
                                        document: videoBuffer,
                                        mimetype: "video/mp4",
                                        fileName: `video_${id}.mp4`,
                                        caption: `✅ Video downloaded (${fileSizeMB}MB)${batchInfo}${queueNote}`
                                    },
                                    { quoted: quotedMsg }
                                );
                                addLog(`Video #${id} sent as document to ${from} (${elapsed}s)`);
                            } else {
                                const videoBuffer = fs.readFileSync(filePath);
                                await socketInstance.sendMessage(
                                    from,
                                    {
                                        video: videoBuffer,
                                        caption: `✅ Video downloaded successfully!${batchInfo}${queueNote}`,
                                        mimetype: "video/mp4"
                                    },
                                    { quoted: quotedMsg }
                                );
                                addLog(`Video #${id} sent to ${from} (${elapsed}s)`);
                            }
                        } catch (e) {
                            addLog(`Send error for #${id}: ${e.message}`);
                            if (socketInstance) {
                                try {
                                    await socketInstance.sendMessage(
                                        from,
                                        { text: `❌ Error sending video to chat: ${e.message}` },
                                        { quoted: quotedMsg }
                                    );
                                } catch (err) {}
                            }
                        }
                    }
                });
            });
        } catch (err) {
            addLog(`Queue item #${id} error: ${err.message}`);
        } finally {
            // Clean up files immediately after each download
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                const dirFiles = fs.readdirSync(__dirname);
                for (const f of dirFiles) {
                    if (f.startsWith(fileName) && f.endsWith(".part")) {
                        try { fs.unlinkSync(path.join(__dirname, f)); } catch (e) {}
                    }
                }
            } catch (e) {}

            addLog(`Completed #${id}. Remaining in queue: ${downloadQueue.length}`);
            // Small pause between downloads to preserve network stability
            await new Promise((r) => setTimeout(r, 1500));
        }
    }

    isProcessingQueue = false;
    addLog("🏁 Queue is empty. All downloads finished.");
}

async function startBot() {
    try {
        if (socketInstance) {
            socketInstance.ev.removeAllListeners("connection.update");
            socketInstance.ev.removeAllListeners("creds.update");
            socketInstance.ev.removeAllListeners("messages.upsert");
            try { socketInstance.end(); } catch (e) {}
            socketInstance = null;
        }

        addLog("Initializing Authentication State...");
        const { state, saveCreds } = await getAuthState();

        const baileysMod = await import("@whiskeysockets/baileys");
        const makeWASocket = baileysMod.makeWASocket || baileysMod.default?.makeWASocket || baileysMod.default;
        const { DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileysMod;

        const { version } = await fetchLatestBaileysVersion();
        addLog(`Baileys version: ${version.join(".")}`);

        socketInstance = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.ubuntu("Chrome"),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 15000,
            markOnlineOnConnect: true,
            syncFullHistory: false
        });

        if (!state.creds.registered) {
            botStatus = "Pairing";
            io.emit("status_update", botStatus);

            const savedPhone = await getSetting("phone_number", process.env.PHONE_NUMBER || "233559871135");
            const cleanPhone = String(savedPhone).replace(/[^0-9]/g, "");

            const requestPairing = async (retryCount = 0) => {
                if (botStatus === "Online" || state.creds.registered || !socketInstance) return;
                try {
                    addLog(`Requesting pairing code for +${cleanPhone}...`);
                    const code = await socketInstance.requestPairingCode(cleanPhone);
                    currentPairingCode = code;
                    io.emit("pairing_code", code);
                    addLog(`🔑 PAIRING CODE GENERATED: ${code}`);
                } catch (err) {
                    addLog("Pairing code error: " + err.message);
                    if (retryCount < 3) {
                        addLog("Retrying pairing code request in 8s...");
                        setTimeout(() => requestPairing(retryCount + 1), 8000);
                    }
                }
            };

            setTimeout(() => requestPairing(0), 6000);
        }

        socketInstance.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQrCode = qr;
                io.emit("qr_code", qr);
                addLog("QR Code generated for dashboard scanning");
            }

            if (connection === "close") {
                botStatus = "Offline";
                io.emit("status_update", botStatus);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                addLog(`Connection closed (Code: ${statusCode || "unknown"}). Reconnect: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    addLog("Device logged out. Resetting auth credentials for fresh pairing...");
                    await clearAuths();
                    setTimeout(startBot, 3000);
                } else if (shouldReconnect) {
                    setTimeout(() => {
                        addLog("Reconnecting to WhatsApp...");
                        startBot();
                    }, 5000);
                }
            } else if (connection === "open") {
                botStatus = "Online";
                currentPairingCode = "";
                currentQrCode = "";
                io.emit("pairing_code", "");
                io.emit("qr_code", "");
                io.emit("status_update", botStatus);
                addLog("🚀 WhatsApp Bot is now ONLINE and ready!");
            }
        });

        socketInstance.ev.on("creds.update", saveCreds);

        socketInstance.ev.on("messages.upsert", async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message) continue;

                const from = msg.key.remoteJid;
                if (!from || from === "status@broadcast") continue;

                const text = extractTextFromMessage(msg).trim();
                if (!text) continue;

                // Ignore automated status messages from the bot to avoid echo loops
                if (text.startsWith("📥") || text.startsWith("🕒") || text.startsWith("✅") || text.startsWith("❌") || text.startsWith("⚠️") || text.startsWith("▶️")) {
                    continue;
                }

                // Extract all URLs from the message (supports 1 link or 100 links in batch)
                const urls = extractAllUrls(text);
                if (urls.length === 0) continue;

                addLog(`Detected ${urls.length} link(s) from ${from}`);

                const totalInBatch = urls.length;
                urls.forEach((url, index) => {
                    queueItemCounter++;
                    downloadQueue.push({
                        id: queueItemCounter,
                        from,
                        url,
                        quotedMsg: msg,
                        totalInBatch,
                        batchIndex: index + 1
                    });
                });

                const totalQueued = downloadQueue.length;
                addLog(`Queued ${urls.length} link(s). Total queue size: ${totalQueued}`);

                // Send immediate queue acknowledgement to the user
                try {
                    if (urls.length === 1) {
                        if (!isProcessingQueue && totalQueued === 1) {
                            await socketInstance.sendMessage(
                                from,
                                { text: "📥 Link received! Starting download 1 by 1..." },
                                { quoted: msg }
                            );
                        } else {
                            await socketInstance.sendMessage(
                                from,
                                { text: `🕒 Link added to queue (Position #${totalQueued}). It will download 1 by 1.` },
                                { quoted: msg }
                            );
                        }
                    } else {
                        await socketInstance.sendMessage(
                            from,
                            { text: `📋 Queued ${urls.length} links! Downloading 1 by 1 sequentially. (Total queue: ${totalQueued})` },
                            { quoted: msg }
                        );
                    }
                } catch (e) {
                    addLog("Queue acknowledgement error: " + e.message);
                }

                // Trigger queue processing
                processQueue();
            }
        });

    } catch (error) {
        addLog("Bot Startup Error: " + error.message);
        console.error("Bot Startup Error:", error);
        setTimeout(startBot, 10000);
    }
}

io.on("connection", async (socket) => {
    const savedPhone = await getSetting("phone_number", process.env.PHONE_NUMBER || "233559871135");
    socket.emit("status_update", botStatus);
    socket.emit("pairing_code", currentPairingCode);
    socket.emit("qr_code", currentQrCode);
    socket.emit("phone_number", savedPhone);
    socket.emit("log_update", recentLogs);
    socket.emit("queue_update", { length: downloadQueue.length, isProcessing: isProcessingQueue });
});

app.get("/api/status", async (req, res) => {
    const savedPhone = await getSetting("phone_number", process.env.PHONE_NUMBER || "233559871135");
    res.json({
        status: botStatus,
        phoneNumber: savedPhone,
        pairingCode: currentPairingCode,
        queueLength: downloadQueue.length,
        isProcessingQueue,
        logs: recentLogs
    });
});

app.post("/api/reset", async (req, res) => {
    const { phoneNumber } = req.body;
    addLog(`Reset requested with new number: ${phoneNumber || "unspecified"}...`);
    try {
        if (phoneNumber) {
            const clean = String(phoneNumber).replace(/[^0-9]/g, "");
            await setSetting("phone_number", clean);
        }
        await clearAuths();
        addLog("Old credentials cleared. Starting fresh pairing session...");
        res.status(200).json({ success: true, message: "Session reset successfully." });

        startBot();
    } catch (err) {
        addLog("Reset error: " + (err ? err.message : err));
        res.status(500).json({ success: false, error: "Error resetting session." });
    }
});

app.post("/api/restart", async (req, res) => {
    addLog("Manual restart requested...");
    startBot();
    res.json({ success: true, message: "Restarting bot..." });
});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`=========================================`);
    console.log(`🌐 Local Web Server running on port ${PORT}`);
    console.log(`📱 Dashboard: http://localhost:${PORT}`);
    console.log(`=========================================`);
    startBot();
});
