const mongoose = require('mongoose');
const dns = require('dns');
try {
    dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const AuthSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    data: { type: String, required: true }
});

const AuthModel = mongoose.model('Auth', AuthSchema);

const SettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: String, required: true }
});

const SettingModel = mongoose.model('Setting', SettingSchema);

async function useMongoDBAuthState(mongoUrl) {
    if (mongoose.connection.readyState === 0) {
        try {
            await mongoose.connect(mongoUrl);
            console.log("Connected to MongoDB");
        } catch (err) {
            console.error("MongoDB connection error (retrying with DNS fallback):", err.message);
            try {
                dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
                await mongoose.connect(mongoUrl);
                console.log("Connected to MongoDB using DNS fallback");
            } catch (retryErr) {
                console.error("MongoDB connection fallback error:", retryErr);
                throw retryErr;
            }
        }
    }

    const readData = async (id) => {
        try {
            const data = await AuthModel.findOne({ id });
            if (data) {
                return JSON.parse(data.data, (key, value) => {
                    if (value && typeof value === 'object' && value.type === 'Buffer') {
                        return Buffer.from(value.data);
                    }
                    return value;
                });
            }
        } catch (error) {
            return null;
        }
        return null;
    };

    const writeData = async (data, id) => {
        const json = JSON.stringify(data, (key, value) => {
            if (Buffer.isBuffer(value)) {
                return { type: 'Buffer', data: value.toString('base64') };
            }
            return value;
        });
        await AuthModel.findOneAndUpdate(
            { id },
            { data: json },
            { upsert: true }
        );
    };

    const removeData = async (id) => {
        await AuthModel.deleteOne({ id });
    };

    const { state, saveCreds } = await (async () => {
        const b = await import('@whiskeysockets/baileys');
        
        // Find initAuthCreds (it was renamed from initCreds in newer versions)
        let initAuthCreds = b.initAuthCreds || b.initCreds;
        let baileysMod = b;

        if (!initAuthCreds && b.default) {
            initAuthCreds = b.default.initAuthCreds || b.default.initCreds;
            baileysMod = b.default;
        }

        if (typeof initAuthCreds !== 'function') {
            const keys = Object.keys(b).join(', ');
            const defaultKeys = b.default ? Object.keys(b.default).join(', ') : 'none';
            throw new Error(`initAuthCreds not found. Module keys: [${keys}], Default keys: [${defaultKeys}]`);
        }

        const creds = await readData('creds') || initAuthCreds();
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
                                    // Use the resolved module to access proto
                                    const proto = b.proto || (b.default && b.default.proto);
                                    if (proto) {
                                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                                    }
                                }
                                data[id] = value;
                            })
                        );
                        return data;
                    },
                    set: async (data) => {
                        const tasks = [];
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id];
                                const key = `${category}-${id}`;
                                if (value) {
                                    tasks.push(writeData(value, key));
                                } else {
                                    tasks.push(removeData(key));
                                }
                            }
                        }
                        await Promise.all(tasks);
                    }
                }
            },
            saveCreds: async () => {
                await writeData(creds, 'creds');
            }
        };
    })();

    return { state, saveCreds };
}

async function getSetting(key, defaultValue) {
    const setting = await SettingModel.findOne({ key });
    return setting ? setting.value : defaultValue;
}

async function setSetting(key, value) {
    await SettingModel.findOneAndUpdate({ key }, { value }, { upsert: true });
}

async function clearAuths() {
    try {
        if (mongoose.connection.readyState !== 1) {
            const MONGO_URL = process.env.MONGO_URL;
            if (MONGO_URL) {
                try {
                    await mongoose.connect(MONGO_URL);
                } catch (e) {
                    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
                    await mongoose.connect(MONGO_URL);
                }
            }
        }
        await AuthModel.deleteMany({});
    } catch (e) {
        console.error("Error clearing auths:", e);
        throw e;
    }
}

module.exports = { useMongoDBAuthState, getSetting, setSetting, clearAuths };
