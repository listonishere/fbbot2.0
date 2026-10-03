const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

function isMongoConfigured() {
    return Boolean(process.env.MONGO_URL && process.env.MONGO_URL.trim() !== '');
}

function getLocalSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Error reading settings.json:", e.message);
    }
    return {};
}

function saveLocalSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) {
        console.error("Error writing settings.json:", e.message);
    }
}

async function getSetting(key, defaultValue) {
    if (isMongoConfigured()) {
        try {
            const { getSetting: getMongoSetting } = require('./mongoState');
            return await getMongoSetting(key, defaultValue);
        } catch (e) {
            console.warn("Mongo getSetting fallback to local:", e.message);
        }
    }
    const settings = getLocalSettings();
    return settings[key] !== undefined ? settings[key] : defaultValue;
}

async function setSetting(key, value) {
    if (isMongoConfigured()) {
        try {
            const { setSetting: setMongoSetting } = require('./mongoState');
            return await setMongoSetting(key, value);
        } catch (e) {
            console.warn("Mongo setSetting fallback to local:", e.message);
        }
    }
    const settings = getLocalSettings();
    settings[key] = value;
    saveLocalSettings(settings);
}

async function clearAuths() {
    if (isMongoConfigured()) {
        try {
            const { clearAuths: clearMongoAuths } = require('./mongoState');
            await clearMongoAuths();
        } catch (e) {
            console.warn("Mongo clearAuths error:", e.message);
        }
    }
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
    } catch (e) {
        console.error("Error clearing local auth directory:", e.message);
    }
}

async function getAuthState() {
    if (isMongoConfigured()) {
        try {
            console.log("Connecting to MongoDB Auth State...");
            const { useMongoDBAuthState } = require('./mongoState');
            return await useMongoDBAuthState(process.env.MONGO_URL);
        } catch (e) {
            console.error("MongoDB Auth State failed, falling back to local multi-file auth:", e.message);
        }
    }

    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
    return await useMultiFileAuthState(AUTH_DIR);
}

module.exports = {
    getAuthState,
    getSetting,
    setSetting,
    clearAuths,
    AUTH_DIR
};
