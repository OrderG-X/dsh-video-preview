/**
 * 不解码，只读 MP4 / MOV / M4A 的「盒子」：多长、画面多大、什么编码、有没有声轨、文件头（moov）在前还是在后。
 * 手机能不能播主要看这些（H.264 是不是 4:2:0、HEVC 的标签、moov 在不在前面）。
 * 只读顶层盒子的头和 moov（最多 64 MB），大文件不进内存。认不出来的格式（webm、mkv……）返回 null。
 */

import fs from 'node:fs'

const MAX_MOOV = 64 << 20
const TOP = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'uuid', 'moof', 'mfra', 'styp', 'sidx', 'meta'])

/** buf 里一个挨一个的盒子：{ type, body }（body 是去掉盒子头的那段） */
function* boxes(buf) {
  let p = 0
  while (p + 8 <= buf.length) {
    let len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    let hdr = 8
    if (len === 1) {
      if (p + 16 > buf.length) return
      len = Number(buf.readBigUInt64BE(p + 8))
      hdr = 16
    } else if (len === 0) len = buf.length - p
    if (len < hdr || p + len > buf.length) return
    yield { type, body: buf.subarray(p + hdr, p + len) }
    p += len
  }
}

const child = (buf, type) => {
  if (!buf) return null
  for (const b of boxes(buf)) if (b.type === type) return b.body
  return null
}
const dig = (buf, ...types) => types.reduce((b, t) => child(b, t), buf)

/** mvhd / mdhd：{ scale, dur }（版本 1 的时长是 64 位） */
function timeOf(body) {
  if (!body || body.length < 20) return null
  if (body[0] === 1) return body.length >= 32 ? { scale: body.readUInt32BE(20), dur: Number(body.readBigUInt64BE(24)) } : null
  return { scale: body.readUInt32BE(12), dur: body.readUInt32BE(16) }
}

/** esds 里的 objectTypeIndication：0x40 / 0x66-0x68 是 AAC，0x69 / 0x6B 是 MP3 */
function esdsType(esds) {
  if (!esds || esds.length < 6) return 0
  let p = 4 // version + flags
  const len = () => { let n = 0; for (let i = 0; i < 4 && p < esds.length; i++) { const b = esds[p++]; n = (n << 7) | (b & 0x7f); if (!(b & 0x80)) break } return n }
  while (p < esds.length) {
    const tag = esds[p++]
    const n = len()
    if (tag === 0x03) { const flags = esds[p + 2]; p += 3; if (flags & 0x80) p += 2; if (flags & 0x40) p += 1 + esds[p]; if (flags & 0x20) p += 2; continue }
    if (tag === 0x04) return esds[p] || 0
    p += n
  }
  return 0
}

/** 一条轨道的 stsd 第一项：编码标签和细节 */
function sampleEntry(stsd, kind) {
  if (!stsd || stsd.length < 16) return null
  const entries = stsd.subarray(8)
  const first = boxes(entries).next().value
  if (!first) return null
  const e = { tag: first.type }
  const b = first.body
  if (kind === 'vide' && b.length >= 78) {
    e.w = b.readUInt16BE(24)
    e.h = b.readUInt16BE(26)
    const kids = b.subarray(78)
    const avcC = child(kids, 'avcC')
    if (avcC && avcC.length >= 4) { e.profile = avcC[1]; e.level = avcC[3] }
    const hvcC = child(kids, 'hvcC')
    if (hvcC && hvcC.length >= 2) e.profile = hvcC[1] & 0x1f
    // 颜色：nclx（MP4）/ nclc（MOV）= 原色、传输特性、矩阵；传输特性 16 = PQ、18 = HLG，就是 HDR
    const colr = child(kids, 'colr')
    if (colr && colr.length >= 10) {
      const type = colr.toString('latin1', 0, 4)
      if (type === 'nclx' || type === 'nclc') e.color = { prim: colr.readUInt16BE(4), trc: colr.readUInt16BE(6), matrix: colr.readUInt16BE(8), full: type === 'nclx' && colr.length >= 11 ? !!(colr[10] & 0x80) : undefined }
    }
    // 杜比视界：dvh1 / dvhe 标签，或者 hvc1 里带 dvcC / dvvC（iPhone 录的 HDR）
    if (/^dv(h1|he|a1|av)$/.test(first.type) || child(kids, 'dvcC') || child(kids, 'dvvC')) e.dolby = true
    const trc = e.color && e.color.trc
    if (trc === 16 || trc === 18 || e.dolby) e.hdr = e.dolby ? '杜比视界' : trc === 18 ? 'HLG' : 'PQ'
  } else if (kind === 'soun' && b.length >= 28) {
    const ver = b.readUInt16BE(8)
    e.channels = b.readUInt16BE(16)
    e.rate = b.readUInt32BE(24) >>> 16
    const skip = ver === 1 ? 16 : ver === 2 ? 36 : 0
    const kids = b.subarray(28 + skip)
    const esds = child(kids, 'esds') || dig(kids, 'wave', 'esds')
    if (esds) e.oti = esdsType(esds)
  }
  return e
}

function parseTrak(trak) {
  const tkhd = child(trak, 'tkhd')
  const mdia = child(trak, 'mdia')
  const hdlr = child(mdia, 'hdlr')
  if (!hdlr || hdlr.length < 12) return null
  const kind = hdlr.toString('latin1', 8, 12)
  const t = timeOf(child(mdia, 'mdhd'))
  const stbl = dig(mdia, 'minf', 'stbl')
  const track = { kind, ...(sampleEntry(child(stbl, 'stsd'), kind) || {}), seconds: t && t.scale ? t.dur / t.scale : 0 }
  if (kind === 'vide' && tkhd && tkhd.length >= 84) {
    // 显示尺寸（16.16 定点数，在 tkhd 末尾）和旋转（矩阵前两项）
    track.dw = Math.round(tkhd.readUInt32BE(tkhd.length - 8) / 65536)
    track.dh = Math.round(tkhd.readUInt32BE(tkhd.length - 4) / 65536)
    const m = tkhd[0] === 1 ? 52 : 40
    const a = tkhd.readInt32BE(m) / 65536
    const b = tkhd.readInt32BE(m + 4) / 65536
    track.rotate = (Math.round(Math.atan2(b, a) * 180 / Math.PI) + 360) % 360
    const stts = child(stbl, 'stts')
    if (stts && stts.length >= 8) {
      const n = Math.min(stts.readUInt32BE(4), Math.floor((stts.length - 8) / 8))
      let frames = 0
      const deltas = new Set()
      for (let i = 0; i < n; i++) { frames += stts.readUInt32BE(8 + i * 8); deltas.add(stts.readUInt32BE(12 + i * 8)) }
      track.frames = frames
      if (track.seconds > 0) track.fps = Math.round((frames / track.seconds) * 100) / 100
      track.vfr = deltas.size > 2
    }
  }
  return track
}

/**
 * 读一个文件 → { container, brand, size, duration, faststart, fragmented, video, audio, tracks }；
 * 不是 MP4 / MOV 一类的返回 null。没有 moov（没录完、被截断）时 noMoov: true。
 */
export async function probeFile(file) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const read = async (pos, len) => {
      const b = Buffer.alloc(len)
      const { bytesRead } = await fh.read(b, 0, len, pos)
      return b.subarray(0, bytesRead)
    }
    const top = []
    let pos = 0
    while (pos + 8 <= size && top.length < 4096) {
      const h = await read(pos, 16)
      if (h.length < 8) break
      let len = h.readUInt32BE(0)
      const type = h.toString('latin1', 4, 8)
      let hdr = 8
      if (len === 1) {
        if (h.length < 16) break
        len = Number(h.readBigUInt64BE(8))
        hdr = 16
      } else if (len === 0) len = size - pos
      if (len < hdr || !/^[\x20-\x7e]{4}$/.test(type)) break
      top.push({ type, pos, len, hdr })
      pos += len
    }
    if (!top.length || !TOP.has(top[0].type)) return null
    const ftyp = top.find((b) => b.type === 'ftyp')
    const moov = top.find((b) => b.type === 'moov')
    const mdat = top.find((b) => b.type === 'mdat')
    const brand = ftyp ? (await read(ftyp.pos + ftyp.hdr, 4)).toString('latin1') : ''
    const out = {
      container: brand === 'qt  ' ? 'mov' : 'mp4',
      brand: brand.trim(),
      size,
      duration: 0,
      faststart: !!moov && (!mdat || moov.pos < mdat.pos),
      fragmented: top.some((b) => b.type === 'moof'),
      truncated: pos > size,
      video: null,
      audio: null,
      tracks: [],
    }
    if (!moov) return { ...out, noMoov: true }
    if (moov.len > MAX_MOOV) return { ...out, bigMoov: true }
    const body = (await read(moov.pos, moov.len)).subarray(moov.hdr)
    const mv = timeOf(child(body, 'mvhd'))
    if (mv && mv.scale) out.duration = mv.dur / mv.scale
    if (child(body, 'mvex')) out.fragmented = true
    for (const b of boxes(body)) {
      if (b.type !== 'trak') continue
      const t = parseTrak(b.body)
      if (!t) continue
      out.tracks.push(t)
      if (t.kind === 'vide' && !out.video) out.video = t
      if (t.kind === 'soun' && !out.audio) out.audio = t
    }
    if (!out.duration) out.duration = Math.max(0, ...out.tracks.map((t) => t.seconds || 0))
    return out
  } finally {
    await fh.close()
  }
}

// ── 编码叫什么、手机能不能播 ───────────────────────────────────────────────

const H264_PROFILE = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4', 44: 'CAVLC 4:4:4' }
const VIDEO_NAME = { avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', dvh1: 'HEVC', dvhe: 'HEVC', dva1: 'H.264', dvav: 'H.264', av01: 'AV1', vp09: 'VP9', vp08: 'VP8', mp4v: 'MPEG-4 Part 2', apcn: 'ProRes', apch: 'ProRes', apcs: 'ProRes', apco: 'ProRes', ap4h: 'ProRes 4444', jpeg: 'Motion JPEG', 'png ': 'PNG', 'rle ': 'Animation', s263: 'H.263', h263: 'H.263' }
const PCM = new Set(['lpcm', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64', 'raw ', 'ipcm', 'fpcm'])

/** 视频编码的名字，例如「H.264 High」「HEVC Main 10 HDR（HLG）」 */
export function videoName(v) {
  if (!v) return ''
  const base = VIDEO_NAME[v.tag] || v.tag.trim()
  const hdr = v.hdr ? ` HDR（${v.hdr}）` : ''
  if (base === 'H.264') return (H264_PROFILE[v.profile] ? `${base} ${H264_PROFILE[v.profile]}` : base) + hdr
  if (base === 'HEVC') return `${base}${v.profile === 2 ? ' Main 10' : v.profile === 4 ? ' RExt' : ''}${hdr}`
  return base + hdr
}

/** 音频编码的名字 */
export function audioName(a) {
  if (!a) return ''
  if (a.tag === 'mp4a') return a.oti === 0x69 || a.oti === 0x6b ? 'MP3' : 'AAC'
  if (PCM.has(a.tag)) return '未压缩 PCM'
  return { Opus: 'Opus', opus: 'Opus', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', alac: 'ALAC', samr: 'AMR', 'fLaC': 'FLAC', '.mp3': 'MP3' }[a.tag] || a.tag.trim()
}

/**
 * 别处（手机、微信、网页、苹果设备）能不能播：[{ level: 'bad' | 'warn', text }]。
 * bad = 很多地方放不了，warn = 有些地方放不了或体验差。只看文件头能看出来的。
 */
export function compatOf(p) {
  if (!p) return []
  const out = []
  const v = p.video
  const a = p.audio
  if (p.noMoov) out.push({ level: 'bad', text: '文件里没有索引（moov）：多半没录完或被截断了，大多数播放器打不开；重新导出一次' })
  if (v) {
    const name = videoName(v)
    // 杜比视界的标签按底下的编码算：dvh1 像 hvc1，dvhe 像 hev1，dva1 / dvav 像 avc1
    const tag = { dvh1: 'hvc1', dvhe: 'hev1', dva1: 'avc1', dvav: 'avc3' }[v.tag] || v.tag
    if ((tag === 'avc1' || tag === 'avc3') && [110, 122, 244, 44].includes(v.profile)) {
      out.push({ level: 'bad', text: `${name}（不是 8 位 4:2:0）：iPhone、微信、QuickTime 和很多电视放不了；重新编码时加 -pix_fmt yuv420p` })
    } else if (tag === 'hev1') {
      out.push({ level: 'bad', text: 'HEVC 的标签是 hev1：iPhone、Safari、QuickTime 放不了；不用重新编码，重新封装就行：ffmpeg -i 原文件 -c copy -tag:v hvc1 新文件.mp4' })
    } else if (tag === 'hvc1') {
      out.push({ level: 'warn', text: 'HEVC：苹果设备能放；部分安卓、没装扩展的 Windows、一些网页放不了；要到处都能放就转成 H.264' })
    } else if (v.tag === 'av01') {
      out.push({ level: 'warn', text: 'AV1：较新的手机和浏览器才行，老 iPhone、老电脑放不了' })
    } else if (v.tag === 'vp09' || v.tag === 'vp08') {
      out.push({ level: 'warn', text: `${name} 装在 MP4 里：iPhone、微信可能放不了` })
    } else if (!['avc1', 'avc3'].includes(tag)) {
      out.push({ level: 'bad', text: `${name}：浏览器和手机放不了（老编码或剪辑用的格式）；要分享就转成 H.264` })
    }
    const w = v.dw || v.w
    const h = v.dh || v.h
    if (v.hdr) out.push({ level: 'warn', text: `HDR 视频（${v.hdr}）：iPhone、新款 Mac 上正常；发到微信、很多安卓、网页和不支持 HDR 的屏幕上常常发灰、颜色变淡或过曝；要到处都正常就转成普通的 SDR（BT.709），iPhone 上可以在「设置 → 相机 → 录制视频」关掉 HDR 再录` })
    if (Math.max(w, h) > 4096 || Math.min(w, h) > 2304) out.push({ level: 'warn', text: `画面 ${w}×${h} 超过 4K：很多手机放不了或很卡` })
  }
  if (a) {
    const name = audioName(a)
    if (a.tag === 'ac-3' || a.tag === 'ec-3' || a.tag === 'samr') out.push({ level: 'bad', text: `声音是 ${name}：Chrome（DSH 的播放器）和很多手机放不出声；转成 AAC：-c:a aac` })
    else if (a.tag === 'Opus' || a.tag === 'opus') out.push({ level: 'warn', text: '声音是 Opus 装在 MP4 里：老 iPhone、Safari 放不出声；要稳就用 AAC' })
    else if (a.tag === 'alac') out.push({ level: 'warn', text: '声音是 ALAC（苹果无损）：Chrome（DSH 的播放器）和很多安卓放不出声；要分享就转成 AAC' })
  }
  if (!p.faststart && !p.noMoov && p.size > 2 << 20) {
    out.push({ level: 'warn', text: '文件头（moov）在末尾：网页、手机在线看要整个下完才开始放；重新封装就行：ffmpeg -i 原文件 -c copy -movflags +faststart 新文件.mp4' })
  }
  return out
}
