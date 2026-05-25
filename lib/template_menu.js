import '../settings.js';
import fs from 'fs';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import moment from 'moment-timezone';
import { pickRandom } from './function.js';

const __filename = fileURLToPath(import.meta.url);

async function setTemplateMenu(axly, type, m, prefix, setv, db, options = {}) {
    let total = Object.entries(db.hit).sort((a, b) => b[1] - a[1]).slice(0, Math.min(7, Object.keys(db.hit).length)).filter(([command]) => command !== 'totalcmd' && command !== 'todaycmd').slice(0, 5);
    
    let topMenu = ''
    if (total && total.length >= 5) {
        total.forEach(([command, hit]) => {
            topMenu += `> ${setv} ${prefix}${command}: ${hit} hits\n`
        })
    } else {
        topMenu = `> ${setv} ${prefix}ai\n> ${setv} ${prefix}brat\n> ${setv} ${prefix}tiktok\n> ${setv} ${prefix}cekmati\n> ${setv} ${prefix}susunkata\n`
    }

    const menunya = `
~_*INFORMATION*_
> Halo users! Ketik .request untuk request
> fitur atau melaporkan masalah eror
> _kalo gw ga males gw tanggepin_ <
> ᴀᴘɪ ʙᴏᴛ : axlyapii.onrender.com

*ɪɴꜰᴏ ᴘᴇɴɢɢᴜɴᴀ*
> ɴᴀᴍᴀ: ${m.pushName || 'Tanpa Nama'}
> ɪᴅ: @${m.sender.split('@')[0]}
> ꜱᴛᴀᴛᴜꜱ: ${options.isVip ? 'VIP' : options.isPremium ? 'PREMIUM' : 'FREE'}
> ʟɪᴍɪᴛ: ${options.isVip ? '∞' : db.users[m.sender]?.limit || 0}
> ᴜᴀɴɢ: ${db.users[m.sender]?.money?.toLocaleString('id-ID') || '0'}

*ɪɴꜰᴏ ʙᴏᴛ*
> ɴᴀᴍᴀ: ${db?.set?.[options.botNumber]?.botname || 'Axly Bot'}
> ᴍᴏᴅᴇ: ${axly.public ? 'Public' : 'Self'}
> ᴘʀᴇꜰɪx: ${db.set[options.botNumber]?.multiprefix ? 'Multi' : prefix}

*ᴀʙᴏᴜᴛ*
> ᴅᴀᴛᴇ: ${options.date}
> ᴅᴀʏ: ${options.locale_day}
> ᴛɪᴍᴇ: ${options.date_time}

*ᴛᴏᴘ ᴍᴇɴᴜ*
${topMenu}
> _sɪʟᴀʜᴋᴀɴ ᴛᴇᴋᴀɴ ᴛᴏᴍʙᴏʟ ᴅɪ ʙᴀᴡᴀʜ ᴜɴᴛᴜᴋ ᴍᴇᴍɪʟɪʜ ᴄᴀᴛᴇʜᴏʀʏ_
`;

    if (type == 1 || type == 'buttonMessage') {
        await axly.sendButtonMsg(m.chat, {
            text: `Halo @${m.sender.split('@')[0]}\n\n${topMenu}`,
            footer: 'Klik tombol di bawah untuk melihat semua menu',
            mentions: [m.sender],
            buttons: [
                { buttonId: `${prefix}allmenu`, buttonText: { displayText: '📋 All Menu' }, type: 1 },
                { buttonId: `${prefix}sc`, buttonText: { displayText: '📂 Script' }, type: 1 }
            ]
        }, { quoted: m })
        
    } else if (type == 2 || type == 'listMessage') {
        await axly.sendButtonMsg(m.chat, {
            text: `Halo @${m.sender.split('@')[0]}\n\n${topMenu}`,
            footer: 'Klik tombol di bawah untuk melihat semua menu',
            mentions: [m.sender],
            buttons: [
                { buttonId: `${prefix}allmenu`, buttonText: { displayText: '📋 All Menu' }, type: 1 },
                { buttonId: `${prefix}sc`, buttonText: { displayText: '📂 Script' }, type: 1 }
            ]
        }, { quoted: m })
        
    } else if (type == 3 || type == 'documentMessage') {
        await axly.sendButtonMsg(m.chat, {
            image: { url: 'https://files.catbox.moe/j89j08.jpg' },
            caption: menunya,
            footer: '© AxlyAssistant',
            buttons: [
                { buttonId: `${prefix}allmenu`, buttonText: { displayText: 'ALL MENU' }, type: 1 }
            ]
        }, { quoted: m })
        
    } else if (type == 4 || type == 'videoMessage') {
        // tambahin sendiri
    } else {
        m.reply(`${options.ucapanWaktu} @${m.sender.split('@')[0]}\nSilahkan Gunakan ${prefix}allmenu\nUntuk Melihat Semua Menunya`)
    }
}

export default setTemplateMenu;

fs.watchFile(__filename, async () => {
    fs.unwatchFile(__filename)
    console.log(chalk.yellowBright(`[UPDATE] ${__filename}`))
    await import(`${import.meta.url}?update=${Date.now()}`)
});