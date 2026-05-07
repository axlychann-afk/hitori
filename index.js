// ========================= IMPORT =========================
import './settings.js'
import fs from 'fs'
import fsExtra from 'fs-extra'
import dns from 'dns'
import pino from 'pino'
import path from 'path'
import axios from 'axios'
import chalk from 'chalk'
import cron from 'node-cron'
import readline from 'readline'
import qrcode from 'qrcode-terminal'
import NodeCache from 'node-cache'
import moment from 'moment-timezone'
import { Boom } from '@hapi/boom'
import { toBuffer } from 'qrcode'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { parsePhoneNumber } from 'awesome-phonenumber'

import WAConnection, {
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestWaWebVersion
} from 'baileys'

import { app, server, PORT } from './src/server.js'
import { dataBase, cmdDel, checkStatus } from './src/database.js'
import { assertInstalled, customHttpsAgent } from './lib/function.js'
import {
    GroupParticipantsUpdate,
    MessagesUpsert,
    Solving
} from './src/message.js'

// ========================= BASIC =========================
const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

const question = (text) => new Promise(resolve => rl.question(text, resolve))

const tempDir = path.join(__dirname, 'database/temp')

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
}

process.setMaxListeners(50)

try {
    dns.setServers(['1.1.1.1', '8.8.8.8'])
} catch {}

// ========================= GLOBAL =========================
let activeNazeInstance = null
let latestQr = null
let restartLock = false
let reconnectAttempts = 0
let phoneNumber = null

global.intervals = []
global.timeouts = []

const ownerNumber = global.owner || []

// ========================= SAFE INTERVAL =========================
function safeInterval(fn, time) {
    const x = setInterval(fn, time)
    global.intervals.push(x)
    return x
}

function safeTimeout(fn, time) {
    const x = setTimeout(fn, time)
    global.timeouts.push(x)
    return x
}

// ========================= QR ROUTE =========================
app.get('/qr', async (req, res) => {
    try {
        if (!latestQr) return res.send('QR belum tersedia')

        res.setHeader('content-type', 'image/png')
        res.end(await toBuffer(latestQr))
    } catch {
        res.send('QR Error')
    }
})

// ========================= TEMP CLEANER =========================
safeInterval(() => {
    try {
        const files = fs.readdirSync(tempDir)

        for (const file of files) {
            const loc = path.join(tempDir, file)
            const stat = fs.statSync(loc)

            if (Date.now() - stat.mtimeMs > 3600000) {
                fs.unlinkSync(loc)
            }
        }
    } catch {}
}, 30 * 60 * 1000)

// ========================= MEMORY GUARD =========================
safeInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024

    if (used > 700) {
        console.log(chalk.red(`[MEMORY] ${used.toFixed(0)}MB restarting...`))
        process.exit(1)
    }
}, 5 * 60 * 1000)

// ========================= API =========================
global.fetchApi = async (
    endpoint = '/',
    data = {},
    options = {}
) => {
    try {
        const apiList = Object.keys(global.APIs)

        const apiName =
            typeof options.api === 'number'
                ? apiList[options.api - 1]
                : options.name

        const base = apiName
            ? (global.APIs[apiName] || apiName)
            : global.APIs.naze

        const apikey = global.APIKeys[base] || ''

        let method = (options.method || 'GET').toUpperCase()

        let url = base + endpoint

        let headers = {
            'user-agent': 'Mozilla/5.0',
            ...(options.headers || {})
        }

        let payload = null

        if (method === 'GET') {
            url += '?' + new URLSearchParams({
                ...data,
                apikey
            }).toString()
        } else {
            payload = {
                ...data,
                apikey
            }

            headers['content-type'] = 'application/json'
        }

        const res = await axios({
            method,
            url,
            data: payload,
            headers,
            timeout: 60000,
            httpsAgent: customHttpsAgent,
            responseType: options.buffer
                ? 'arraybuffer'
                : 'json'
        })

        return options.buffer
            ? Buffer.from(res.data)
            : res.data

    } catch (e) {
        return {
            status: false,
            error: String(e)
        }
    }
}

// ========================= DATABASE =========================
const database = dataBase(global.tempatDB)
const storeDB = dataBase(global.tempatStore)

const msgRetryCounterCache = new NodeCache({
    stdTTL: 60,
    checkperiod: 120,
    useClones: false
})

// ========================= CLEANUP =========================
async function cleanup(reason = 'unknown') {

    console.log(chalk.yellow(`[CLEANUP] ${reason}`))

    try {

        for (const x of global.intervals) {
            clearInterval(x)
        }

        for (const x of global.timeouts) {
            clearTimeout(x)
        }

        global.intervals = []
        global.timeouts = []

        rl.close()

        if (global.messageMap) {
            global.messageMap.clear()
        }

        if (global.db) {
            await database.write(global.db).catch(() => {})
        }

        if (global.store) {
            await storeDB.write(global.store).catch(() => {})
        }

        if (activeNazeInstance) {

            try {
                activeNazeInstance.ev.removeAllListeners()

                if (
                    activeNazeInstance.ws &&
                    activeNazeInstance.ws.readyState < 2
                ) {
                    activeNazeInstance.ws.close()
                }

            } catch {}

            activeNazeInstance = null
        }

    } catch (e) {
        console.log(e)
    }
}

// ========================= RESTART =========================
async function restartBot(reason = 'unknown') {

    if (restartLock) return
    restartLock = true

    reconnectAttempts++

    const delay = Math.min(
        5000 * reconnectAttempts,
        60000
    )

    console.log(
        chalk.yellow(
            `[RESTART] ${reason} delay ${delay}ms`
        )
    )

    await cleanup(reason)

    setTimeout(async () => {

        try {
            await startNazeBot()
        } catch (e) {
            console.log(e)
            process.exit(1)
        }

        restartLock = false

    }, delay)
}

// ========================= START BOT =========================
async function startNazeBot() {

    // ========================= LOAD DB =========================
    const loadData = await database.read()
    const storeLoadData = await storeDB.read()

    global.db = loadData || {
        users: {},
        groups: {},
        database: {},
        premium: [],
        sewa: [],
        hit: {},
        set: {}
    }

    global.store = storeLoadData || {
        contacts: {},
        presences: {},
        messages: {},
        groupMetadata: {}
    }

    // ========================= MESSAGE CACHE =========================
    global.messageMap = new Map()

    safeInterval(() => {

        if (global.messageMap.size > 3000) {

            const keys = [
                ...global.messageMap.keys()
            ]

            for (const k of keys.slice(0, 1000)) {
                global.messageMap.delete(k)
            }
        }

    }, 5 * 60 * 1000)

    global.loadMessage = async (
        remoteJid,
        id
    ) => {

        const key = `${remoteJid}|${id}`

        return global.messageMap.get(key) || null
    }

    // ========================= DB SAVE =========================
    safeInterval(async () => {

        try {
            await database.write(global.db)
            await storeDB.write(global.store)
        } catch {}

    }, 30 * 1000)

    // ========================= WA VERSION =========================
    let version

    try {

        const wa = await fetchLatestWaWebVersion()
        version = wa.version

    } catch {

        version = [2, 3000, 1015901307]

    }

    // ========================= AUTH =========================
    const {
        state,
        saveCreds
    } = await useMultiFileAuthState('nazedev')

    // ========================= SOCKET =========================
    const naze = WAConnection({

        version,
        logger: pino({ level: 'silent' }),

        browser: Browsers.windows('Chrome'),

        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'silent' })
            )
        },

        msgRetryCounterCache,

        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,

        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        defaultQueryTimeoutMs: 60000,

        cachedGroupMetadata: async (jid) => {
            return global.store.groupMetadata?.[jid] || null
        }

    })

    activeNazeInstance = naze

    // ========================= PAIRING =========================
    if (
        global.pairing_code &&
        !naze.authState.creds.registered
    ) {

        phoneNumber =
            global.number_bot ||
            process.env.BOT_NUMBER ||
            await question('Nomor Bot: ')

        phoneNumber = phoneNumber.replace(/[^0-9]/g, '')

        if (
            !parsePhoneNumber('+' + phoneNumber).valid
        ) {
            console.log('Nomor invalid')
            process.exit(1)
        }

        safeTimeout(async () => {

            try {

                const code =
                    await naze.requestPairingCode(
                        phoneNumber
                    )

                console.log(
                    chalk.green(`PAIRING: ${code}`)
                )

            } catch (e) {
                console.log(e)
            }

        }, 3000)
    }

    // ========================= SOLVING =========================
    await Solving(naze, global.store)

    // ========================= EVENTS =========================
    naze.ev.on('creds.update', saveCreds)

    naze.ev.on(
        'connection.update',
        async (update) => {

            const {
                qr,
                connection,
                lastDisconnect
            } = update

            if (qr) {
                latestQr = qr
                qrcode.generate(qr, {
                    small: true
                })
            }

            if (connection === 'open') {

                reconnectAttempts = 0

                console.log(
                    chalk.green(
                        '[CONNECTED]'
                    )
                )

            }

            if (connection === 'close') {

                const reason =
                    new Boom(
                        lastDisconnect?.error
                    )?.output?.statusCode

                console.log(
                    chalk.red(
                        `[DISCONNECT] ${reason}`
                    )
                )

                if (
                    reason === DisconnectReason.loggedOut
                ) {

                    await fsExtra.emptyDir(
                        './nazedev'
                    )

                    process.exit(1)

                } else {

                    restartBot(reason)

                }
            }
        }
    )

    // ========================= MESSAGE =========================
    naze.ev.on(
        'messages.upsert',
        async (message) => {

            try {

                const msgs =
                    message.messages || []

                for (const msg of msgs) {

                    if (
                        !msg?.key?.remoteJid ||
                        !msg?.key?.id
                    ) continue

                    const key =
                        `${msg.key.remoteJid}|${msg.key.id}`

                    global.messageMap.set(
                        key,
                        msg
                    )
                }

                await MessagesUpsert(
                    naze,
                    message,
                    global.store
                )

            } catch (e) {
                console.log(e)
            }
        }
    )

    // ========================= GROUP =========================
    naze.ev.on(
        'group-participants.update',
        async (update) => {

            try {

                await GroupParticipantsUpdate(
                    naze,
                    update,
                    global.store
                )

            } catch {}
        }
    )

    // ========================= PRESENCE =========================
    safeInterval(async () => {

        try {

            if (naze?.user?.id) {

                await naze.sendPresenceUpdate(
                    'available',
                    naze.user.id
                )

            }

        } catch {}

    }, 10 * 60 * 1000)

    // ========================= PRESENCE CLEANER =========================
    safeInterval(() => {

        try {

            const keys = Object.keys(
                global.store.presences || {}
            )

            if (keys.length > 500) {

                for (const k of keys.slice(0, 200)) {
                    delete global.store.presences[k]
                }

            }

        } catch {}

    }, 60 * 60 * 1000)

    // ========================= MESSAGE CLEANER =========================
    safeInterval(() => {

        try {

            const chats = Object.keys(
                global.store.messages || {}
            )

            for (const jid of chats) {

                const arr =
                    global.store.messages[jid]?.array

                if (!Array.isArray(arr)) continue

                if (arr.length > 30) {
                    global.store.messages[jid].array =
                        arr.slice(-30)
                }

                if (arr.length === 0) {
                    delete global.store.messages[jid]
                }
            }

        } catch {}

    }, 5 * 60 * 1000)

    // ========================= GROUP METADATA CLEANER =========================
    safeInterval(() => {

        try {

            const groups = Object.keys(
                global.store.groupMetadata || {}
            )

            if (groups.length > 300) {

                for (const gid of groups.slice(0, 100)) {
                    delete global.store.groupMetadata[gid]
                }

            }

        } catch {}

    }, 12 * 60 * 60 * 1000)

    // ========================= CRON =========================
    cron.schedule(
        '00 00 * * *',
        async () => {

            try {

                cmdDel(global.db.hit)

                const users = Object.keys(
                    global.db.users
                )

                for (const jid of users) {

                    const limitUser =
                        checkStatus(
                            jid,
                            global.db.premium
                        )
                            ? global.limit.premium
                            : global.limit.free

                    if (
                        global.db.users[jid].limit <
                        limitUser
                    ) {
                        global.db.users[jid].limit =
                            limitUser
                    }
                }

            } catch {}

        },
        {
            timezone: global.timezone
        }
    )

    // ========================= AUTO RESTART =========================
    safeInterval(() => {

        const uptime = process.uptime()

        if (uptime > 60 * 60 * 12) {

            console.log(
                chalk.yellow(
                    '[AUTO RESTART]'
                )
            )

            process.exit(1)

        }

    }, 10 * 60 * 1000)

    return naze
}

// ========================= SERVER =========================
assertInstalled(
    process.platform === 'win32'
        ? 'where ffmpeg'
        : 'command -v ffmpeg',
    'FFmpeg',
    0
)

if (!server.listening) {

    server.listen(PORT, () => {

        console.log(
            chalk.green(
                `[SERVER] ${PORT}`
            )
        )

    })
}

// ========================= START =========================
startNazeBot()

// ========================= EXIT =========================
process.on(
    'SIGINT',
    async () => {

        await cleanup('SIGINT')
        process.exit(0)

    }
)

process.on(
    'SIGTERM',
    async () => {

        await cleanup('SIGTERM')
        process.exit(0)

    }
)

process.on(
    'uncaughtException',
    async (err) => {

        console.log(err)
        restartBot('uncaughtException')

    }
)

process.on(
    'unhandledRejection',
    async (err) => {

        console.log(err)
        restartBot('unhandledRejection')

    }
)
