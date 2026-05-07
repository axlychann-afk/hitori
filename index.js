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
import { GroupParticipantsUpdate, MessagesUpsert, Solving } from './src/message.js'

// ========================= BASIC =========================
const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

const question = (t) => new Promise(r => rl.question(t, r))

const tempDir = path.join(__dirname, 'database/temp')

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
}

dns.setServers(['1.1.1.1', '8.8.8.8'])
process.setMaxListeners(0)

// ========================= GLOBAL =========================
let activeNazeInstance = null
let restartLock = false
let reconnectAttempts = 0
let phoneNumber = null

global.intervals = []
global.timeouts = []
global.messageMap = new Map()
global.store = global.store || {}

// ========================= TIMER =========================
function safeInterval(fn, t) {
    const x = setInterval(fn, t)
    global.intervals.push(x)
    return x
}

// ========================= LOAD MESSAGE FIX =========================
global.loadMessage = async (jid, id) => {
    try {
        const arr = global.store?.messages?.[jid]?.array
        if (!Array.isArray(arr)) return null
        return arr.find(m => m?.key?.id === id) || null
    } catch {
        return null
    }
}

// ========================= CLEANUP =========================
async function cleanup(reason) {
    console.log(chalk.yellow(`[CLEANUP] ${reason}`))

    for (const x of global.intervals) clearInterval(x)
    for (const x of global.timeouts) clearTimeout(x)

    global.intervals = []
    global.timeouts = []

    try {
        activeNazeInstance?.ev?.removeAllListeners()
        activeNazeInstance?.ws?.close?.()
    } catch {}

    activeNazeInstance = null
}

// ========================= RESTART =========================
async function restartBot(reason) {
    if (restartLock) return
    restartLock = true

    reconnectAttempts++

    const delay = Math.min(reconnectAttempts * 4000, 60000)

    console.log(chalk.yellow(`[RESTART] ${reason} ${delay}ms`))

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

// ========================= FETCH API =========================
global.fetchApi = async (endpoint = '/', data = {}, opt = {}) => {
    try {
        const base = global.APIs?.naze
        const apikey = global.APIKeys?.[base] || ''

        let url = base + endpoint

        if ((opt.method || 'GET') === 'GET') {
            url += '?' + new URLSearchParams({ ...data, apikey })
        }

        const res = await axios({
            method: opt.method || 'GET',
            url,
            data: opt.method === 'GET' ? undefined : { ...data, apikey },
            headers: { 'user-agent': 'Mozilla/5.0' },
            timeout: 60000,
            httpsAgent: customHttpsAgent
        })

        return res.data
    } catch (e) {
        return { status: false, error: String(e) }
    }
}

// ========================= START BOT =========================
async function startNazeBot() {

    const db = await dataBase(global.tempatDB).read()
    const store = await dataBase(global.tempatStore).read()

    global.db = db || {}
    global.store = store || {}

    let version
    try {
        version = (await fetchLatestWaWebVersion()).version
    } catch {
        version = [2, 3000, 1015]
    }

    const { state, saveCreds } = await useMultiFileAuthState('nazedev')

    const naze = WAConnection({
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.windows('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000
    })

    activeNazeInstance = naze

    naze.ev.on('creds.update', saveCreds)

    // ========================= CONNECTION =========================
    naze.ev.on('connection.update', async (u) => {
        const { qr, connection, lastDisconnect } = u

        if (qr) qrcode.generate(qr, { small: true })

        if (connection === 'open') {
            reconnectAttempts = 0
            console.log(chalk.green('[CONNECTED]'))
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode

            if (reason === DisconnectReason.loggedOut) {
                await fsExtra.emptyDir('./nazedev')
                process.exit(1)
            } else restartBot(reason)
        }
    })

    // ========================= ANTI CALL =========================
    naze.ev.on('call', async (call) => {
        try {
            if (!Array.isArray(call)) return

            for (const c of call) {
                if (c.status === 'offer') {
                    await naze.rejectCall(c.id, c.from)
                    await naze.sendMessage(c.from, {
                        text: 'Tidak menerima panggilan.'
                    })
                }
            }
        } catch {}
    })

    // ========================= MESSAGE =========================
    naze.ev.on('messages.upsert', async (m) => {
        try {
            const msgs = m.messages || []

            for (const msg of msgs) {
                if (!msg?.key?.remoteJid || !msg?.key?.id) continue

                global.messageMap.set(
                    `${msg.key.remoteJid}|${msg.key.id}`,
                    msg
                )
            }

            if (global.messageMap.size > 3000) {
                const keys = [...global.messageMap.keys()]
                for (const k of keys.slice(0, 1000)) {
                    global.messageMap.delete(k)
                }
            }

            await MessagesUpsert(naze, m, global.store)
        } catch {}
    })

    naze.ev.on('group-participants.update', async (u) => {
        await GroupParticipantsUpdate(naze, u, global.store)
    })

    // ========================= GROUP + PRESENCE FIX =========================
    naze.ev.on('groups.update', (update) => {
        try {
            for (const g of update) {
                if (!g?.id) continue
                global.store.groupMetadata[g.id] = global.store.groupMetadata[g.id] || {}
                Object.assign(global.store.groupMetadata[g.id], g)
            }
        } catch {}
    })

    naze.ev.on('presence.update', (update) => {
        try {
            const { id, presences } = update
            global.store.presences[id] = global.store.presences[id] || {}
            Object.assign(global.store.presences[id], presences)
        } catch {}
    })

    // ========================= HEARTBEAT =========================
    safeInterval(() => {
        if (!activeNazeInstance) restartBot('heartbeat_dead')
    }, 300000)

    return naze
}

// ========================= START =========================
startNazeBot()

process.on('uncaughtException', e => restartBot('uncaughtException'))
process.on('unhandledRejection', e => restartBot('unhandledRejection'))
