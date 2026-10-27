/**
 * 重新录 test-look.mjs 用的两段样片（一般不用跑，样片已经在仓库里）：
 *   node test/fixtures/make.mjs
 *
 * black-left.webm：4 秒；前 1.2 秒全黑，之后变色、有个白块在动；440Hz 只在左声道，1.5 秒后没声
 * still.webm：3.5 秒；画面不动（只有角上一个点每帧变一下，免得编码器把一样的帧丢掉），没声轨
 * 在无头 Chrome / Edge 里用 MediaRecorder 录（慢机器上录出来可能变短、变黑，所以不在测试里现录）。
 */
import fs from 'node:fs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { findBrowser, createBrowser } from '../../lib/browser.js'

const bin = findBrowser()
if (!bin) { console.log('没找到 Chrome / Edge'); process.exit(1) }
{
  // 录样片要在页面里出声：放开自动播放限制（插件自己不需要，它只解码不播放）
  const launch = (b, args, o) => spawn(b, ['--autoplay-policy=no-user-gesture-required', ...args], o)
  const b = createBrowser({ bin, launch })
  const gen = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><body>') })
  await new Promise((ok) => gen.listen(0, '127.0.0.1', ok))
  const genUrl = `http://127.0.0.1:${gen.address().port}/`
  /**
   * 在页面里录一段：画布（每 33ms 画一帧，手动推帧，无头也录得上）+ 可选的声音。
   * blackUntil 秒之前画黑的；still 画面一直不变；tone 'left' 只给左声道，toneUntil 秒后静音；noAudio 不要声轨
   */
  const record = (o) => b.withPage({ url: genUrl, w: 400, h: 300 }, (p) => p.eval(`(async () => {
    const o = ${JSON.stringify(o)}
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; document.body.append(c)
    const g = c.getContext('2d')
    const vt = c.captureStream(0).getVideoTracks()[0]
    const tracks = [vt]
    let ac = null
    if (!o.noAudio) {
      ac = new AudioContext(); await ac.resume()
      const osc = ac.createOscillator(); osc.frequency.value = 440
      const gain = ac.createGain(); gain.gain.value = 0.3
      gain.gain.setValueAtTime(0, ac.currentTime + o.toneUntil)
      const merge = ac.createChannelMerger(2)
      osc.connect(gain); gain.connect(merge, 0, 0)
      const dest = ac.createMediaStreamDestination(); dest.channelCount = 2
      merge.connect(dest); osc.start()
      tracks.push(...dest.stream.getAudioTracks())
    }
    const type = MediaRecorder.isTypeSupported(o.type) ? o.type : 'video/webm'
    const r = new MediaRecorder(new MediaStream(tracks), { mimeType: type })
    const parts = []; r.ondataavailable = (e) => parts.push(e.data)
    const t0 = performance.now()
    const draw = () => {
      const t = (performance.now() - t0) / 1000
      // 「不动」的画面也让角上一个点每帧变一下：一模一样的帧编码器可能直接丢掉，录出来只剩一帧
      if (o.still) { g.fillStyle = '#3366cc'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '30px sans-serif'; g.fillText('STILL', 20, 100); g.fillStyle = Math.round(t * 30) % 2 ? '#3366cd' : '#3367cc'; g.fillRect(319, 179, 1, 1) }
      else if (t < o.blackUntil) { g.fillStyle = '#000'; g.fillRect(0, 0, 320, 180) }
      else { g.fillStyle = 'hsl(' + Math.round(t * 120) + ',70%,50%)'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.fillRect((t * 80) % 320, 60, 40, 60) }
      vt.requestFrame()
    }
    draw(); r.start(); const iv = setInterval(draw, 33)
    await new Promise((ok) => setTimeout(ok, o.seconds * 1000))
    r.stop(); clearInterval(iv); await new Promise((ok) => (r.onstop = ok)); if (ac) ac.close()
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer())
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
    return { type, b64: btoa(s) }
  })()`))
  try {
    const a = await record({ seconds: 4, blackUntil: 1.2, toneUntil: 1.5, type: 'video/webm;codecs=vp8,opus' })
    const still = await record({ seconds: 3.5, still: true, noAudio: true, type: 'video/webm;codecs=vp8' })
    for (const [name, r] of [['black-left.webm', a], ['still.webm', still]]) {
      const f = new URL(`./${name}`, import.meta.url)
      fs.writeFileSync(f, Buffer.from(r.b64, 'base64'))
      console.log(name, r.type, fs.statSync(f).size, 'bytes')
    }
  } finally {
    b.destroy()
    gen.close()
  }
}
