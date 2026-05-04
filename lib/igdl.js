case 'ig': case 'instagram': case 'instadl': case 'igdown': case 'igdl': {
    if (!isLimit) return m.reply(global.mess.limit)
    if (!text) return m.reply(`Example: ${prefix + command} url_instagram`)
    if (!text.includes('instagram.com')) return m.reply('Url Tidak Mengandung Result Dari Instagram!')
    m.react('⏳')
    try {
        const result = await igdl(text)
        if (result.status && result.result && result.result.downloadUrl && result.result.downloadUrl.length > 0) {
            const urls = result.result.downloadUrl
            const caption = `✅ *Download Berhasil*\n📁 Source: ${result.source || 'igdl'}`
            if (urls.length > 1) {
                // Kirim album
                const album = urls.map(url => {
                    // Cek ekstensi atau asumsi video jika mengandung keyword tertentu
                    const isVideo = url.includes('.mp4') || url.includes('/video/') || url.match(/\.(mp4|m3u8)/i)
                    return isVideo ? { video: { url } } : { image: { url } }
                })
                await naze.sendAlbumMessage(m.chat, { album, caption }, { quoted: m })
            } else {
                const url = urls[0]
                const isVideo = url.includes('.mp4') || url.includes('/video/') || url.match(/\.(mp4|m3u8)/i)
                if (isVideo) {
                    await m.reply({ video: { url }, caption })
                } else {
                    await m.reply({ image: { url }, caption })
                }
            }
            setLimit(m, db)
        } else {
            m.reply('Gagal mengambil media. Pastikan URL benar dan postingan tidak private.')
        }
    } catch (e) {
        console.error(e)
        m.reply(global.mess.fail)
    }
}
break
