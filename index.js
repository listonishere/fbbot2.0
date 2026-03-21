const http = require("http");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

// Simple health check server for cloud hosting (Render, Koyeb, etc.)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => {
    console.log(`Health check server running on port ${process.env.PORT || 8080}`);
});

async function startBot() {
    // Dynamic import for Baileys (ESM)
    const b = await import("@whiskeysockets/baileys");
    
    const makeWASocket = b.default || b;
    const useMultiFileAuthState = b.useMultiFileAuthState || (b.default && b.default.useMultiFileAuthState);
    const DisconnectReason = b.DisconnectReason || (b.default && b.default.DisconnectReason);
    const fetchLatestBaileysVersion = b.fetchLatestBaileysVersion || (b.default && b.default.fetchLatestBaileysVersion);

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

    // Prompt for phone number if not registered
    if (!state.creds.registered) {
        const phoneNumber = "233559871135";
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n\n========================================`);
                console.log(`PAIRING CODE: ${code}`);
                console.log(`========================================\n\n`);
            } catch (err) {
                console.error("Error requesting pairing code:", err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Bot is online!');
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

            await sock.sendMessage(from, { text: "Downloading video... please wait." });

            const fileName = `video_${Date.now()}.mp4`;
            const filePath = path.join(__dirname, fileName);
            
            // Dynamic yt-dlp path: local .exe for Windows, global command for Linux/Docker
            const ytDlpPath = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            const command = `${ytDlpPath} -o "${filePath}" "${url}"`;

            exec(command, async (error, stdout, stderr) => {
                if (error) {
                    console.error(`exec error: ${error}`);
                    await sock.sendMessage(from, { text: "Error downloading video. Link may be private or invalid." });
                    return;
                }

                if (fs.existsSync(filePath)) {
                    try {
                        const buffer = fs.readFileSync(filePath);
                        await sock.sendMessage(from, { video: buffer, caption: "Here is your video!" });
                        fs.unlinkSync(filePath);
                    } catch (sendError) {
                        console.error('Error sending video:', sendError);
                        await sock.sendMessage(from, { text: "Error sending the video back to you." });
                    }
                } else {
                    await sock.sendMessage(from, { text: "Could not find the downloaded file." });
                }
            });
        }
    });
}

startBot();
