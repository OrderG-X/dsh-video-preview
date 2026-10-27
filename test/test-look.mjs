/**
 * look_video 的测试（不用开 DSH）：
 *   node test/test-look.mjs
 *
 * 纯函数：时间、取帧时间点、拼图排法、没声的段、声音 / 画面的问题、给模型的字。
 * probe：手搓 MP4 盒子，读编码、时长、旋转、文件头位置，手机能不能播。
 * 临时服务：只收本机、口令不对 404、能分段读。
 * 真浏览器（电脑上有 Chrome / Edge 时）：在无头浏览器里现录两段视频（开头黑屏、只有左声道、结尾没声；画面不动、没声轨），
 * 再用 look_video 看，问题都要说出来。HOME 指到临时目录，不碰你自己的文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvp-look-'))
// 浏览器要用真的用户目录：Windows 上 USERPROFILE 指到临时目录时，Chrome / Edge 连不上管道
const realEnv = { ...process.env }
process.env.HOME = process.env.USERPROFILE = tmp

const { parseTime, fmtTime, frameCount, pickTimes, sheetLayout, silences, audioFindings, frameFindings, formatLook, inspect, MAX_FRAMES } = await import(new URL('../lib/look.js', import.meta.url))
const { probeFile, compatOf, videoName, audioName } = await import(new URL('../lib/probe.js', import.meta.url))
const { lookTool, serveOne } = await import(new URL('../lib/index.js', import.meta.url))
const { findBrowser, createBrowser } = await import(new URL('../lib/browser.js', import.meta.url))

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✓ ${name}`) } else { fail++; console.log(`✗ ${name} ${extra}`) }
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────

check('时间：1:23、1:23.5、83、83s、1:02:03 都认', parseTime('1:23') === 83 && parseTime('1:23.5') === 83.5 && parseTime('83') === 83 && parseTime('83s') === 83 && parseTime('1:02:03') === 3723 && parseTime(12) === 12)
check('时间：认不出的是 NaN', [parseTime('abc'), parseTime('-3'), parseTime('1:2:3:4'), parseTime(''), parseTime(null)].every(Number.isNaN))
check('时间显示：长的整秒、短的带一位小数', fmtTime(83) === '1:23' && fmtTime(3723) === '1:02:03' && fmtTime(5.46, true) === '0:05.5' && fmtTime(12.04, true) === '0:12.0')
check('默认帧数随长短变', frameCount(2) === 4 && frameCount(8) === 6 && frameCount(40) === 9 && frameCount(600) === 12)
{
  const t = pickTimes(10)
  check('均匀取帧：头一帧是 0，最后一帧离结尾不到 0.1 秒', t.length === 6 && t[0] === 0 && t[5] > 9.85 && t[5] < 10, JSON.stringify(t))
  const r = pickTimes(100, { from: 30, to: 40, frames: 3 })
  check('只看一段：在 from–to 里取', r.length === 3 && r[0] === 30 && r[2] < 40 && r[2] > 39.8 && r[1] > 34.9 && r[1] < 35, JSON.stringify(r))
  check('帧数封顶', pickTimes(100, { frames: 99 }).length === MAX_FRAMES)
  check('只取一帧 / 片子太短', pickTimes(5, { frames: 1 }).join() === '0' && pickTimes(0).join() === '0')
}
{
  const land = sheetLayout(1920, 1080, 9)
  const port = sheetLayout(1080, 1920, 9)
  const rows = (l, n) => Math.ceil(n / l.cols)
  check('拼图：横屏 9 帧 3 列', land.cols === 3 && land.cw > 400 && Math.abs(land.ch / land.cw - 1080 / 1920) < 0.01)
  check('拼图：竖屏 9 帧 5 列，整张高不超过 1568', port.cols === 5 && rows(port, 9) * port.ch + (rows(port, 9) + 1) * port.gap <= 1568, JSON.stringify(port))
  check('拼图：4 帧 2 列', sheetLayout(1280, 720, 4).cols === 2)
}

const win = (spec) => spec.flatMap(([db, sec]) => Array(Math.round(sec * 10)).fill(db))
check('没声的段：只算 1.5 秒以上的', JSON.stringify(silences(win([[-80, 2], [-20, 3], [-80, 1], [-20, 2], [-80, 3]]))) === '[[0,2],[8,11]]')
{
  const per = (rms, peak = rms * 1.4, clip = 0) => ({ rms, peak, clip })
  const a = { duration: 12, channels: 2, samples: 192000, per: [per(0.1), per(0.1)], win: win([[-80, 2], [-20, 4], [-80, 3.5], [-20, 1.5], [-80, 1]]) }
  const f = audioFindings(a, { duration: 12, short: true })
  check('声音：开头、中间（3 秒以上）的没声都报，结尾 1 秒不报', f.issues.some((x) => x.text.startsWith('开头 0:00.0–0:02.0 没声音')) && f.issues.some((x) => x.text.includes('0:06.0–0:09.5 没声音')) && !f.issues.some((x) => x.text.startsWith('结尾')), JSON.stringify(f.issues))
  check('声音：概况写声道、平均和最大', /立体声，有声的部分平均 -20 dB，最大 -17\.1 dB/.test(f.summary), f.summary)
  const silent = audioFindings({ ...a, per: [per(0.0001), per(0.0001)], win: win([[-90, 12]]) })
  check('声音：整段几乎没声 → 严重', silent.issues.length === 1 && silent.issues[0].level === 'bad' && /几乎没有声音/.test(silent.issues[0].text))
  const left = audioFindings({ ...a, per: [per(0.1), per(0.00001)], win: win([[-20, 12]]) })
  check('声音：只有左声道', left.issues.some((x) => /只有左声道/.test(x.text)) && !left.issues.some((x) => /右声道有声音/.test(x.text)))
  const right = audioFindings({ ...a, per: [per(0.00001), per(0.1)], win: win([[-20, 12]]) })
  check('声音：只有右声道', right.issues.some((x) => /只有右声道/.test(x.text)))
  const clip = audioFindings({ ...a, per: [per(0.5, 1, 2000), per(0.5, 1, 2000)], win: win([[-6, 12]]) })
  check('声音：削波超过 0.1% 报爆音', clip.issues.some((x) => x.level === 'bad' && /爆音/.test(x.text)))
  const quiet = audioFindings({ ...a, per: [per(0.008), per(0.008)], win: win([[-42, 12]]) })
  check('声音：太小', quiet.issues.some((x) => /声音偏小/.test(x.text)))
  const tail = audioFindings({ ...a, win: win([[-20, 9], [-80, 3]]) })
  check('声音：结尾没声', tail.issues.some((x) => x.text.startsWith('结尾 0:09–0:12 没声音')), JSON.stringify(tail.issues))
}
{
  const fp = (v) => Array(144).fill(v)
  const fr = (t, y, sd = 30, f = fp(y), ok = true, lit = y <= 16 ? 0 : 900) => ({ t, y, sd, lit, fp: f, ok })
  const black = frameFindings([fr(0, 2, 1), fr(2, 120), fr(4, 3, 2), fr(6, 140), fr(8, 1, 0)], { duration: 8.1 })
  check('画面：第一帧黑、中间黑、最后一帧黑分开说', black.some((x) => /第一帧（0:00）是黑的/.test(x.text)) && black.some((x) => /这几刻是黑屏：0:04/.test(x.text)) && black.some((x) => /最后一帧（0:08）是黑的/.test(x.text)), JSON.stringify(black))
  const all = frameFindings([fr(0, 2, 1), fr(2, 3, 1), fr(4, 1, 0)], { duration: 5 })
  check('画面：全黑 → 严重，只说这一条', all.length === 1 && all[0].level === 'bad' && /全是黑的/.test(all[0].text))
  const still = frameFindings([0, 1, 2, 3].map((t) => fr(t, 100)), { duration: 4 })
  check('画面：几帧一模一样 → 可能没动', still.some((x) => /几乎一模一样/.test(x.text)))
  const run = frameFindings([fr(0, 10, 30, fp(10)), ...[1, 2, 3, 4, 5].map((t) => fr(t, 100)), fr(6, 200, 30, fp(200))], { duration: 6 })
  check('画面：中间一大段没变', run.some((x) => /0:01–0:05 画面没变（5 帧一样）/.test(x.text)), JSON.stringify(run))
  const moving = frameFindings([0, 1, 2, 3].map((t) => fr(t, 50 + t * 40, 30, fp(50 + t * 40))), { duration: 4 })
  check('画面：在动、不黑 → 没问题', moving.length === 0)
  const bad = frameFindings([fr(0, 100), fr(1, 120, 30, fp(120), false)], { duration: 2 })
  check('画面：跳不过去的帧说出来', bad.some((x) => /1 帧跳不过去（0:01）/.test(x.text)))
  const title = frameFindings([fr(0, 2, 10, fp(2), true, 12.5), fr(2, 120), fr(4, 140)], { duration: 5 })
  check('画面：黑底上有字（片头字幕）不算黑屏', title.length === 0, JSON.stringify(title))
  const cursor = frameFindings([fr(0, 1, 2, fp(1), true, 0.2), fr(2, 120), fr(4, 140)], { duration: 5 })
  check('画面：黑屏上只有鼠标指针还算黑', cursor.some((x) => /第一帧/.test(x.text)))
  const big = frameFindings([fr(3, 2, 1)], { duration: 10, sheet: false })
  check('画面：看大图时黑的那刻算「黑屏」，不说封面', big.length === 1 && /这几刻是黑屏：0:03/.test(big[0].text))
}

// ── probe：手搓 MP4 ─────────────────────────────────────────────────────────

const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
  const h = Buffer.alloc(8)
  h.writeUInt32BE(8 + body.length)
  h.write(type, 4, 'latin1')
  return Buffer.concat([h, body])
}
const u32 = (...n) => { const b = Buffer.alloc(4 * n.length); n.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b }
const u16 = (...n) => { const b = Buffer.alloc(2 * n.length); n.forEach((x, i) => b.writeUInt16BE(x, i * 2)); return b }
const z = (n) => Buffer.alloc(n)
const MATRIX = { 0: u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000), 90: u32(0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000) }

function vtrak({ tag = 'avc1', profile = 100, w = 1920, h = 1080, rotate = 0, frames = 150 } = {}) {
  const cfg = tag.startsWith('avc') ? box('avcC', Buffer.from([1, profile, 0, 40, 0xff, 0xe0])) : tag.startsWith('hv') ? box('hvcC', Buffer.from([1, profile, 0, 0])) : z(0)
  const entry = box(tag, z(6), u16(1), z(16), u16(w, h), u32(0x480000, 0x480000, 0), u16(1), z(32), u16(24, 0xffff), cfg)
  return box('trak',
    box('tkhd', u32(0, 0, 0, 1, 0, 5000), z(16), MATRIX[rotate], u32(w << 16, h << 16)),
    box('mdia',
      box('mdhd', u32(0, 0, 0, 30000, 150000), z(4)),
      box('hdlr', u32(0, 0), 'vide', z(12), 'v\0'),
      box('minf', box('stbl', box('stsd', u32(0, 1), entry), box('stts', u32(0, 1, frames, 1000))))))
}
function atrak({ tag = 'mp4a', oti = 0x40, channels = 2 } = {}) {
  const esds = box('esds', Buffer.from([0, 0, 0, 0, 0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x11, 0x90, 0x06, 0x01, 0x02]))
  const entry = box(tag, z(6), u16(1), u16(0, 0), u32(0), u16(channels, 16), u16(0, 0), u32(48000 * 65536), tag === 'mp4a' ? esds : z(0))
  return box('trak',
    box('tkhd', u32(0, 0, 0, 2, 0, 5000), z(16), MATRIX[0], u32(0, 0)),
    box('mdia',
      box('mdhd', u32(0, 0, 0, 48000, 240000), z(4)),
      box('hdlr', u32(0, 0), 'soun', z(12), 'a\0'),
      box('minf', box('stbl', box('stsd', u32(0, 1), entry)))))
}
const mvhd = box('mvhd', u32(0, 0, 0, 1000, 5000), z(80))
const ftyp = (brand = 'isom') => box('ftyp', brand, u32(512), 'isomiso2avc1mp41')
function mp4(name, parts) {
  const f = path.join(tmp, name)
  fs.writeFileSync(f, Buffer.concat(parts))
  return f
}
{
  const p = await probeFile(mp4('a.mp4', [ftyp(), box('moov', mvhd, vtrak(), atrak()), box('mdat', z(64))]))
  check('probe：时长、画面、帧率、编码、文件头在前', p.duration === 5 && p.video.w === 1920 && p.video.dw === 1920 && p.video.fps === 30 && p.video.frames === 150 && p.faststart && !p.fragmented && videoName(p.video) === 'H.264 High' && audioName(p.audio) === 'AAC' && p.audio.channels === 2 && p.audio.rate === 48000, JSON.stringify(p))
  check('probe：H.264 High + AAC、文件头在前 → 没有手机问题', compatOf(p).length === 0)
  const late = await probeFile(mp4('late.mp4', [ftyp(), box('mdat', z(3 << 20)), box('moov', mvhd, vtrak(), atrak())]))
  check('probe：文件头在末尾 → 提示 faststart', !late.faststart && compatOf(late).some((x) => /faststart/.test(x.text)))
  const p444 = await probeFile(mp4('444.mp4', [ftyp(), box('moov', mvhd, vtrak({ profile: 244 }), atrak())]))
  check('probe：H.264 4:4:4 → 严重，给 -pix_fmt yuv420p', videoName(p444.video) === 'H.264 High 4:4:4' && compatOf(p444).some((x) => x.level === 'bad' && /yuv420p/.test(x.text)))
  const hev1 = await probeFile(mp4('hev1.mp4', [ftyp(), box('moov', mvhd, vtrak({ tag: 'hev1', profile: 1 }), atrak())]))
  check('probe：HEVC hev1 → 严重，给 -tag:v hvc1', compatOf(hev1).some((x) => x.level === 'bad' && /-tag:v hvc1/.test(x.text)))
  const hvc1 = await probeFile(mp4('hvc1.mov', [ftyp('qt  '), box('moov', mvhd, vtrak({ tag: 'hvc1', profile: 2 }), atrak())]))
  check('probe：MOV + HEVC Main 10 hvc1 → 提醒（不算严重）', hvc1.container === 'mov' && videoName(hvc1.video) === 'HEVC Main 10' && compatOf(hvc1).every((x) => x.level === 'warn'))
  const mp4v = await probeFile(mp4('mp4v.mp4', [ftyp(), box('moov', mvhd, vtrak({ tag: 'mp4v' }), atrak({ tag: 'ac-3' }))]))
  const c = compatOf(mp4v)
  check('probe：老编码 mp4v、AC-3 声音 → 都严重', c.filter((x) => x.level === 'bad').length === 2 && /MPEG-4 Part 2/.test(c[0].text) && /AC-3/.test(c[1].text), JSON.stringify(c))
  const mp3 = await probeFile(mp4('mp3.mp4', [ftyp(), box('moov', mvhd, vtrak(), atrak({ oti: 0x6b }))]))
  check('probe：mp4a 里装的是 MP3', audioName(mp3.audio) === 'MP3')
  const rot = await probeFile(mp4('rot.mp4', [ftyp(), box('moov', mvhd, vtrak({ rotate: 90, w: 1920, h: 1080 }))]))
  check('probe：旋转 90°、没有声轨', rot.video.rotate === 90 && rot.audio === null)
  // HDR：colr nclx 传输特性 18（HLG）；杜比视界：hvc1 里带 dvcC
  const colr = (trc, full = 0) => box('colr', 'nclx', u16(9, trc, 9), Buffer.from([full]))
  const vtrakC = (o, ...extra) => {
    const t = vtrak(o)
    const i = t.indexOf(Buffer.from(o.tag === 'avc1' || !o.tag ? 'avcC' : 'hvcC')) - 4
    const cfgLen = t.readUInt32BE(i)
    const add = Buffer.concat(extra)
    const out = Buffer.concat([t.subarray(0, i + cfgLen), add, t.subarray(i + cfgLen)])
    // 改大外面一层层盒子的长度：trak、mdia、minf、stbl、stsd、样本项
    for (const name of ['trak', 'mdia', 'minf', 'stbl', 'stsd', o.tag || 'avc1']) {
      const j = out.indexOf(Buffer.from(name)) - 4
      out.writeUInt32BE(out.readUInt32BE(j) + add.length, j)
    }
    return out
  }
  const hlg = await probeFile(mp4('hlg.mov', [ftyp('qt  '), box('moov', mvhd, vtrakC({ tag: 'hvc1', profile: 2 }, colr(18)), atrak())]))
  check('probe：HLG 的 HDR → 名字带 HDR、提醒发灰', videoName(hlg.video) === 'HEVC Main 10 HDR（HLG）' && compatOf(hlg).some((x) => x.level === 'warn' && /HDR 视频（HLG）/.test(x.text)), JSON.stringify(hlg && hlg.video))
  const dv = await probeFile(mp4('dv.mov', [ftyp('qt  '), box('moov', mvhd, vtrakC({ tag: 'hvc1', profile: 2 }, box('dvcC', z(24)), colr(18)), atrak())]))
  check('probe：带 dvcC → 杜比视界', dv.video.hdr === '杜比视界' && /杜比视界/.test(videoName(dv.video)))
  const sdr = await probeFile(mp4('sdr.mp4', [ftyp(), box('moov', mvhd, vtrakC({ tag: 'avc1' }, colr(1, 0x80)), atrak())]))
  check('probe：普通 BT.709（全范围）不报 HDR', !sdr.video.hdr && sdr.video.color.full === true && compatOf(sdr).length === 0, JSON.stringify(sdr.video))
  const dvh1 = await probeFile(mp4('dvh1.mp4', [ftyp(), box('moov', mvhd, vtrak({ tag: 'dvh1', profile: 2 }), atrak())]))
  check('probe：dvh1 按 HEVC 算（提醒，不说放不了）', compatOf(dvh1).every((x) => x.level === 'warn') && compatOf(dvh1).some((x) => /HEVC：/.test(x.text)), JSON.stringify(compatOf(dvh1)))
  const big = await probeFile(mp4('8k.mp4', [ftyp(), box('moov', mvhd, vtrak({ w: 7680, h: 4320 }), atrak())]))
  check('probe：8K → 提醒超过 4K', compatOf(big).some((x) => /超过 4K/.test(x.text)))
  const nomoov = await probeFile(mp4('cut.mp4', [ftyp(), box('mdat', z(64))]))
  check('probe：没有 moov（没录完）→ 严重', nomoov.noMoov && compatOf(nomoov).some((x) => x.level === 'bad' && /没录完/.test(x.text)))
  // 64 位长度的盒子
  const large = Buffer.concat([u32(1), Buffer.from('free'), u32(0, 16)])
  const p64 = await probeFile(mp4('large.mp4', [ftyp(), large, box('moov', mvhd, vtrak(), atrak())]))
  check('probe：认 64 位长度的盒子', p64 && p64.video && p64.duration === 5)
  // 版本 1 的 mvhd（64 位时长）
  const mvhd1 = box('mvhd', Buffer.from([1, 0, 0, 0]), z(16), u32(1000), u32(0, 7000), z(80))
  const v1 = await probeFile(mp4('v1.mp4', [ftyp(), box('moov', mvhd1, vtrak())]))
  check('probe：版本 1 的 mvhd', v1.duration === 7, JSON.stringify(v1 && v1.duration))
  const webm = path.join(tmp, 'a.webm')
  fs.writeFileSync(webm, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]))
  check('probe：不是 MP4 一类 → null', (await probeFile(webm)) === null)
}

// ── 给模型的字（不开浏览器） ──────────────────────────────────────────────────

{
  const probe = await probeFile(path.join(tmp, 'rot.mp4'))
  const t = formatLook({ name: 'rot.mp4', size: '1 KB', probe, res: null, kind: 'video', ext: '.mp4' })
  check('字：没开浏览器时也给文件头信息、说没有声轨', /看了 rot\.mp4（1920×1080，0:05，30 fps，H\.264 High，1 KB）/.test(t) && /没有声轨/.test(t), t)
  const res = { info: { duration: 5, w: 1920, h: 1080 }, times: [0, 2.5, 4.9], sheet: true, jpgs: ['x'], stats: [], audio: null }
  const t2 = formatLook({ name: 'a.webm', size: '1 KB', probe: null, res, kind: 'video', ext: '.webm', images: 0, files: ['/tmp/x.jpg'] })
  check('字：拼图说明、附件库用不了时写文件位置、WebM 提醒', /图 1：3 帧，从 0:00\.0 到 0:04\.9/.test(t2) && t2.includes('/tmp/x.jpg') && /WebM/.test(t2) && /at: \["0:02\.5"\]/.test(t2), t2)
  const t3 = formatLook({ name: 'a.mp4', size: '1 KB', probe: await probeFile(path.join(tmp, 'a.mp4')), res: { ...res, audio: { failed: true, error: 'x timeout' } }, kind: 'video', ext: '.mp4', images: 1 })
  check('字：声音没量成单独说', /声音：没量成（x timeout）/.test(t3), t3)
  const t4 = formatLook({ name: 'a.mp4', size: '1 KB', probe: await probeFile(path.join(tmp, 'a.mp4')), res: { ...res, info: { error: 4 } }, kind: 'video', ext: '.mp4' })
  check('字：浏览器打不开说原因', /浏览器打不开：浏览器不支持这个格式或编码/.test(t4), t4)
}

// ── 工具：不开浏览器的几条路 ─────────────────────────────────────────────────

{
  const tool = lookTool({ get: () => undefined }, () => ({ available: () => false }))
  const avi = path.join(tmp, 'old.avi')
  fs.writeFileSync(avi, 'x')
  check('工具：avi 给转码命令', /ffmpeg -i/.test((await tool.execute({ path: avi }, {})).text))
  check('工具：时间写错说清楚', /认不出时间/.test((await tool.execute({ path: path.join(tmp, 'a.mp4'), at: ['abc'] }, {})).text))
  check('工具：to 早于 from', /要比 from/.test((await tool.execute({ path: path.join(tmp, 'a.mp4'), from: '0:10', to: '0:05' }, {})).text))
  const nb = await tool.execute({ path: path.join(tmp, 'a.mp4') }, {})
  check('工具：没有 Chrome / Edge → 只给文件头信息并说明', /没找到 Chrome \/ Edge/.test(nb.text) && /H\.264 High \+ AAC/.test(nb.text) && !nb.images, nb.text)
  let threw = ''
  try { await tool.execute({ path: path.join(tmp, 'nope.mp4') }, {}) } catch (e) { threw = e.message }
  check('工具：文件不在 → 报错', /找不到文件/.test(threw))
  const txt = path.join(tmp, 'a.txt')
  fs.writeFileSync(txt, 'x')
  check('工具：不是媒体文件', /不是视频 \/ 音频文件/.test((await tool.execute({ path: txt }, {})).text))
}

// ── 临时服务 ─────────────────────────────────────────────────────────────────

{
  const f = path.join(tmp, 'range.mp4')
  fs.writeFileSync(f, Buffer.from('0123456789'))
  const srv = await serveOne(f)
  const get = (url, headers = {}) => new Promise((ok, no) => {
    http.get(url, { headers }, (res) => { const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => ok({ code: res.statusCode, body: Buffer.concat(parts).toString() })) }).on('error', no)
  })
  const page = await get(srv.page)
  const part = await get(srv.src, { range: 'bytes=2-5' })
  const evil = await get(srv.src, { host: 'evil.example' })
  const wrong = await get(srv.src.replace(/\/[0-9a-f]{32}\//, '/00000000000000000000000000000000/'))
  check('临时服务：页面、分段读（206）', page.code === 200 && part.code === 206 && part.body === '2345')
  check('临时服务：Host 不是本机 403，口令不对 404', evil.code === 403 && wrong.code === 404)
  await srv.close()
  let refused = false
  try { await get(srv.src) } catch { refused = true }
  check('临时服务：看完就关', refused)
}

// ── 真浏览器 ─────────────────────────────────────────────────────────────────

const bin = findBrowser()
if (!bin) {
  console.log('（这台电脑上没有 Chrome / Edge，跳过真浏览器测试）')
} else {
  // 录样片要在页面里出声：放开自动播放限制（插件自己不需要，它只解码不播放）
  const launch = (b, args, o) => spawn(b, ['--autoplay-policy=no-user-gesture-required', ...args], { ...o, env: realEnv })
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
      if (o.still) { g.fillStyle = '#3366cc'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '30px sans-serif'; g.fillText('STILL', 20, 100) }
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
    const t0 = Date.now()
    // 一段一段录：同时录两段时，慢机器上后台页面的计时器会被放慢，录出来的片子变短
    const a = await record({ seconds: 4, blackUntil: 1.2, toneUntil: 1.5, type: 'video/webm;codecs=vp8,opus' })
    const still = await record({ seconds: 3.5, still: true, noAudio: true, type: 'video/webm;codecs=vp8' })
    const fa = path.join(tmp, 'black-left.webm')
    const fs2 = path.join(tmp, 'still.webm')
    fs.writeFileSync(fa, Buffer.from(a.b64, 'base64'))
    fs.writeFileSync(fs2, Buffer.from(still.b64, 'base64'))
    console.log(`  （录两段样片用了 ${Date.now() - t0}ms）`)

    const saved = []
    const ctx = { get: (n) => (n === 'attachments' ? { saveImages: async (list) => list.map((x) => { saved.push(x); return { id: `att-${saved.length}` } }) } : undefined), logger: { warn: () => {} } }
    const tool = lookTool(ctx, () => b)
    const t1 = Date.now()
    const r1 = await tool.execute({ path: fa }, {})
    console.log(`  （look_video 看一段用了 ${Date.now() - t1}ms）`)
    const jpg = saved[0] && saved[0].data
    check('真浏览器：拼图一张、是 JPEG、宽 1536 左右', r1.images && r1.images.length === 1 && jpg[0] === 0xff && jpg[1] === 0xd8 && saved[0].mediaType === 'image/jpeg', r1.text)
    check('真浏览器：时长、尺寸认出来（浏览器录的 webm 不写时长也行）', /320×180，0:04/.test(r1.text), r1.text)
    check('真浏览器：开头黑屏', /第一帧（0:00\.0）是黑的/.test(r1.text), r1.text)
    check('真浏览器：只有左声道', /只有左声道有声音/.test(r1.text), r1.text)
    check('真浏览器：结尾没声音', /结尾 0:0[12]\.\d–0:0[34]\.\d 没声音/.test(r1.text), r1.text)
    check('真浏览器：WebM 的手机提醒', /WebM/.test(r1.text))

    const r2 = await tool.execute({ path: fa, at: ['0:02', '3.5'] }, {})
    check('真浏览器：at 给两刻 → 两张大图，各自说明', r2.images && r2.images.length === 2 && /图 1：0:02\.0 那一刻/.test(r2.text) && /图 2：0:03\.5 那一刻/.test(r2.text), r2.text)
    check('真浏览器：大图里在动的那刻不算黑屏', !/黑/.test(r2.text.split('问题：')[1] || ''), r2.text)
    check('真浏览器：看大图后提示怎么逐帧看', /frames 设成 16/.test(r2.text))

    const r3 = await tool.execute({ path: fs2 }, {})
    check('真浏览器：画面一直不变', /几乎一模一样/.test(r3.text), r3.text)
    check('真浏览器：没声轨（webm 读不了文件头，说「没有声轨，或者解不出来」）', /没有声轨，或者浏览器解不出来/.test(r3.text), r3.text)

    // 直接调 inspect：只看一段
    const srv = await serveOne(fa)
    try {
      const res = await inspect(b, { page: srv.page, src: srv.src, kind: 'video', from: 2, to: 3, frames: 3, wantAudio: false })
      check('真浏览器：from / to 只在那一段取', res.times.length === 3 && res.times[0] === 2 && res.times[2] < 3 && res.audio === null, JSON.stringify(res.times))
    } finally { await srv.close() }
  } catch (e) {
    check('真浏览器：能开、能录、能看', false, e && e.message)
  } finally {
    b.destroy()
    gen.close()
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
