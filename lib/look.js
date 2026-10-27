/**
 * look_video 的里子：在无头浏览器里打开视频，按时间取帧（拼成一张带时间的图，或几张大图），
 * 把声音解出来量（有没有声、多大、哪段没声、有没有爆音、是不是只有一边有声），再把这些变成给模型看的字。
 *
 *   pageTools   注进页面的函数（在浏览器里跑，Node 不执行）：open / frames / audio
 *   inspect     开页面、取帧、量声音 → 原始结果
 *   findings    原始结果 + 文件头信息（probe.js）→ 问题清单
 *   formatLook  给模型的字
 */

import { videoName, audioName, compatOf } from './probe.js'

export const MAX_FRAMES = 16 // 拼图里最多几帧
export const MAX_AT = 6 // at 一次最多看几刻的大图
export const MAX_AUDIO_BYTES = 400 << 20 // 再大就不解声音了（要整个读进浏览器）
export const MAX_AUDIO_SECONDS = 30 * 60 // 再长也不解（解出来的采样太多）
const SHEET_W = 1536 // 拼图宽
const BIG_EDGE = 1280 // 单张大图的长边

/** 「1:23」「1:23.5」「83」「83s」「01:02:03」→ 秒；认不出 → NaN */
export function parseTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : NaN
  const s = String(v ?? '').trim().replace(/s$/i, '')
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN
  return s.split(':').reduce((sum, x) => sum * 60 + Number(x), 0)
}

/** 秒 → 「0:05」「1:23」「1:02:03」；短片（一分钟以内）带一位小数，取帧的时间才分得清 */
export function fmtTime(t, short = false) {
  const x = Math.max(0, t)
  if (short) {
    const s = Math.round(x * 10) / 10
    return `0:${s < 10 ? '0' : ''}${s.toFixed(1)}`
  }
  const total = Math.round(x)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** 默认取几帧：越长取越多 */
export function frameCount(duration) {
  if (duration <= 3) return 4
  if (duration <= 10) return 6
  if (duration <= 60) return 9
  return 12
}

/**
 * 在 [from, to] 里均匀取 n 帧，头尾都取（第一帧就是封面，最后一帧看收尾）。
 * 最后一帧往前让一点：正好落在结尾时很多视频解不出画面。
 */
export function pickTimes(duration, { frames, from = 0, to = duration } = {}) {
  const end = Math.min(duration, to)
  const start = Math.min(Math.max(0, from), end)
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(frames || frameCount(end - start))))
  const last = Math.max(start, end - Math.min(0.1, (end - start) / 20))
  if (n === 1 || last <= start) return [start]
  return Array.from({ length: n }, (_, i) => Math.round((start + ((last - start) * i) / (n - 1)) * 1000) / 1000)
}

// ── 页面里跑的 ──────────────────────────────────────────────────────────────

/* eslint-disable */
/** 注进页面：window.__dshLook = { open, frames, audio }。这个函数只在浏览器里执行 */
export function pageTools() {
  if (window.__dshLook) return true
  let v = null
  const wait = (el, ev, ms) => new Promise((ok) => {
    const t = setTimeout(() => done(false), ms)
    const done = (x) => { clearTimeout(t); el.removeEventListener(ev, on); ok(x) }
    const on = () => done(true)
    el.addEventListener(ev, on)
  })
  async function seek(t) {
    if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return true
    v.currentTime = t
    const ok = await wait(v, 'seeked', 8000)
    // 跳完再等这一帧真画出来（有的视频 seeked 早于画面）；等不到也照样往下走
    if ('requestVideoFrameCallback' in v) await Promise.race([new Promise((r) => v.requestVideoFrameCallback(() => r())), new Promise((r) => setTimeout(r, 150))])
    return ok
  }
  async function open(src) {
    v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.playsInline = true
    v.src = src
    document.body.append(v)
    const ok = await Promise.race([wait(v, 'loadeddata', 20000), new Promise((r) => v.addEventListener('error', () => r(false), { once: true }))])
    if (!ok) return { error: v.error ? v.error.code : 0, message: v.error ? v.error.message : 'timeout' }
    let duration = v.duration
    // 浏览器录的 webm 常常不写时长（Infinity）：跳到很远的地方，浏览器就知道多长了
    if (!Number.isFinite(duration)) {
      v.currentTime = 1e9
      await wait(v, 'seeked', 8000)
      duration = Number.isFinite(v.duration) ? v.duration : v.currentTime
      v.currentTime = 0
      await wait(v, 'seeked', 8000)
    }
    return { duration, w: v.videoWidth, h: v.videoHeight }
  }
  const luma = (d, i) => d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722
  /**
   * 一帧的亮度、反差、亮着的点占多少（千分之几，160×90 上数，黑底上的字也数得到），
   * 和一个 16×9 的灰度指纹（比前后帧是不是一样）
   */
  function stats(sg, mg) {
    const d = sg.getImageData(0, 0, 16, 9).data
    const fp = []
    let sum = 0
    for (let i = 0; i < d.length; i += 4) { const y = luma(d, i); fp.push(Math.round(y)); sum += y }
    const mean = sum / fp.length
    let sq = 0
    for (const y of fp) sq += (y - mean) * (y - mean)
    const m = mg.getImageData(0, 0, 160, 90).data
    let lit = 0
    for (let i = 0; i < m.length; i += 4) if (luma(m, i) > 48) lit++
    return { y: Math.round(mean), sd: Math.round(Math.sqrt(sq / fp.length)), lit: Math.round((lit / (m.length / 4)) * 10000) / 10, fp }
  }
  function label(g, text, x, y, size) {
    g.font = `600 ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
    const w = g.measureText(text).width + size * 0.8
    const h = size * 1.5
    g.fillStyle = 'rgba(0,0,0,.72)'
    g.beginPath()
    g.roundRect(x, y, w, h, h / 2)
    g.fill()
    g.fillStyle = '#fff'
    g.textBaseline = 'middle'
    g.fillText(text, x + size * 0.4, y + h / 2)
  }
  /**
   * 取帧。sheet：拼成一张（cols 列、每格 cw×ch，左上角标时间）；否则每帧一张大图（长边 edge）。
   * 返回 { jpgs: [base64…], stats: [{ t, y, sd, lit, fp, ok }] }
   */
  async function frames(times, labels, o) {
    const W = v.videoWidth || 16
    const H = v.videoHeight || 9
    const small = document.createElement('canvas')
    small.width = 16
    small.height = 9
    const sg = small.getContext('2d', { willReadFrequently: true })
    const mid = document.createElement('canvas')
    mid.width = 160
    mid.height = 90
    const mg = mid.getContext('2d', { willReadFrequently: true })
    const out = { jpgs: [], stats: [] }
    let sheet = null
    let g = null
    if (o.sheet) {
      sheet = document.createElement('canvas')
      sheet.width = o.cols * o.cw + (o.cols + 1) * o.gap
      sheet.height = Math.ceil(times.length / o.cols) * o.ch + (Math.ceil(times.length / o.cols) + 1) * o.gap
      g = sheet.getContext('2d')
      g.fillStyle = '#1b1d22'
      g.fillRect(0, 0, sheet.width, sheet.height)
    }
    for (let i = 0; i < times.length; i++) {
      const ok = await seek(times[i])
      sg.drawImage(v, 0, 0, 16, 9)
      mg.drawImage(v, 0, 0, 160, 90)
      out.stats.push({ t: times[i], ok, ...stats(sg, mg) })
      if (sheet) {
        const x = o.gap + (i % o.cols) * (o.cw + o.gap)
        const y = o.gap + Math.floor(i / o.cols) * (o.ch + o.gap)
        g.drawImage(v, x, y, o.cw, o.ch)
        label(g, labels[i], x + 6, y + 6, Math.max(13, Math.round(o.cw / 18)))
      } else {
        const k = Math.min(1, o.edge / Math.max(W, H))
        const c = document.createElement('canvas')
        c.width = Math.round(W * k)
        c.height = Math.round(H * k)
        const cg = c.getContext('2d')
        cg.drawImage(v, 0, 0, c.width, c.height)
        label(cg, labels[i], 10, 10, Math.max(16, Math.round(c.width / 40)))
        out.jpgs.push(c.toDataURL('image/jpeg', 0.85).split(',')[1])
      }
    }
    if (sheet) out.jpgs.push(sheet.toDataURL('image/jpeg', 0.85).split(',')[1])
    return out
  }
  /**
   * 把声音整个解出来（16 kHz）量：每声道的峰值、均方根、削波的比例，和每 0.1 秒一格的响度（dB，混成一路）。
   * 没有声轨 / 解不出来 → { error }
   */
  async function audio(src) {
    let buf
    try {
      const ab = await (await fetch(src)).arrayBuffer()
      buf = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(ab)
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
    const n = buf.length
    const chs = buf.numberOfChannels
    const data = Array.from({ length: chs }, (_, c) => buf.getChannelData(c))
    const per = data.map((d) => {
      let peak = 0
      let sq = 0
      let clip = 0
      for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sq += d[i] * d[i]; if (a >= 0.99) clip++ }
      return { peak, rms: Math.sqrt(sq / Math.max(1, n)), clip }
    })
    const step = Math.round(buf.sampleRate / 10)
    const win = []
    for (let s = 0; s < n; s += step) {
      let sq = 0
      const e = Math.min(n, s + step)
      for (let c = 0; c < chs; c++) for (let i = s; i < e; i++) sq += data[c][i] * data[c][i]
      const r = Math.sqrt(sq / Math.max(1, (e - s) * chs))
      win.push(r > 0 ? Math.max(-100, Math.round(20 * Math.log10(r))) : -100)
    }
    return { duration: buf.duration, channels: chs, samples: n, per, win }
  }
  window.__dshLook = { open, frames, audio }
  return true
}
/* eslint-enable */

// ── 开页面量 ─────────────────────────────────────────────────────────────────

/** 拼图的排法：横的 3–4 列，竖的 4–6 列；整张长边不超过 1568 */
export function sheetLayout(w, h, n) {
  const portrait = h > w
  const cols = Math.min(n, portrait ? (n <= 4 ? n : n <= 10 ? 5 : 6) : n <= 4 ? 2 : n <= 9 ? 3 : 4)
  const rows = Math.ceil(n / cols)
  const gap = 8
  let cw = Math.floor((SHEET_W - (cols + 1) * gap) / cols)
  let ch = Math.round((cw * (h || 9)) / (w || 16))
  const tall = rows * ch + (rows + 1) * gap
  if (tall > 1568) {
    const k = (1568 - (rows + 1) * gap) / (rows * ch)
    cw = Math.floor(cw * k)
    ch = Math.floor(ch * k)
  }
  return { cols, cw, ch, gap }
}

/**
 * 在无头浏览器里看一个文件：src 是这个文件在本机临时服务上的地址（同源，能跳进度、能整个读）。
 *   kind      'video' | 'audio'
 *   at        要看的时间点（秒）；给了就出几张大图，不给就按 from / to / frames 均匀取、拼成一张
 *   wantAudio 要不要量声音（文件太大、明知没声轨时不量）
 * → { info: { duration, w, h } | { error }, times, sheet, jpgs, stats, audio }
 */
export async function inspect(browser, { page, src, kind, at, from, to, frames, wantAudio = true }) {
  return browser.withPage({ url: page, w: 800, h: 600 }, async (p) => {
    await p.eval(`(${pageTools.toString()})()`)
    const info = await p.eval(`window.__dshLook.open(${JSON.stringify(src)})`)
    const res = { info, times: [], sheet: false, jpgs: [], stats: [], audio: null }
    if (info && !info.error && kind === 'video' && info.w > 0) {
      const short = info.duration < 60
      const times = at && at.length
        ? at.map((t) => Math.min(Math.max(0, t), Math.max(0, info.duration - 0.05)))
        : pickTimes(info.duration, { frames, from, to })
      const labels = times.map((t) => fmtTime(t, short))
      const sheet = !(at && at.length)
      const o = sheet ? { sheet: true, ...sheetLayout(info.w, info.h, times.length) } : { sheet: false, edge: BIG_EDGE }
      // 分几次取：一次 eval 有时间上限，帧多的长视频分开取稳一点
      if (sheet) {
        const r = await p.eval(`window.__dshLook.frames(${JSON.stringify(times)}, ${JSON.stringify(labels)}, ${JSON.stringify(o)})`)
        res.jpgs = r.jpgs
        res.stats = r.stats
      } else {
        for (let i = 0; i < times.length; i++) {
          const r = await p.eval(`window.__dshLook.frames(${JSON.stringify([times[i]])}, ${JSON.stringify([labels[i]])}, ${JSON.stringify(o)})`)
          res.jpgs.push(...r.jpgs)
          res.stats.push(...r.stats)
        }
      }
      res.times = times
      res.sheet = sheet
    }
    // 画面打不开（比如这台电脑解不了 HEVC）声音也可能解得出来，照样量；量的时候出错（太长超时）只算声音没量成
    if (wantAudio && info && info.duration > MAX_AUDIO_SECONDS) res.audio = { skipped: `超过 ${MAX_AUDIO_SECONDS / 60} 分钟，没量声音。` }
    else if (wantAudio) {
      try {
        res.audio = await p.eval(`window.__dshLook.audio(${JSON.stringify(src)})`)
      } catch (e) {
        res.audio = { error: String((e && e.message) || e), failed: true }
      }
    }
    return res
  })
}

// ── 看出来的问题 ─────────────────────────────────────────────────────────────

const SILENT_DB = -50 // 这一格比这还小就算没声
const QUIET_DB = -35 // 有声的部分平均比这还小：声音太小

/** 每 0.1 秒一格的响度 → 没声的段 [[开始秒, 结束秒]]（至少 minSec 秒） */
export function silences(win, minSec = 1.5) {
  const out = []
  let s = -1
  for (let i = 0; i <= win.length; i++) {
    const quiet = i < win.length && win[i] < SILENT_DB
    if (quiet && s < 0) s = i
    if (!quiet && s >= 0) {
      if ((i - s) / 10 >= minSec) out.push([s / 10, i / 10])
      s = -1
    }
  }
  return out
}

const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -100)

/** 声音 → { summary, issues: [{ level, text }] } */
export function audioFindings(a, { duration, short = false } = {}) {
  if (!a || a.error) return null
  const issues = []
  const peak = Math.max(...a.per.map((c) => c.peak))
  const rms = Math.sqrt(a.per.reduce((s, c) => s + c.rms * c.rms, 0) / a.per.length)
  const loud = a.win.filter((x) => x >= SILENT_DB)
  const active = loud.length ? Math.round(10 * Math.log10(loud.reduce((s, x) => s + 10 ** (x / 10), 0) / loud.length)) : -100
  const total = duration || a.duration
  const t = (x) => fmtTime(x, short)
  if (db(peak) < SILENT_DB) {
    issues.push({ level: 'bad', text: `整段几乎没有声音（最大 ${db(peak)} dB）` })
    return { summary: `有声轨，但几乎没声（最大 ${db(peak)} dB）`, issues, peak: db(peak), active }
  }
  for (const [s, e] of silences(a.win)) {
    const atStart = s < 0.15
    const atEnd = e >= a.win.length / 10 - 0.15
    if (atStart && atEnd) continue
    if (atStart) issues.push({ level: 'warn', text: `开头 ${t(0)}–${t(e)} 没声音` })
    else if (atEnd) issues.push({ level: 'warn', text: `结尾 ${t(s)}–${t(Math.min(e, total))} 没声音` })
    else if (e - s >= 3) issues.push({ level: 'warn', text: `${t(s)}–${t(e)} 没声音（${Math.round(e - s)} 秒）` })
  }
  if (active < QUIET_DB) issues.push({ level: 'warn', text: `声音偏小：有声的部分平均 ${active} dB（一般 -20 dB 左右），手机外放可能听不清` })
  const clipRate = a.per.reduce((s, c) => s + c.clip, 0) / Math.max(1, a.samples * a.per.length)
  if (clipRate > 0.001) issues.push({ level: 'bad', text: `有爆音（削波）：${(clipRate * 100).toFixed(1)}% 的采样顶到了最大值；把音量调小再导出（ffmpeg 加 -af volume=-6dB）` })
  if (a.channels === 2) {
    const [l, r] = a.per.map((c) => db(c.rms))
    if (l > SILENT_DB + 10 && r < SILENT_DB) issues.push({ level: 'bad', text: '只有左声道有声音（右边没声）：戴耳机只有一边响；转成单声道或复制到两边（ffmpeg 加 -af pan=stereo|c0=c0|c1=c0）' })
    if (r > SILENT_DB + 10 && l < SILENT_DB) issues.push({ level: 'bad', text: '只有右声道有声音（左边没声）：戴耳机只有一边响；复制到两边（ffmpeg 加 -af pan=stereo|c0=c1|c1=c1）' })
  }
  return { summary: `有声，${a.channels === 1 ? '单声道' : a.channels === 2 ? '立体声' : `${a.channels} 声道`}，有声的部分平均 ${active} dB，最大 ${db(peak)} dB`, issues, peak: db(peak), active }
}

const BLACK_Y = 16 // 平均亮度
const BLACK_LIT = 3 // 亮着的点不到千分之三（黑底上有字、有画面的不算黑屏；只有鼠标指针的还算）
const SAME = 2.5 // 两帧指纹平均差多少以内算一样

const fpDiff = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length

/** 取到的帧 → 问题：黑屏、画面一直没变 */
export function frameFindings(stats, { duration, short = false, sheet = true } = {}) {
  const issues = []
  if (!stats.length) return issues
  const t = (x) => fmtTime(x, short)
  const black = stats.filter((s) => s.y <= BLACK_Y && s.lit <= BLACK_LIT)
  const failed = stats.filter((s) => !s.ok)
  if (failed.length) issues.push({ level: 'warn', text: `有 ${failed.length} 帧跳不过去（${failed.map((s) => t(s.t)).join('、')}）：文件可能不能拖进度条（浏览器录的、没写索引的），那几格可能是旁边的画面` })
  if (sheet && black.length === stats.length) {
    issues.push({ level: 'bad', text: `取的 ${stats.length} 帧全是黑的：画面可能没录上（录屏没权限、录错了屏幕、画面被遮住）` })
    return issues
  }
  if (black.length) {
    const first = stats[0] === black[0]
    const last = stats[stats.length - 1] === black[black.length - 1] && stats.length > 1
    if (first && sheet) issues.push({ level: 'warn', text: `第一帧（${t(stats[0].t)}）是黑的：封面会是黑的，有的平台拿第一帧当缩略图` })
    const mid = black.filter((s) => (s !== stats[0] || !sheet) && (s !== stats[stats.length - 1] || !sheet))
    if (mid.length) issues.push({ level: 'warn', text: `这几刻是黑屏：${mid.map((s) => t(s.t)).join('、')}` })
    if (last && sheet) issues.push({ level: 'warn', text: `最后一帧（${t(stats[stats.length - 1].t)}）是黑的：结尾可能多了一段黑屏` })
  }
  if (sheet && stats.length >= 3 && duration > 2) {
    const same = stats.slice(1).every((s, i) => fpDiff(s.fp, stats[i].fp) <= SAME)
    if (same) issues.push({ level: 'warn', text: `取的 ${stats.length} 帧几乎一模一样：整段画面可能没动（录屏卡住了、录到了静止的窗口）；要是本来就是静态画面就没事` })
    else {
      // 连着好几格一样，而且占了一大段
      let s = 0
      for (let i = 1; i <= stats.length; i++) {
        const cont = i < stats.length && fpDiff(stats[i].fp, stats[i - 1].fp) <= SAME
        if (!cont) {
          if (i - s >= 4 && stats[i - 1].t - stats[s].t >= duration * 0.3) issues.push({ level: 'warn', text: `${t(stats[s].t)}–${t(stats[i - 1].t)} 画面没变（${i - s} 帧一样）：要是本该有动作，可能卡住了` })
          s = i
        }
      }
    }
  }
  return issues
}

// ── 给模型的字 ───────────────────────────────────────────────────────────────

const ERR = { 1: '读取被中止', 2: '网络错误（文件读不全）', 3: '解码出错（文件可能坏了，或者编码浏览器不支持）', 4: '浏览器不支持这个格式或编码' }

/**
 * 拼成给模型的字。
 *   name, size     文件名、大小（字符串）
 *   probe          probe.js 读到的文件头（可能是 null）
 *   res            inspect 的结果（没浏览器时是 null）
 *   kind           'video' | 'audio'
 *   audioSkipped   没量声音的原因（可选）
 *   images         实际交出去几张图
 */
/** 不是 MP4 / MOV 的容器：手机上能不能放只看扩展名就知道个大概 */
const CONTAINER = {
  '.webm': 'WebM：iPhone 上的微信和一些老设备放不了；要发给别人看就转成 MP4（H.264 + AAC）',
  '.mkv': 'MKV：手机、微信、网页大多放不了；要发给别人看就转成 MP4（H.264 + AAC），多数时候不用重新编码：ffmpeg -i 原文件 -c copy 新文件.mp4',
  '.ogv': 'OGV：苹果设备和微信放不了；要发给别人看就转成 MP4（H.264 + AAC）',
}

export function formatLook({ name, size, probe, res, kind, ext = '', audioSkipped = '', images = 0, files = [] }) {
  const info = res && res.info
  const duration = (info && !info.error && info.duration) || (probe && probe.duration) || 0
  const short = duration > 0 && duration < 60
  const v = probe && probe.video
  const w = (info && info.w) || (v && (v.dw || v.w)) || 0
  const h = (info && info.h) || (v && (v.dh || v.h)) || 0
  const codec = [videoName(v), audioName(probe && probe.audio)].filter(Boolean).join(' + ')
  const head = [
    kind === 'video' && w ? `${w}×${h}` : '',
    duration ? fmtTime(duration) : '',
    v && v.fps ? `${Math.round(v.fps)} fps` : '',
    codec,
    size,
  ].filter(Boolean).join('，')
  const lines = [`看了 ${name}（${head}）：`]

  if (info && info.error) {
    lines.push(`浏览器打不开：${ERR[info.error] || info.message || '原因不明'}。`)
  }
  if (res && res.jpgs.length) {
    if (res.sheet) {
      lines.push(`图 1：${res.times.length} 帧，从 ${fmtTime(res.times[0], short)} 到 ${fmtTime(res.times[res.times.length - 1], short)} 均匀取，从左到右、从上到下，每格左上角是时间。`)
    } else {
      res.times.forEach((t, i) => lines.push(`图 ${i + 1}：${fmtTime(t, short)} 那一刻（原画面缩到长边 ${BIG_EDGE} 以内）。`))
    }
    if (!images && files.length) lines.push(`（这个 DSH 版本没法把图直接给你，存成了文件：\n${files.join('\n')}）`)
  } else if (kind === 'video' && info && !info.error && !info.w) {
    lines.push('这个文件里没有画面（只有声音）。')
  }

  const issues = []
  if (res && res.stats.length) issues.push(...frameFindings(res.stats, { duration, short, sheet: res.sheet }))

  // 声音
  const a = res && res.audio
  const hasTrack = probe ? !!probe.audio : null
  if (audioSkipped || (a && a.skipped)) lines.push(`声音：${audioSkipped || a.skipped}`)
  else if (probe && !probe.audio && kind === 'video' && !probe.noMoov) {
    lines.push('声音：没有声轨（这个视频是哑的）。要是本该有配音 / 背景音乐，是合成时没把声音放进去。')
  } else if (a && a.failed) {
    lines.push(`声音：没量成（${a.error}）。`)
  } else if (a && a.error) {
    lines.push(hasTrack ? `声音：有声轨（${audioName(probe.audio)}），但浏览器解不出来。` : '声音：没有声轨，或者浏览器解不出来。')
  } else if (a) {
    const f = audioFindings(a, { duration, short })
    lines.push(`声音：${f.summary}。`)
    issues.push(...f.issues)
  }

  issues.push(...compatOf(probe))
  if (CONTAINER[ext]) issues.push({ level: 'warn', text: CONTAINER[ext] })
  if (issues.length) {
    lines.push('', '问题：')
    for (const it of issues) lines.push(`- ${it.level === 'bad' ? '【严重】' : ''}${it.text}`)
  } else if (res && !(info && info.error)) {
    // 只说查过的
    const ok = [
      res.stats.length ? '画面没有黑屏、没卡住' : '',
      a && !a.error && !a.skipped ? '声音正常' : '',
      probe ? '编码手机上能放' : '',
    ].filter(Boolean)
    if (ok.length) lines.push('', `没发现问题：${ok.join('，')}。`)
  }
  if (res && res.sheet && res.jpgs.length) lines.push('', `要看某一刻的大图：look_video 带 at，例如 at: ["${fmtTime(duration / 2, short)}"]；只看一段：from / to。`)
  else if (res && res.jpgs.length) lines.push('', '要逐帧看那附近（找闪一下、跳帧、颜色突变）：from / to 缩到那一小段（比如前后 0.3 秒），frames 设成 16。')
  return lines.join('\n')
}
