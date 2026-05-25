import './settings.js'
import fs from 'fs'
import fsExtra from 'fs-extra'
import os from 'os'
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
import { exec } from 'child_process'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { parsePhoneNumber } from 'awesome-phonenumber'

import WAConnection, {
    Browsers,
    DisconnectReason,
    fetchLatestWaWebVersion,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState
} from 'baileys'

import {
    app,
    server,
    PORT
} from './src/server.js'

import {
    dataBase,
    cmdDel,
    checkStatus
} from './src/database.js'

import {
    assertInstalled,
    customHttpsAgent
} from './lib/function.js'

import {
    GroupParticipantsUpdate,
    MessagesUpsert,
    Solving
} from './src/message.js'

const require = createRequire(import.meta.url)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const print = () => {}

const pairingCode =
    process.argv.includes('--qr')
        ? false
        : process.argv.includes('--pairing-code') ||
          global.pairing_code

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

const question = (text) =>
    new Promise((resolve) =>
        rl.question(text, resolve)
    )

const tempDir = path.join(
    __dirname,
    'database/temp'
)

const time_now = new Date()

const time_end =
    60000 -
    (
        time_now.getSeconds() *
            1000 +
        time_now.getMilliseconds()
    )

const ownerNumber = global.owner || []

let pairingStarted = false
let pairingTimeout = null
let restartTimeout = null
let sholatTimeout = null

let reconnectAttempts = 0
let isRestarting = false
let latestQr = null
let phoneNumber = null

let activeaxlyInstance = null

process.setMaxListeners(30)

try {
    dns.setServers([
        '8.8.8.8',
        '1.1.1.1'
    ])
} catch {}

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, {
        recursive: true
    })
}

app.get('/qr', async (req, res) => {
    try {
        if (!latestQr) {
            return res.send(
                'QR belum tersedia'
            )
        }

        res.setHeader(
            'content-type',
            'image/png'
        )

        const qr =
            await toBuffer(latestQr)

        res.end(qr)

    } catch (e) {
        res.send('QR error')
    }
})

if (!server.listening) {
    server.listen(PORT, () => {
        console.log(
            chalk.green(
                `[ SERVER ] running on ${PORT}`
            )
        )
    })
}

assertInstalled(
    process.platform === 'win32'
        ? 'where ffmpeg'
        : 'command -v ffmpeg',
    'FFmpeg',
    0
)

global.fetchApi = async (
    endpoint = '/',
    data = {},
    options = {}
) => {

    try {

        const apiList =
            Object.keys(global.APIs)

        const apiName =
            typeof options.api === 'number'
                ? apiList[
                      options.api - 1
                  ]
                : options.name

        const base =
            apiName
                ? (
                      global.APIs[
                          apiName
                      ] || apiName
                  )
                : global.APIs.naze

        const apikey =
            global.APIKeys[base] || ''

        let method =
            (
                options.method ||
                'GET'
            ).toUpperCase()

        let url =
            base + endpoint

        let payload = null

        let headers =
            options.headers || {
                'user-agent':
                    'Mozilla/5.0'
            }

        const isForm =
            options.form ||
            (
                data &&
                typeof data.getHeaders ===
                    'function'
            )

        if (isForm) {

            method = 'POST'
            payload = data

            headers = {
                ...headers,
                ...data.getHeaders()
            }

        } else if (
            method !== 'GET'
        ) {

            payload = {
                ...data,
                apikey
            }

            headers[
                'content-type'
            ] = 'application/json'

        } else {

            url +=
                '?' +
                new URLSearchParams({
                    ...data,
                    apikey
                }).toString()
        }

        const res =
            await axios({
                method,
                url,
                data: payload,
                headers,
                timeout: 60000,
                httpsAgent:
                    customHttpsAgent,
                responseType:
                    options.buffer
                        ? 'arraybuffer'
                        : 'json'
            })

        if (options.buffer) {
            return Buffer.from(
                res.data
            )
        }

        return res.data

    } catch (e) {
        console.error(
            '[FETCH API ERROR]',
            e
        )

        return null
    }
}

const database =
    dataBase(global.tempatDB)

const storeDB =
    dataBase(global.tempatStore)

const msgRetryCounterCache =
    new NodeCache({
        stdTTL: 60,
        checkperiod: 120,
        useClones: false
    })

global.safeInterval = (
    func,
    delay
) => {

    return setInterval(
        async () => {
            try {
                await func()
            } catch (e) {
                console.error(
                    '[SAFE INTERVAL ERROR]',
                    e
                )
            }
        },
        delay
    )
}

global.safeTimeout = (
    func,
    delay
) => {

    return setTimeout(
        async () => {
            try {
                await func()
            } catch (e) {
                console.error(
                    '[SAFE TIMEOUT ERROR]',
                    e
                )
            }
        },
        delay
    )
}

const cleanup = async (
    reason = 'unknown'
) => {

    try {

        console.log(
            chalk.yellow(
                `[ CLEANUP ] ${reason}`
            )
        )

        if (global._dbInterval) {
            clearInterval(
                global._dbInterval
            )

            global._dbInterval =
                null
        }

        if (
            global._memoryCleaner
        ) {
            clearInterval(
                global._memoryCleaner
            )

            global._memoryCleaner =
                null
        }

        if (
            global._presenceCleaner
        ) {
            clearInterval(
                global._presenceCleaner
            )

            global._presenceCleaner =
                null
        }

        if (
            global._groupMetadataCleaner
        ) {
            clearInterval(
                global
                    ._groupMetadataCleaner
            )

            global._groupMetadataCleaner =
                null
        }

        if (
            global._dbPresence
        ) {
            clearInterval(
                global._dbPresence
            )

            global._dbPresence =
                null
        }

        if (
            global.intervalSholat
        ) {
            clearInterval(
                global.intervalSholat
            )

            global.intervalSholat =
                null
        }

        if (restartTimeout) {
            clearTimeout(
                restartTimeout
            )

            restartTimeout = null
        }

        if (pairingTimeout) {
            clearTimeout(
                pairingTimeout
            )

            pairingTimeout = null
        }

        if (sholatTimeout) {
            clearTimeout(
                sholatTimeout
            )

            sholatTimeout = null
        }

        if (global.messageMap) {
            global.messageMap.clear()
        }

        if (global.db) {
            await database
                .write(global.db)
                .catch(() => {})
        }

        if (global.store) {
            await storeDB
                .write(global.store)
                .catch(() => {})
        }

        if (
            activeaxlyInstance
        ) {

            try {

                activeaxlyInstance.ev.removeAllListeners()

                if (
                    activeaxlyInstance.ws
                ) {
                    activeaxlyInstance.ws.close()
                }

            } catch {}

            activeaxlyInstance =
                null
        }

    } catch (e) {
        console.error(
            '[CLEANUP ERROR]',
            e
        )
    }
}

async function restartBot(
    reason = 'unknown',
    delay = 10000
) {

    if (isRestarting) return

    isRestarting = true

    console.log(
        chalk.red(
            `[ RESTART ] ${reason}`
        )
    )

    try {

        await cleanup(reason)

        restartTimeout =
            setTimeout(
                async () => {

                    try {

                        await startaxlyBot()

                    } catch (e) {

                        console.error(
                            '[RESTART FAIL]',
                            e
                        )

                    } finally {

                        isRestarting =
                            false

                        restartTimeout =
                            null
                    }

                },
                delay
            )

    } catch (e) {

        console.error(
            '[RESTART ERROR]',
            e
        )

        isRestarting = false
    }
}

global.safeInterval(
    async () => {

        try {

            const used =
                process.memoryUsage()

            const heap =
                used.heapUsed /
                1024 /
                1024

            if (heap > 700) {

                console.log(
                    chalk.red(
                        `[ MEMORY ] ${heap.toFixed(2)} MB`
                    )
                )

                if (
                    !isRestarting
                ) {

                    await restartBot(
                        'memory limit',
                        10000
                    )
                }
            }

        } catch (e) {
            console.error(e)
        }

    },
    60000
)

async function startaxlyBot() {

    if (
        activeaxlyInstance
    ) {

        try {

            activeaxlyInstance.ev.removeAllListeners()

            if (
                activeaxlyInstance.ws
            ) {
                activeaxlyInstance.ws.close()
            }

        } catch {}

        activeaxlyInstance =
            null
    }

    try {

        const loadData =
            await database.read()

        const storeData =
            await storeDB.read()

        global.db =
            loadData || {
                users: {},
                groups: {},
                set: {},
                game: {},
                database: {},
                premium: [],
                sewa: [],
                hit: {}
            }

        global.store =
            storeData || {
                contacts: {},
                messages: {},
                presences: {},
                groupMetadata: {}
            }

        if (
            !global.messageMap
        ) {
            global.messageMap =
                new Map()
        }

        global.loadMessage =
            function (
                remoteJid,
                id
            ) {

                const key =
                    `${remoteJid}|${id}`

                return (
                    global.messageMap.get(
                        key
                    ) || null
                )
            }

        if (
            global._dbInterval
        ) {
            clearInterval(
                global._dbInterval
            )
        }

        global._dbInterval =
            global.safeInterval(
                async () => {

                    if (global.db) {
                        await database.write(
                            global.db
                        )
                    }

                    if (
                        global.store
                    ) {
                        await storeDB.write(
                            global.store
                        )
                    }

                },
                30000
            )

    } catch (e) {

        console.error(
            '[DATABASE ERROR]',
            e
        )

        return restartBot(
            'database',
            10000
        )
    }

    const logger =
        pino({
            level: 'silent'
        })

    let version

    try {

        const waVersion =
            await fetchLatestWaWebVersion()

        version =
            waVersion.version

    } catch {

        version = [
            2,
            3000,
            1015901307
        ]
    }

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            'axly'
        )
        const getMessage = async (key) => {
    try {
        if (!global.store) return { conversation: '' }
        const msg = await global.loadMessage(key.remoteJid, key.id)
        return msg?.message || { conversation: '' }
    } catch {
        return { conversation: '' }
    }
}

    const axly = WAConnection({
        version,
        logger,

        browser:
            Browsers.windows(
                'Chrome'
            ),

        auth: {
            creds:
                state.creds,

            keys:
                makeCacheableSignalKeyStore(
                    state.keys,
                    logger
                )
        },

        getMessage,

        syncFullHistory: false,

        markOnlineOnConnect: true,

        emitOwnEvents: false,

        fireInitQueries: false,

        generateHighQualityLinkPreview: false,

        retryRequestDelayMs: 250,

        defaultQueryTimeoutMs: 60000,

        connectTimeoutMs: 60000,

        keepAliveIntervalMs: 10000,

        maxMsgRetryCount: 5,

        msgRetryCounterCache,

        cachedGroupMetadata:
            async (jid) => {

                try {

                    return (
                        global.store
                            ?.groupMetadata?.[
                            jid
                        ] || null
                    )

                } catch {
                    return null
                }
            },

        transactionOpts: {
            maxCommitRetries: 10,
            delayBetweenTriesMs: 10
        },

        appStateMacVerification:
            {
                patch: true,
                snapshot: true
            }
    })

    activeaxlyInstance =
        axly

    if (
        pairingCode &&
        !phoneNumber &&
        !state.creds
            .registered
    ) {

        async function getPhoneNumber() {

            phoneNumber =
                global.number_bot ||
                process.env
                    .BOT_NUMBER ||
                (
                    await question(
                        'Input Number : '
                    )
                )

            phoneNumber =
                phoneNumber.replace(
                    /[^0-9]/g,
                    ''
                )

            const check =
                parsePhoneNumber(
                    '+' +
                        phoneNumber
                )

            if (
                !check.valid &&
                phoneNumber.length <
                    6
            ) {

                console.log(
                    chalk.red(
                        'Invalid Number'
                    )
                )

                return getPhoneNumber()
            }
        }

        ;(async () => {

            await getPhoneNumber()

            await fsExtra.emptyDir(
                './axly'
            )

            console.log(
                chalk.green(
                    'Waiting pairing code...'
                )
            )

        })()
    }

    await Solving(
        axly,
        global.store
    )

    if (
        global._memoryCleaner
    ) {
        clearInterval(
            global._memoryCleaner
        )
    }

    global._memoryCleaner =
        global.safeInterval(
            async () => {

                try {

                    const chats =
                        Object.keys(
                            global.store
                                .messages ||
                                {}
                        )

                    for (const jid of chats) {

                        const arr =
                            global
                                .store
                                .messages[
                                jid
                            ]?.array

                        if (
                            Array.isArray(
                                arr
                            )
                        ) {

                            if (
                                arr.length >
                                50
                            ) {

                                global.store.messages[
                                    jid
                                ].array =
                                    arr.slice(
                                        -50
                                    )
                            }

                            if (
                                arr.length ===
                                0
                            ) {
                                delete global
                                    .store
                                    .messages[
                                    jid
                                ]
                            }
                        }
                    }

                } catch (e) {
                    console.error(
                        '[MEMORY CLEANER]',
                        e
                    )
                }

            },
            60000
        )

    if (
        global._presenceCleaner
    ) {
        clearInterval(
            global._presenceCleaner
        )
    }

    global._presenceCleaner =
        global.safeInterval(
            async () => {

                try {

                    const keys =
                        Object.keys(
                            global.store
                                .presences ||
                                {}
                        )

                    if (
                        keys.length >
                        1000
                    ) {

                        for (const k of keys.slice(
                            0,
                            300
                        )) {

                            delete global
                                .store
                                .presences[
                                k
                            ]
                        }
                    }

                } catch (e) {
                    console.error(
                        '[PRESENCE CLEANER]',
                        e
                    )
                }

            },
            60 * 60 * 1000
        )

    if (
        global._groupMetadataCleaner
    ) {
        clearInterval(
            global
                ._groupMetadataCleaner
        )
    }

    global._groupMetadataCleaner =
        global.safeInterval(
            async () => {

                try {

                    const groups =
                        Object.keys(
                            global.store
                                .groupMetadata ||
                                {}
                        )

                    for (const gid of groups) {

                        const meta =
                            global
                                .store
                                .groupMetadata[
                                gid
                            ]

                        if (
                            meta &&
                            !meta
                                .participants
                                ?.length
                        ) {

                            delete global
                                .store
                                .groupMetadata[
                                gid
                            ]
                        }
                    }

                } catch (e) {
                    console.error(
                        '[GROUP CLEANER]',
                        e
                    )
                }

            },
            24 *
                60 *
                60 *
                1000
        )

    axly.ev.on(
        'creds.update',
        saveCreds
    )

    axly.ev.on(
        'connection.update',
        async (update) => {

            try {

                const {
                    qr,
                    connection,
                    lastDisconnect,
                    isNewLogin,
                    receivedPendingNotifications
                } = update

                if (
                    (
                        connection ===
                            'connecting' ||
                        qr
                    ) &&
                    pairingCode &&
                    phoneNumber &&
                    !state.creds
                        .registered &&
                    !pairingStarted
                ) {

                    if (
                        pairingTimeout
                    ) {
                        return
                    }

                    pairingTimeout =
                        setTimeout(
                            async () => {

                                try {

                                    pairingStarted =
                                        true

                                    const code =
                                        await axly.requestPairingCode(
                                            phoneNumber
                                        )

                                    console.log(
                                        chalk.green(
                                            `PAIRING CODE : ${code}`
                                        )
                                    )

                                } catch (e) {

                                    console.error(
                                        '[PAIRING ERROR]',
                                        e
                                    )

                                } finally {

                                    pairingTimeout =
                                        null
                                }

                            },
                            3000
                        )
                }

                if (
                    connection ===
                    'open'
                ) {

                    reconnectAttempts =
                        0

                    pairingStarted =
                        false

                    latestQr =
                        null

                    console.log(
                        chalk.green(
                            '[ CONNECTED ]'
                        )
                    )

                    let botNumber =
                        await axly.decodeJid(
                            axly.user.id
                        )

                    if (
                        global.db?.set?.[
                            botNumber
                        ] &&
                        !global.db.set[
                            botNumber
                        ].join
                    ) {

                        if (
                            global.my?.ch &&
                            global.my.ch.includes(
                                '@newsletter'
                            )
                        ) {

                            try {

                                await axly.newsletterMsg(
                                    global.my
                                        .ch,
                                    {
                                        type: 'follow'
                                    }
                                )

                                global.db.set[
                                    botNumber
                                ].join =
                                    true

                            } catch {}
                        }
                    }
                }

                if (
                    qr &&
                    !pairingCode
                ) {

                    latestQr =
                        qr

                    qrcode.generate(
                        qr,
                        {
                            small: true
                        }
                    )
                }

                if (
                    isNewLogin
                ) {
                    console.log(
                        chalk.green(
                            '[ NEW LOGIN ]'
                        )
                    )
                }

                if (
                    receivedPendingNotifications
                ) {

                    console.log(
                        chalk.yellow(
                            '[ SYNCING ]'
                        )
                    )
                }

                if (
                    connection ===
                    'close'
                ) {

                    latestQr =
                        null

                    pairingStarted =
                        false

                    const reason =
                        new Boom(
                            lastDisconnect?.error
                        ).output
                            ?.statusCode

                    const errText =
                        String(
                            lastDisconnect?.error ||
                                ''
                        )

                    if (
                        errText.includes(
                            'Bad MAC'
                        ) ||
                        errText.includes(
                            'decrypt'
                        ) ||
                        errText.includes(
                            'Session error'
                        )
                    ) {

                        console.log(
                            chalk.yellow(
                                'Ignore decrypt error'
                            )
                        )

                        return restartBot(
                            'decrypt',
                            5000
                        )
                    }

                    console.log(
                        chalk.red(
                            `[ DISCONNECTED ] ${reason}`
                        )
                    )
                    if (
                        reason ===
                            DisconnectReason.connectionLost ||
                        reason ===
                            DisconnectReason.connectionClosed ||
                        reason ===
                            DisconnectReason.restartRequired ||
                        reason ===
                            DisconnectReason.timedOut ||
                        reason ===
                            DisconnectReason.badSession
                    ) {

                        return restartBot(
                            `disconnect ${reason}`
                        )
                    }

                    if (
                        reason ===
                        DisconnectReason.loggedOut
                    ) {

                        console.log(
                            chalk.red(
                                'Logged out'
                            )
                        )

                        try {

                            await fsExtra.emptyDir(
                                './axly'
                            )

                        } catch {}

                        return
                    }

                    if (
                        reason ===
                        DisconnectReason.connectionReplaced
                    ) {

                        console.log(
                            chalk.yellow(
                                'Connection replaced'
                            )
                        )

                        return
                    }

                    return restartBot(
                        `unknown ${reason}`
                    )
                }

            } catch (e) {

                console.error(
                    '[CONNECTION UPDATE ERROR]',
                    e
                )

                return restartBot(
                    'connection.update',
                    10000
                )
            }
        }
    )

    axly.ev.on(
        'call',
        async (calls) => {

            try {

                const botNumber =
                    await axly.decodeJid(
                        axly.user.id
                    )

                if (
                    !global.db?.set?.[
                        botNumber
                    ]?.anticall
                ) {
                    return
                }

                for (const call of calls) {

                    if (
                        call.status !==
                        'offer'
                    ) {
                        continue
                    }

                    try {

                        const msg =
                            await axly.sendMessage(
                                call.from,
                                {
                                    text:
`Saat Ini Bot Tidak Bisa Menerima ${
call.isVideo
    ? 'Video'
    : 'Suara'
} Call.\nHubungi Owner Jika Penting.`,
                                    mentions: [
                                        call.from
                                    ]
                                }
                            )

                        await axly.sendContact(
                            call.from,
                            ownerNumber,
                            msg
                        )

                        await axly.rejectCall(
                            call.id,
                            call.from
                        )

                    } catch (e) {

                        console.error(
                            '[CALL ERROR]',
                            e
                        )
                    }
                }

            } catch (e) {

                console.error(
                    '[CALL EVENT ERROR]',
                    e
                )
            }
        }
    )

    axly.ev.on(
        'messages.upsert',
        async (message) => {

            try {

                const msgs =
                    message.messages ||
                    []

                for (const msg of msgs) {

                    if (
                        !msg?.key
                            ?.remoteJid ||
                        !msg?.key?.id
                    ) {
                        continue
                    }

                    const key =
`${msg.key.remoteJid}|${msg.key.id}`

                    global.messageMap.set(
                        key,
                        msg
                    )

                    if (
                        global.messageMap
                            .size > 5000
                    ) {

                        const first =
                            global
                                .messageMap
                                .keys()
                                .next()
                                .value

                        global.messageMap.delete(
                            first
                        )
                    }
                }

                setImmediate(
                    async () => {

                        try {

                            await MessagesUpsert(
                                axly,
                                message,
                                global.store
                            )

                        } catch (e) {

                            console.error(
                                '[MESSAGE UPSERT ERROR]',
                                e
                            )
                        }
                    }
                )

            } catch (e) {

                console.error(
                    '[MESSAGES EVENT ERROR]',
                    e
                )
            }
        }
    )

    axly.ev.on(
        'group-participants.update',
        async (update) => {

            try {

                await GroupParticipantsUpdate(
                    axly,
                    update,
                    global.store
                )

            } catch (e) {

                console.error(
                    '[GROUP PARTICIPANT ERROR]',
                    e
                )
            }
        }
    )

    axly.ev.on(
        'groups.update',
        async (updates) => {

            try {

                for (const data of updates) {

                    if (
                        global.store
                            .groupMetadata?.[
                            data.id
                        ]
                    ) {

                        Object.assign(
                            global.store
                                .groupMetadata[
                                data.id
                            ],
                            data
                        )

                    } else {

                        global.store.groupMetadata[
                            data.id
                        ] = data
                    }
                }

            } catch (e) {

                console.error(
                    '[GROUP UPDATE ERROR]',
                    e
                )
            }
        }
    )

    axly.ev.on(
        'presence.update',
        async (update) => {

            try {

                const {
                    id,
                    presences
                } = update

                if (!id) {
                    return
                }

                global.store.presences[
                    id
                ] =
                    global.store
                        .presences[
                        id
                    ] || {}

                Object.assign(
                    global.store
                        .presences[
                        id
                    ],
                    presences
                )

            } catch (e) {

                console.error(
                    '[PRESENCE ERROR]',
                    e
                )
            }
        }
    )

    if (
        global._cronReset
    ) {

        global._cronReset.stop()
    }

    global._cronReset =
        cron.schedule(
            '00 00 * * *',

            async () => {

                try {

                    cmdDel(
                        global.db.hit
                    )

                    const users =
                        Object.keys(
                            global.db
                                .users ||
                                {}
                        )

                    const botNumber =
                        await axly.decodeJid(
                            axly.user.id
                        )

                    for (const jid of users) {

                        const limitUser =
                            global.db
                                .users[
                                jid
                            ]?.vip
                                ? global
                                      .limit
                                      .vip
                                : checkStatus(
                                        jid,
                                        global
                                            .db
                                            .premium
                                  )
                                ? global
                                      .limit
                                      .premium
                                : global
                                      .limit
                                      .free

                        if (
                            global.db
                                .users[
                                jid
                            ]
                                .limit <
                            limitUser
                        ) {

                            global.db.users[
                                jid
                            ].limit =
                                limitUser
                        }
                    }

                    if (
                        global.db?.set?.[
                            botNumber
                        ]?.autobackup
                    ) {

                        let file =
                            './database/' +
                            global.tempatDB

                        if (
                            global.tempatDB.startsWith(
                                'mongodb'
                            )
                        ) {

                            file =
                                './database/backup_database.json'

                            fs.writeFileSync(
                                file,

                                JSON.stringify(
                                    global.db,
                                    null,
                                    2
                                ),

                                'utf-8'
                            )
                        }

                        for (const owner of ownerNumber) {

                            try {

                                await axly.sendMessage(
                                    owner,
                                    {
                                        document:
                                            fs.readFileSync(
                                                file
                                            ),

                                        mimetype:
                                            'application/json',

                                        fileName:
                                            `${Date.now()}_database.json`
                                    }
                                )

                            } catch {}
                        }
                    }

                } catch (e) {

                    console.error(
                        '[CRON ERROR]',
                        e
                    )
                }
            },

            {
                scheduled: true,
                timezone:
                    global.timezone
            }
        )

    if (
        global.intervalSholat
    ) {
        clearInterval(
            global.intervalSholat
        )
    }

    global.waktusholat =
        global.waktusholat ||
        {}

    sholatTimeout =
        setTimeout(() => {

            global.intervalSholat =
                global.safeInterval(
                    async () => {

                        try {

                            const now =
                                moment.tz(
                                    global.timezone
                                )

                            const jam =
                                now.format(
                                    'HH:mm'
                                )

                            const hari =
                                now.format(
                                    'YYYY-MM-DD'
                                )

                            const detik =
                                now.format(
                                    'ss'
                                )

                            if (
                                detik !==
                                '00'
                            ) {
                                return
                            }

                            for (const [
                                sholat,
                                waktu
                            ] of Object.entries(
                                global.jadwalSholat ||
                                    {}
                            )) {

                                if (
                                    jam ===
                                        waktu &&
                                    global.waktusholat[
                                        sholat
                                    ] !==
                                        hari
                                ) {

                                    global.waktusholat[
                                        sholat
                                    ] =
                                        hari

                                    for (const [
                                        idnya,
                                        settings
                                    ] of Object.entries(
                                        global
                                            .db
                                            .groups ||
                                            {}
                                    )) {

                                        if (
                                            !settings.waktusholat
                                        ) {
                                            continue
                                        }

                                        await axly.sendMessage(
                                            idnya,
                                            {
                                                text:
`Waktu *${sholat}* telah tiba.\n\n${waktu}`
                                            }
                                        ).catch(
                                            () =>
                                                {}
                                        )
                                    }
                                }
                            }

                        } catch (e) {

                            console.error(
                                '[SHOLAT ERROR]',
                                e
                            )
                        }

                    },

                    60000
                )

        }, time_end)
        if (
        global._dbPresence
    ) {
        clearInterval(
            global._dbPresence
        )
    }

    global._dbPresence =
        global.safeInterval(
            async () => {

                try {

                    if (
                        axly?.user?.id
                    ) {

                        await axly.sendPresenceUpdate(
                            'available',
                            await axly.decodeJid(
                                axly.user.id
                            )
                        )
                    }

                } catch (e) {

                    console.error(
                        '[PRESENCE INTERVAL ERROR]',
                        e
                    )
                }

            },

            10 *
                60 *
                1000
        )

    return axly
}

startaxlyBot()

process.on(
    'beforeExit',
    async () => {

        try {

            if (
                global.db
            ) {
                await database.write(
                    global.db
                )
            }

            if (
                global.store
            ) {
                await storeDB.write(
                    global.store
                )
            }

        } catch (e) {

            console.error(
                '[BEFORE EXIT ERROR]',
                e
            )
        }
    }
)

process.on(
    'SIGINT',

    async () => {

        console.log(
            chalk.red(
                'SIGINT'
            )
        )

        await cleanup(
            'SIGINT'
        )

        process.exit(0)
    }
)

process.on(
    'SIGTERM',

    async () => {

        console.log(
            chalk.red(
                'SIGTERM'
            )
        )

        await cleanup(
            'SIGTERM'
        )

        process.exit(0)
    }
)

process.on('uncaughtException', (err) => {
    console.error(chalk.red('[UNCAUGHT]'), err?.message || err)
    // GAK USAH RESTART
})

process.on('unhandledRejection', (reason) => {
    console.error(chalk.red('[UNHANDLED]'), reason?.message || reason)
    // GAK USAH RESTART
})

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.log(chalk.yellow(`Port ${PORT} already in use`))
        return
    }
    console.error(chalk.red('[SERVER ERROR]'), error?.message || error)
    // GAK USAH RESTART
})

process.on(
    'warning',

    (warning) => {

        if (
            warning.name ===
            'MaxListenersExceededWarning'
        ) {

            console.log(
                chalk.yellow(
                    '[WARNING] MaxListenersExceeded'
                )
            )

            return
        }

        console.warn(
            warning
        )
    }
)

export {
    startaxlyBot
}