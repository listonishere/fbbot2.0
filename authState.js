const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

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
    const settings = getLocalSettings();
    return settings[key] !== undefined ? settings[key] : defaultValue;
}

async function setSetting(key, value) {
    const settings = getLocalSettings();
    settings[key] = value;
    saveLocalSettings(settings);
}

async function clearAuths() {
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
    } catch (e) {
        console.error("Error clearing local auth directory:", e.message);
        throw e;
    }
}

async function getAuthState() {
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
