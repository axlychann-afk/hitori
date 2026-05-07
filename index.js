import './settings.js';
import fs from 'fs';
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

import WAConnection, {
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestWaWebVersion,
    jidNormalizedUser
} from 'baileys';

import { app, server, PORT } from './src/server.js';
import { dataBase, cmdDel, checkStatus } from './src/database.js';
import { assertInstalled, customHttpsAgent } from './lib/function.js';
import { GroupParticipantsUpdate, MessagesUpsert, Solving } from './src/message.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FIX: readline
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const question = (text) => new Promise(resolve => rl.question(text, resolve));

// TEMP DIR FIX
const tempDir = path.join(__dirname, 'database/temp');

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// DNS FIX
try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}

let activeNazeInstance = null;
let pairingStarted = false;
let phoneNumber;

// FIX CACHE
global.store = global.store || {};
global.messageMap = new Map();

// ================= API (TIDAK DIUBAH LOGIC) =================
global.fetchApi = async (endpoint = '/', data = {}, options = {}) => {
    try {
        const apiList = Object.keys(global.APIs || {});
        const apiName = typeof options.api === 'number'
            ? apiList[options.api - 1]
            : options.name;

        const base = apiName
            ? (global.APIs?.[apiName] || apiName)
            : global.APIs?.naze;

        const apikey = global.APIKeys?.[base] || '';

        const method = (options.method || 'GET').toUpperCase();

        let url = base + endpoint;
        let payload = null;

        let headers = options.headers || {
            'user-agent': 'Mozilla/5.0'
        };

        if (method === 'GET') {
            url += '?' + new URLSearchParams({ ...data, apikey }).toString();
        } else {
            payload = { ...data, apikey };
            headers['content-type'] = 'application/json';
        }

        const res = await axios({
            method,
            url,
            data: payload,
            headers,
            timeout: 60000,
            httpsAgent: customHttpsAgent,
            responseType: options.buffer ? 'arraybuffer' : 'json'
        });

        return options.buffer ? Buffer.from(res.data) : res.data;

    } catch (e) {
        return { status: false, error: String(e) };
    }
};

const storeDB = dataBase(global.tempatStore);
const database = dataBase(global.tempatDB);
const msgRetryCounterCache = new NodeCache();

// CLEAN TEMP FIX
if (fs.existsSync(tempDir)) {
    fs.readdirSync(tempDir).forEach(file => {
        fs.unlinkSync(path.join(tempDir, file));
    });
}

// ================= START BOT =================
async function startNazeBot() {

    const loadData = await database.read();
    const storeLoadData = await storeDB.read();

    global.db = loadData || {
        users: {},
        groups: {},
        database: {},
        premium: [],
        sewa: [],
        hit: {},
        set: {}
    };

    global.store = storeLoadData || {
        contacts: {},
        presences: {},
        messages: {},
        groupMetadata: {}
    };

    // FIX LOAD MESSAGE (ERROR STORE FIX)
    global.loadMessage = function (remoteJid, id) {
        const messages = global.store?.messages?.[remoteJid]?.array;
        if (!messages) return null;
        return messages.find(msg => msg?.key?.id === id) || null;
    };

    const { version } = await fetchLatestWaWebVersion();
    const { state, saveCreds } = await useMultiFileAuthState('nazedev');

    const naze = WAConnection({
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        msgRetryCounterCache,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    activeNazeInstance = naze;

    naze.ev.on('creds.update', saveCreds);

    // ================= CONNECTION FIX =================
    naze.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            if (reason === DisconnectReason.loggedOut) {
                await fs.promises.rm('./nazedev', { recursive: true, force: true });
                process.exit(1);
            } else {
                startNazeBot();
            }
        }
    });

    await Solving(naze, global.store);

    // ================= FIX MESSAGE HANDLER (INI KUNCI BOT BISA JAWAB) =================
    naze.ev.on('messages.upsert', async (message) => {
        try {
            await MessagesUpsert(naze, message, global.store);

            const msg = message.messages?.[0];
            if (!msg?.message) return;

            const from = msg.key.remoteJid;
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                '';

            // FIX ONLY (tanpa fitur tambahan, hanya test respon minimal)
            if (text.toLowerCase() === 'ping') {
                await naze.sendMessage(from, { text: 'pong' });
            }

        } catch {}
    });

    // ================= GROUP FIX =================
    naze.ev.on('group-participants.update', async (update) => {
        try {
            await GroupParticipantsUpdate(naze, update, global.store);
        } catch {}
    });

    naze.ev.on('groups.update', (update) => {
        for (const n of update) {
            if (global.store.groupMetadata[n.id]) {
                Object.assign(global.store.groupMetadata[n.id], n);
            } else {
                global.store.groupMetadata[n.id] = n;
            }
        }
    });

    naze.ev.on('presence.update', (update) => {
        const { id, presences } = update;
        global.store.presences[id] = global.store.presences?.[id] || {};
        Object.assign(global.store.presences[id], presences);
    });

    return naze;
}

startNazeBot();

// ================= CLEAN EXIT =================
process.on('SIGINT', async () => process.exit(0));
process.on('SIGTERM', async () => process.exit(0));
