import './settings.js';
import fs from 'fs';
import fsExtra from 'fs-extra';
import os from 'os';
import dns from 'dns';
import pino from 'pino';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import cron from 'node-cron';
import readline from 'readline';
import { toBuffer } from 'qrcode';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import NodeCache from 'node-cache';
import { createRequire } from 'module';
import moment from 'moment-timezone';
import { parsePhoneNumber } from 'awesome-phonenumber';
import WAConnection, { useMultiFileAuthState, Browsers, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestWaWebVersion, jidNormalizedUser } from 'baileys';

import { app, server, PORT } from './src/server.js';
import { dataBase, cmdDel, checkStatus } from './src/database.js';
import { assertInstalled, customHttpsAgent } from './lib/function.js';
import { GroupParticipantsUpdate, MessagesUpsert, Solving } from './src/message.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Nonaktifkan semua log awal
const print = () => {};
const pairingCode = process.argv.includes('--qr') ? false : process.argv.includes('--pairing-code') || global.pairing_code;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));
const tempDir = path.join(__dirname, 'database/temp');
const time_now = new Date();
const time_end = 60000 - (time_now.getSeconds() * 1000 + time_now.getMilliseconds());
let pairingStarted = false;
let pairingTimeout = null;
let sholatTimeout = null;
let phoneNumber;
let reconnectAttempts = 0;

// Simpan referensi instance aktif untuk ditutup sebelum reconnect
let activeNazeInstance = null;
let isRestarting = false;
let restartTimeout = null;
let latestQr = null;

// Owner number fix
const ownerNumber = global.owner || [];

// QR Route - dipasang sekali di luar event connection.update
app.get('/qr', async (req, res) => {
    if (!latestQr) {
        return res.send('QR belum tersedia');
    }
    res.setHeader('content-type', 'image/png');
    res.end(await toBuffer(latestQr));
});

try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {}

// Fetch Api dengan timeout
global.fetchApi = async (endpoint = '/', data = {}, options = {}) => {
    return new Promise(async (resolve, reject) => {
        try {
            const apiList = Object.keys(global.APIs);
            if (options.api !== undefined) {
                if (typeof options.api !== 'number' || options.api < 1 || options.api > apiList.length) {
                    return reject(new Error(`[Fetch Error] Parameter { api: ${options.api} } tidak terdaftar. Harap gunakan angka 1 hingga ${apiList.length}.`));
                }
            }
            const apiName = typeof options.api === 'number' ? apiList[options.api - 1] : options.name;
            const base = apiName ? (global.APIs[apiName] || apiName) : global.APIs.naze;
            const apikey = global.APIKeys[base] || '';
            let method = (options.method || 'GET').toUpperCase();
            let url = base + endpoint;
            let payload = null;
            let headers = options.headers || { 'user-agent': 'Mozilla/5.0 (Linux; Android 15)' };
            const isForm = options.form || data instanceof FormData || (data && typeof data.getHeaders === 'function');
            if (isForm) {
                payload = data;
                method = 'POST';
                headers = { ...(options.headers?.['Authorization'] ? {} : { apikey }), ...headers, ...data.getHeaders() };
            } else if (method !== 'GET') {
                payload = { ...data, ...(options.headers?.['Authorization'] ? {} : { apikey }) };
                headers['content-type'] = 'application/json';
            } else {
                url += '?' + new URLSearchParams({ ...data, apikey }).toString();
            }
            const res = await axios({
                method, url, data: payload,
                headers, httpsAgent: customHttpsAgent,
                timeout: 60000,
                responseType: options.stream ? 'stream' : (options.buffer ? 'arraybuffer' : options.responseType || options.type || 'json'),
            });
            if (options.stream) {
                let ext = options.ext;
                if (typeof options.stream !== 'string' && !ext) {
                    const contentDisp = res.headers['content-disposition'];
                    const contentType = res.headers['content-type'];
                    if (contentDisp && contentDisp.includes('filename=')) {
                        const match = contentDisp.match(/filename="?([^"]+)"?/);
                        if (match && match[1]) ext = match[1].split('.').pop();
                    }
                    if (!ext && contentType) {
                        ext = contentType.split('/')[1]?.split(';')[0];
                        if (ext === 'jpeg') ext = 'jpg';
                    }
                    ext = ext || 'tmp';
                }
                let streamPath = typeof options.stream === 'string' ? options.stream : path.join(process.cwd(), 'database/temp', 'temp-' + Date.now() + '.' + ext);
                const writeStream = fs.createWriteStream(streamPath);
                writeStream.on('error', (err) => {
                    fs.unlink(streamPath, () => {});
                    reject(err);
                });
                res.data.pipe(writeStream);
                writeStream.on('finish', () => resolve(streamPath));
                writeStream.on('error', reject);
            } else {
                resolve(options.buffer ? Buffer.from(res.data) : res.data);
            }
        } catch (e) {
            reject(e);
        }
    });
};

const storeDB = dataBase(global.tempatStore);
const database = dataBase(global.tempatDB);
const msgRetryCounterCache = new NodeCache({
    stdTTL: 60,
    checkperiod: 120,
    useClones: false
});

if (fs.existsSync(tempDir)) {
    fs.readdirSync(tempDir).forEach(file => {
        fs.unlinkSync(path.join(tempDir, file));
    });
} else {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Temp cleaner setiap 30 menit
setInterval(() => {
    try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
            const loc = path.join(tempDir, file);
            const stat = fs.statSync(loc);
            if (Date.now() - stat.mtimeMs > 3600000) {
                fs.unlinkSync(loc);
            }
        }
    } catch {}
}, 30 * 60 * 1000);

assertInstalled(process.platform === 'win32' ? 'where ffmpeg' : 'command -v ffmpeg', 'FFmpeg', 0);
if (!server.listening && !server._handle) {
    server.listen(PORT, () => {});
}

// ================== CLEANUP FUNCTION ==================
const cleanup = async (reason = 'unknown') => {
    try {
        console.log(chalk.yellow(`[CLEANUP] ${reason}`));

        // clear interval
        if (global._dbInterval) {
            clearInterval(global._dbInterval);
            global._dbInterval = null;
        }

        if (global._dbPresence) {
            clearInterval(global._dbPresence);
            global._dbPresence = null;
        }

        if (global.intervalSholat) {
            clearInterval(global.intervalSholat);
            global.intervalSholat = null;
        }

        if (global._memoryCleaner) {
            clearInterval(global._memoryCleaner);
            global._memoryCleaner = null;
        }

        if (global._presenceCleaner) {
            clearInterval(global._presenceCleaner);
            global._presenceCleaner = null;
        }

        if (global._groupMetadataCleaner) {
            clearInterval(global._groupMetadataCleaner);
            global._groupMetadataCleaner = null;
        }

        if (global._cronReset) {
            global._cronReset.stop();
            global._cronReset = null;
        }

        if (restartTimeout) {
            clearTimeout(restartTimeout);
            restartTimeout = null;
        }

        if (pairingTimeout) {
            clearTimeout(pairingTimeout);
            pairingTimeout = null;
        }

        if (sholatTimeout) {
            clearTimeout(sholatTimeout);
            sholatTimeout = null;
        }

        // clear messageMap
        if (global.messageMap) {
            global.messageMap.clear();
        }

        // save db
        if (global.db) {
            await database.write(global.db).catch(() => {});
        }

        if (global.store) {
            await storeDB.write(global.store).catch(() => {});
        }

        // close socket
        if (activeNazeInstance) {
            try {
                activeNazeInstance.ev.removeAllListeners();
                if (activeNazeInstance.ws) {
                    activeNazeInstance.ws.close();
                }
                if (typeof activeNazeInstance.end === 'function') {
                    activeNazeInstance.end();
                }
            } catch (e) {}
            activeNazeInstance = null;
        }
    } catch (e) {
        console.error('[CLEANUP ERROR]', e);
    }
};

// ================== RESTART FUNCTION dengan exponential backoff ==================
async function restartBot(reason = 'unknown', customDelay = null) {
    if (isRestarting) return;
    
    if (reconnectAttempts > 15) {
        console.log(chalk.red('Too many reconnect attempts, exiting...'));
        process.exit(1);
    }
    
    isRestarting = true;
    
    if (customDelay === null) {
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), 60000);
        console.log(chalk.yellow(`[RESTART] ${reason} (attempt ${reconnectAttempts}, delay ${delay}ms)`));
        
        if (restartTimeout) clearTimeout(restartTimeout);
        
        try {
            await cleanup(reason);
            restartTimeout = setTimeout(async () => {
                try {
                    await startNazeBot();
                    reconnectAttempts = 0;
                } catch (e) {
                    console.error('[START ERROR]', e);
                } finally {
                    isRestarting = false;
                    restartTimeout = null;
                }
            }, delay);
        } catch (e) {
            console.error('[RESTART ERROR]', e);
            isRestarting = false;
        }
    } else {
        console.log(chalk.yellow(`[RESTART] ${reason} (delay ${customDelay}ms)`));
        if (restartTimeout) clearTimeout(restartTimeout);
        
        try {
            await cleanup(reason);
            restartTimeout = setTimeout(async () => {
                try {
                    await startNazeBot();
                    reconnectAttempts = 0;
                } catch (e) {
                    console.error('[START ERROR]', e);
                } finally {
                    isRestarting = false;
                    restartTimeout = null;
                }
            }, customDelay);
        } catch (e) {
            console.error('[RESTART ERROR]', e);
            isRestarting = false;
        }
    }
}

async function startNazeBot() {
    // Tutup instance lama sebelum membuat baru
    if (activeNazeInstance) {
        try {
            activeNazeInstance.ev.removeAllListeners();
            if (activeNazeInstance.ws) activeNazeInstance.ws.close();
            if (typeof activeNazeInstance.end === 'function') {
                activeNazeInstance.end();
            }
        } catch (e) {}
        activeNazeInstance = null;
    }

    try {
        const loadData = await database.read();
        const storeLoadData = await storeDB.read();
        if (!loadData || Object.keys(loadData).length === 0) {
            global.db = {
                hit: {},
                set: {},
                cmd: {},
                store: {},
                users: {},
                game: {},
                groups: {},
                database: {},
                premium: [],
                sewa: [],
                ...(loadData || {}),
            };
            await database.write(global.db);
        } else {
            global.db = loadData;
        }
        if (!storeLoadData || Object.keys(storeLoadData).length === 0) {
            global.store = {
                contacts: {},
                presences: {},
                messages: {},
                groupMetadata: {},
                ...(storeLoadData || {}),
            };
            await storeDB.write(global.store);
        } else {
            global.store = storeLoadData;
        }

        // Gunakan Map untuk akses O(1)
        if (!global.messageMap) {
            global.messageMap = new Map();
        }
        global.loadMessage = function (remoteJid, id) {
            const key = `${remoteJid}|${id}`;
            return global.messageMap.get(key) || null;
        };

        // FIX DB INTERVAL
        if (global._dbInterval) {
            clearInterval(global._dbInterval);
        }
        global._dbInterval = setInterval(async () => {
            try {
                if (global.db) await database.write(global.db);
                if (global.store) await storeDB.write(global.store);
            } catch (e) {
                console.error('[DB SAVE ERROR]', e);
            }
        }, 30000);
    } catch (e) {
        console.error(e);
        setTimeout(() => restartBot('Database error', 10000), 10000);
        return;
    }

    const level = pino({ level: 'silent' });
    
    // fetchLatestWaWebVersion dengan fallback
    let version;
    try {
        const waVersion = await fetchLatestWaWebVersion();
        version = waVersion.version;
    } catch {
        version = [2, 3000, 1015901307];
    }
    
    const { state, saveCreds } = await useMultiFileAuthState('nazedev');
    const getMessage = async (key) => {
        if (global.store) {
            const msg = await global.loadMessage(key.remoteJid, key.id);
            return msg?.message || '';
        }
        return { conversation: 'Halo Saya Naze Bot' };
    };

    const naze = WAConnection({
        version,
        logger: level,
        getMessage,
        syncFullHistory: false,
        maxMsgRetryCount: 5,
        msgRetryCounterCache,
        retryRequestDelayMs: 250,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        browser: Browsers.windows('Chrome'),
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        cachedGroupMetadata: async (jid) => {
            return global.store.groupMetadata?.[jid] || null;
        },
        transactionOpts: {
            maxCommitRetries: 10,
            delayBetweenTriesMs: 10,
        },
        appStateMacVerification: {
            patch: true,
            snapshot: true,
        },
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, level),
        },
    });

    activeNazeInstance = naze;
    naze.ev.setMaxListeners(20);

    if (pairingCode && !phoneNumber && !naze.authState.creds.registered) {
        async function getPhoneNumber() {
            phoneNumber = global.number_bot ? global.number_bot : process.env.BOT_NUMBER || (await question('Please type your WhatsApp number : '));
            phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
            if (!parsePhoneNumber('+' + phoneNumber).valid && phoneNumber.length < 6) {
                console.error(chalk.redBright('Start with your Country WhatsApp code, Example : 62xxx'));
                await getPhoneNumber();
            }
        }
        (async () => {
            await getPhoneNumber();
            await fsExtra.emptyDir('./nazedev');
            console.log(chalk.blue('Phone number captured. Waiting for connection...'));
        })();
    }

    await Solving(naze, global.store);

    // FIX MEMORY messages - limit 50 dan hapus chat kosong
    if (global._memoryCleaner) {
        clearInterval(global._memoryCleaner);
    }
    global._memoryCleaner = setInterval(() => {
        try {
            const chats = Object.keys(global.store.messages || {});
            for (const jid of chats) {
                const arr = global.store.messages[jid]?.array;
                if (Array.isArray(arr)) {
                    if (arr.length > 50) {
                        global.store.messages[jid].array = arr.slice(-50);
                    } else if (arr.length === 0) {
                        delete global.store.messages[jid];
                    }
                }
            }
        } catch (e) {}
    }, 60 * 1000);

    // FIX PRESENCE CLEANUP - cleanup berkala
    if (global._presenceCleaner) {
        clearInterval(global._presenceCleaner);
    }
    global._presenceCleaner = setInterval(() => {
        try {
            const keys = Object.keys(global.store.presences || {});
            if (keys.length > 1000) {
                for (const k of keys.slice(0, 300)) {
                    delete global.store.presences[k];
                }
            }
        } catch (e) {}
    }, 60 * 60 * 1000);

    // FIX GROUP METADATA CLEANUP - hapus group tidak aktif
    if (global._groupMetadataCleaner) {
        clearInterval(global._groupMetadataCleaner);
    }
    global._groupMetadataCleaner = setInterval(() => {
        try {
            const groups = Object.keys(global.store.groupMetadata || {});
            for (const gid of groups) {
                const meta = global.store.groupMetadata[gid];
                if (meta && !meta.participants?.length) {
                    delete global.store.groupMetadata[gid];
                }
            }
        } catch (e) {}
    }, 24 * 60 * 60 * 1000);

    naze.ev.on('creds.update', saveCreds);

    naze.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect, isNewLogin, receivedPendingNotifications } = update;
        
        if ((connection === 'connecting' || !!qr) && pairingCode && phoneNumber && !naze.authState.creds.registered && !pairingStarted) {
            if (pairingStarted || pairingTimeout) return;
            pairingTimeout = setTimeout(async () => {
                pairingStarted = true;
                try {
                    let code = await naze.requestPairingCode(phoneNumber);
                    console.log(chalk.blue('Your Pairing Code :'), chalk.green(code), chalk.yellow('(expires in 15 sec)'));
                } catch (e) {
                    console.error('[PAIRING ERROR]', e);
                } finally {
                    pairingTimeout = null;
                }
            }, 3000);
        }
        
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(chalk.red(`[DISCONNECTED] ${reason}`));
            
            if (pairingTimeout) {
                clearTimeout(pairingTimeout);
                pairingTimeout = null;
            }
            latestQr = null;
            pairingStarted = false;
            
            if (reason === DisconnectReason.connectionLost ||
                reason === DisconnectReason.connectionClosed ||
                reason === DisconnectReason.restartRequired ||
                reason === DisconnectReason.timedOut ||
                reason === DisconnectReason.badSession) {
                await restartBot(`Reconnect reason: ${reason}`);
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(chalk.red('Logged out. Delete session and relogin.'));
                try {
                    await fsExtra.emptyDir('./nazedev');
                } catch (e) {}
                process.exit(0);
            } else if (reason === DisconnectReason.connectionReplaced) {
                console.log(chalk.yellow('Connection replaced'));
            } else {
                await restartBot(`Unknown disconnect: ${reason}`);
            }
        }
        
        if (connection == 'open') {
            pairingStarted = false;
            if (pairingTimeout) {
                clearTimeout(pairingTimeout);
                pairingTimeout = null;
            }
            latestQr = null;
            reconnectAttempts = 0;
            console.log(chalk.green('[SUCCESS] Bot successfully connected!'));
            let botNumber = await naze.decodeJid(naze.user.id);
            if (global.db?.set[botNumber] && !global.db?.set[botNumber]?.join) {
                if (global.my?.ch && global.my.ch.includes('@newsletter')) {
                    if (global.my.ch) await naze.newsletterMsg(global.my.ch, { type: 'follow' }).catch(() => {});
                    global.db.set[botNumber].join = true;
                }
            }
        }
        
        if (qr && !pairingCode) {
            latestQr = qr;
            qrcode.generate(qr, { small: true });
        }
        
        if (isNewLogin) console.log(chalk.green('[INFO] New device login detected...'));
        if (receivedPendingNotifications) {
            console.log(chalk.green('[INFO] Please wait about 1 minute...'));
            try {
                naze.ev.flush();
            } catch (e) {}
        }
    });

    naze.ev.on('call', async (call) => {
        let botNumber = await naze.decodeJid(naze.user.id);
        if (global.db?.set[botNumber]?.anticall) {
            for (let id of call) {
                if (id.status === 'offer') {
                    try {
                        let msg = await naze.sendMessage(id.from, { text: `Saat Ini, Kami Tidak Dapat Menerima Panggilan ${id.isVideo ? 'Video' : 'Suara'}.\nJika @${id.from.split('@')[0]} Memerlukan Bantuan, Silakan Hubungi Owner :)`, mentions: [id.from] });
                        await naze.sendContact(id.from, ownerNumber, msg);
                        await naze.rejectCall(id.id, id.from);
                    } catch (e) {
                        console.error('[CALL ERROR]', e);
                    }
                }
            }
        }
    });

    naze.ev.on('messages.upsert', async (message) => {
        // Simpan ke messageMap
        const msgs = message.messages || [];
        for (const msg of msgs) {
            if (!msg?.key?.remoteJid || !msg?.key?.id) continue;
            const key = `${msg.key.remoteJid}|${msg.key.id}`;
            global.messageMap.set(key, msg);
            if (global.messageMap.size > 5000) {
                const firstKey = global.messageMap.keys().next().value;
                global.messageMap.delete(firstKey);
            }
        }
        
        setImmediate(async () => {
            try {
                await MessagesUpsert(naze, message, global.store);
            } catch (e) {
                console.error('[MESSAGE ERROR]', e);
            }
        });
    });

    naze.ev.on('group-participants.update', async (update) => {
        try {
            await GroupParticipantsUpdate(naze, update, global.store);
        } catch (e) {
            console.error('[GROUP PARTICIPANTS ERROR]', e);
        }
    });

    naze.ev.on('groups.update', (update) => {
        try {
            for (const n of update) {
                if (global.store.groupMetadata[n.id]) {
                    Object.assign(global.store.groupMetadata[n.id], n);
                } else global.store.groupMetadata[n.id] = n;
            }
        } catch (e) {
            console.error('[GROUPS UPDATE ERROR]', e);
        }
    });

    naze.ev.on('presence.update', (update) => {
        try {
            const { id, presences } = update;
            global.store.presences[id] = global.store.presences?.[id] || {};
            Object.assign(global.store.presences[id], presences);
        } catch (e) {
            console.error('[PRESENCE UPDATE ERROR]', e);
        }
    });

    // FIX CRON RESET LIMIT - hanya satu kali
    if (global._cronReset) {
        global._cronReset.stop();
    }
    global._cronReset = cron.schedule('00 00 * * *', async () => {
        try {
            cmdDel(global.db.hit);
            let user = Object.keys(global.db.users);
            let botNumber = await naze.decodeJid(naze.user.id);
            for (let jid of user) {
                const limitUser = global.db.users[jid].vip ? global.limit.vip : checkStatus(jid, global.db.premium) ? global.limit.premium : global.limit.free;
                if (global.db.users[jid].limit < limitUser) global.db.users[jid].limit = limitUser;
            }
            if (global.db?.set[botNumber].autobackup) {
                let datanya = './database/' + global.tempatDB;
                if (global.tempatDB.startsWith('mongodb')) {
                    datanya = './database/backup_database.json';
                    fs.writeFileSync(datanya, JSON.stringify(global.db, null, 2), 'utf-8');
                }
                for (let o of ownerNumber) {
                    try {
                        await naze.sendMessage(o, { document: fs.readFileSync(datanya), mimetype: 'application/json', fileName: new Date().toISOString().replace(/[:.]/g, '-') + '_database.json' });
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error('[CRON RESET ERROR]', e);
        }
    }, {
        scheduled: true,
        timezone: global.timezone,
    });

    // Waktu Sholat dengan cleanup timeout
    if (!global.intervalSholat) global.intervalSholat = null;
    if (!global.waktusholat) global.waktusholat = {};
    if (global.intervalSholat) clearInterval(global.intervalSholat);
    if (sholatTimeout) clearTimeout(sholatTimeout);
    sholatTimeout = setTimeout(() => {
        global.intervalSholat = setInterval(async () => {
            try {
                const sekarang = moment.tz(global.timezone);
                const jamSholat = sekarang.format('HH:mm');
                const hariIni = sekarang.format('YYYY-MM-DD');
                const detik = sekarang.format('ss');
                if (detik !== '00') return;
                for (const [sholat, waktu] of Object.entries(global.jadwalSholat)) {
                    if (jamSholat === waktu && global.waktusholat[sholat] !== hariIni) {
                        global.waktusholat[sholat] = hariIni;
                        for (const [idnya, settings] of Object.entries(global.db.groups)) {
                            if (settings.waktusholat) {
                                await naze.sendMessage(idnya, { text: `Waktu *${sholat}* telah tiba, ambilah air wudhu dan segeralah shalat🙂.\n\n*${waktu.slice(0, 5)}*\n_untuk wilayah ${global.timezone} dan sekitarnya._` }, { ephemeralExpiration: global.store?.messages[idnya]?.array?.slice(-1)[0]?.metadata?.ephemeralDuration || 0 }).catch(e => {});
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[SHOLAT ERROR]', e);
            }
        }, 60000);
        sholatTimeout = null;
    }, time_end);

    // FIX PRESENCE INTERVAL
    if (global._dbPresence) {
        clearInterval(global._dbPresence);
    }
    global._dbPresence = setInterval(async () => {
        try {
            if (naze?.user?.id) {
                await naze.sendPresenceUpdate('available', naze.decodeJid(naze.user.id));
            }
        } catch (e) {}
    }, 10 * 60 * 1000);

    return naze;
}

startNazeBot();

// ================== GRACEFUL SHUTDOWN ==================
process.on('beforeExit', async () => {
    try {
        if (global.db) await database.write(global.db);
        if (global.store) await storeDB.write(global.store);
    } catch (e) {}
});

process.on('SIGINT', async () => {
    await cleanup('SIGINT');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await cleanup('SIGTERM');
    process.exit(0);
});

// ================== GLOBAL ERROR HANDLER ==================
process.on('uncaughtException', async (err) => {
    console.error(chalk.red('[UNCAUGHT EXCEPTION]'), err);
    await restartBot('uncaughtException', 10000);
});

process.on('unhandledRejection', async (reason) => {
    console.error(chalk.red('[UNHANDLED REJECTION]'), reason);
    await restartBot('unhandledRejection', 10000);
});

server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') console.error(chalk.redBright(`[ERROR] ${error}`));
});
