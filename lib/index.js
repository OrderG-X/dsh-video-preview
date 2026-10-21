/**
 * dsh-video-preview —— 让 DSH 的对话流里能直接播视频/音频。
 *
 * DSH 的渲染块只有 text / image / file / table，没有 video，工具块又默认折叠。
 * 这个插件用四层组合把播放器送到用户眼前（全部走官方插件 API，零 @deepseek-ai/* 依赖）：
 *
 *   服务端  play_video 工具：校验文件 → 返回带签名的 URL →
 *           照官方 present 工具的机制 append deliverables/presented 事件
 *   路由    /dsh-video-preview/media   签名 token 鉴权，HTTP Range 流式（能拖进度条）
 *           /dsh-video-preview/preview 宿主登录态鉴权（DSH 自己的 connection 服务验 cookie），供侧边栏/turnTail 用
 *   自动    这一轮新生成的媒体（录屏、转码、TTS…），模型不调工具也自动呈现（见 auto-present.js）
 *   客户端  turnTail 槽 → 播放器渲染在最终输出正下方（Claude/Codex 同款位置）
 *           documentPreviews 渲染器 → 侧边栏预览面板变播放器
 *           toolview 槽 → 展开工具块后的小播放器（兜底）
 *
 * 签名密钥持久化在 ~/.dsh/cache，同一台机器上 URL 跨重启、跨宿主（web/桌面）都有效。
 *
 * 把门（webServer 本身不鉴权，浏览器里任何网页都摸得到 127.0.0.1）：
 *   - 两条路由都只给媒体文件（按扩展名，软链接按真实文件算），别的文件一律不给
 *   - Host 必须是本机名或 DSH 自己的地址（防 DNS 重绑定）；跨站请求、Origin 不是自己的都拒
 *   - preview 没有 token，靠 DSH 的登录 cookie；拿不到 connection 服务时只收本机连接
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream'
import { autoPresent, sessionCwd } from './auto-present.js'

export const name = 'dsh-video-preview'
export const inject = ['tools', 'webServer', 'sessionProjections']

const ROUTE = '/dsh-video-preview/media'
const PREVIEW_ROUTE = '/dsh-video-preview/preview'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/**
 * 签名密钥：持久化在 ~/.dsh/cache 下（0600），同一台机器上跨重启、跨宿主（web / 桌面）一致。
 * 为什么不用每次启动的随机 token：URL 会写进会话历史，宿主一重启（或在桌面端打开 web 端
 * 创建的会话）token 就对不上，媒体请求全部 403。
 */
function loadSecret() {
  const file = path.join(process.env.HOME || '.', '.dsh', 'cache', 'dsh-video-preview.secret')
  try {
    const s = fs.readFileSync(file, 'utf8').trim()
    if (s) return s
  } catch { /* 首次使用，落到下面生成 */ }
  const s = crypto.randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, s, { mode: 0o600 })
  } catch { /* 写不进盘就退化为进程内密钥：本进程内 URL 仍有效 */ }
  return s
}
const SECRET = loadSecret()

/** token = HMAC(secret, 文件绝对路径)。同一台机器上同一文件的 URL 永远相同。 */
function tokenFor(file) {
  return crypto.createHmac('sha256', SECRET).update(file).digest('hex').slice(0, 32)
}

function tokenOk(file, t) {
  const want = Buffer.from(tokenFor(file))
  const got = Buffer.from(String(t || ''))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

// DSH 的播放器是 Chromium 内核，这些能直接播（mkv / 3gp 要看里面的编码，播不了前端会说清楚）
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mkv', '.3gp'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba'])
// 这些 Chromium 根本不认：与其给用户一个黑框，不如直接告诉模型先转码
const UNPLAYABLE_EXT = new Set(['.avi', '.flv', '.wmv', '.asf', '.wma', '.ts', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.vob', '.rm', '.rmvb', '.amr', '.ape'])
const UNPLAYABLE_AUDIO = new Set(['.wma', '.amr', '.ape'])

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

/** shell 单引号：文件名里的 $(...)、反引号、双引号都原样当字面，单引号写成 '\'' */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** 转码建议：模型能照着跑，用户也看得懂（播不了的格式都不是 .mp4 / .m4a，输出名不会和输入撞） */
function convertHint(file) {
  const ext = path.extname(file).toLowerCase()
  const audio = UNPLAYABLE_AUDIO.has(ext)
  const out = file.slice(0, file.length - ext.length) + (audio ? '.m4a' : '.mp4')
  const cmd = audio
    ? `ffmpeg -i ${shq(file)} -c:a aac ${shq(out)}`
    : `ffmpeg -i ${shq(file)} -c:v libx264 -c:a aac -movflags +faststart ${shq(out)}`
  return { out, cmd }
}

/** 工具参数里的路径 → 绝对路径：~ 换成家目录，相对路径按会话的工作目录算；没有工作目录就返回空串 */
function resolvePath(raw, cwd) {
  const p = String(raw || '').replace(/^~(?=\/|$)/, process.env.HOME || '~')
  if (path.isAbsolute(p)) return path.resolve(p)
  return cwd ? path.resolve(cwd, p) : ''
}

function urlFor(file) {
  const p = encodeURIComponent(file)
  return `${ROUTE}?t=${tokenFor(file)}&p=${p}`
}

// ── 把门 ────────────────────────────────────────────────────────────────────

/** DSH 自己对外的 host（绑在非本机地址时用得上）；还没开始监听就拿不到 */
function ownHost(ctx) {
  try { return new URL(ctx.webServer.getOrigin()).host } catch { return '' }
}

/** Host / Sec-Fetch-Site / Origin 三道，照 DSH 自家路由的规矩 */
function fenceOk(req, own) {
  const host = String(req.headers.host || '')
  if (!LOOPBACK_HOST.test(host) && !(own && host === own)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}

/** DSH 的 connection 服务：验登录 cookie 用的就是它。拿不到（比如老版本）返回 null */
function connectionOf(ctx) {
  try {
    const c = ctx.get('connection')
    return c && typeof c.requestRejection === 'function' ? c : null
  } catch {
    return null
  }
}

// 每个回应都带这个头：前端出错时靠它分清「插件的路由在回话」还是「路由根本没挂上」
const MARK = { 'X-DSH-Video-Preview': '1' }

function reply(res, code, text) {
  res.writeHead(code, { ...MARK, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/**
 * 只给真的媒体文件：扩展名按软链接指向的真实文件也要对。
 * 全用异步读盘：文件在失联的网络盘上时只卡这一个请求，不卡整个宿主。
 */
async function mediaFile(file, res) {
  if (!file || !path.isAbsolute(file) || !kindOf(file)) {
    reply(res, 403, 'forbidden')
    return null
  }
  let real, stat
  try {
    real = await fs.promises.realpath(file)
    stat = await fs.promises.stat(real)
  } catch {
    reply(res, 404, 'not found')
    return null
  }
  if (!kindOf(real) || !stat.isFile()) {
    reply(res, 403, 'forbidden')
    return null
  }
  try {
    await fs.promises.access(real, fs.constants.R_OK)
  } catch {
    reply(res, 403, 'forbidden')
    return null
  }
  return { real, stat }
}

// ── 两条路由 ────────────────────────────────────────────────────────────────

function makeHandlers(ctx) {
  /** 带签名的地址：token 对得上才给（工具输出里的链接、工具块里的小播放器走这条） */
  async function media(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const file = url.searchParams.get('p') || ''
    if (!fenceOk(req, ownHost(ctx)) || !tokenOk(file, url.searchParams.get('t'))) return reply(res, 403, 'forbidden')
    const f = await mediaFile(file, res)
    if (f) stream(req, res, f)
  }

  /** 没 token 的地址（turnTail、侧边栏只知道路径）：要 DSH 的登录态 */
  async function preview(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const file = url.searchParams.get('p') || ''
    const conn = connectionOf(ctx)
    if (conn) {
      const rejected = conn.requestRejection(req)
      if (rejected) return reply(res, rejected, rejected === 401 ? 'unauthorized' : 'forbidden')
    } else if (!LOOPBACK.has(req.socket.remoteAddress) || !fenceOk(req, ownHost(ctx))) {
      return reply(res, 403, 'forbidden')
    }
    const f = await mediaFile(file, res)
    if (f) stream(req, res, f)
  }

  // 宿主会 await 处理函数、接住抛出的错（读盘的错 mediaFile 自己已经接住）
  return { media, preview }
}

/** 只认单段 Range；格式不对或多段就当没带（回整个文件），起点越界才 416 */
function parseRange(header, total) {
  if (!header || total === 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, total - n), end: total - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
  if (start >= total) return 'unsatisfiable'
  if (end < start) return null
  return { start, end }
}

/** 流式回文件，支持 Range（能拖进度条）。读盘出错只断这一个请求，不能把 DSH 带崩 */
function stream(req, res, { real, stat }) {
  const total = stat.size
  const head = {
    ...MARK,
    // 整个文件多大：前端卡片上显示用（Content-Length 遇到 Range 只是一段，还可能被宿主中间件拿掉）
    'X-DSH-Video-Size': String(total),
    'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  const range = parseRange(req.headers.range, total)
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${total}` })
    return res.end()
  }
  if (range) {
    res.writeHead(206, { ...head, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${total}` })
  } else {
    res.writeHead(200, { ...head, 'Content-Length': total })
  }
  if (req.method === 'HEAD' || total === 0) return res.end()
  // pipeline：读盘出错或对方中途断开，两头都会被关掉，fd 不漏、错误不往外抛
  pipeline(fs.createReadStream(real, range || {}), res, () => {})
}

// ── 工具外壳（不 import 任何 @deepseek-ai/*，形状按 dsh-tools 的产出手搓）──────

function specToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: { schema: options.output.schema, render: options.output.render },
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    execute: options.execute,
  }
}

function fmtSize(n) {
  if (n > 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB'
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  return Math.round(n / 1024) + ' KB'
}

export function apply(ctx) {
  const handlers = makeHandlers(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: handlers.media,
  }), 'dsh-video-preview: media route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEW_ROUTE,
    handler: handlers.preview,
  }), 'dsh-video-preview: preview route')

  const tool = defineTool({
    name: 'play_video',
    description:
      '在对话里直接播放一个本地视频或音频文件，播放器出现在回复正下方，能拖进度条。' +
      '用户想看 / 听某个已有的本地媒体文件时用它。' +
      '你这一轮里自己生成、录制、下载、转码出来的视频音频不用调它：回复里写出文件的完整路径，回合结束时播放器会自动出现。' +
      '能播：mp4 m4v mov webm ogv mkv、mp3 wav ogg m4a aac flac opus。' +
      'avi / flv / wmv / wma / ts / mpg 这类播不了，要先用 ffmpeg 转成 mp4（音频转 m4a）再播。' +
      '大文件不会读进内存，走 HTTP Range 流式传输。',
    parameters: {
      path: { type: 'string', required: true, description: '本地文件的绝对路径，例如 /Users/me/Movies/a.mp4' },
      title: { type: 'string', description: '可选：播放器上方显示的标题，默认用文件名' },
      autoplay: { type: 'boolean', description: '可选：是否自动播放（默认 false，浏览器通常也会拦）' },
      loop: { type: 'boolean', description: '可选：是否循环播放（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          url: { type: 'string' },
          kind: { type: 'string' },
          name: { type: 'string' },
          size: { type: 'string' },
        },
        required: ['text', 'url'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 客户端 toolview 从这里读 url / kind / name
    // 这里拿不到会话：相对路径不知道按哪个目录算，不签名（地址以工具输出为准，不能按 DSH 进程目录猜）
    presentCall: (args) => {
      const raw = String(args.path || '')
      const file = resolvePath(raw, '')
      let info = { url: '', kind: 'video', name: path.basename(file || raw), size: '', path: file || raw }
      if (file) {
        try {
          const st = fs.statSync(file)
          info = {
            ...info,
            url: urlFor(file),
            kind: kindOf(file) || 'video',
            size: fmtSize(st.size),
          }
        } catch { /* 文件不存在时前端会显示错误 */ }
      }
      return {
        card: 'video-preview',
        kind: 'other',
        title: args.title || info.name,
        rawInput: args,
        ...info,
        autoplay: !!args.autoplay,
        loop: !!args.loop,
      }
    },
    async execute(args, exec) {
      const raw = String(args.path || '')
      if (!raw) throw new Error('path 不能为空')
      const agent = (exec && exec.agent) || undefined
      const session = agent && agent.session
      // 相对路径按会话的工作目录算（和官方 present 一样），不按 DSH 进程的目录
      const file = resolvePath(raw, session ? sessionCwd(ctx, session) : '')
      if (!file) throw new Error(`拿不到会话的工作目录，请给绝对路径：${raw}`)
      let st
      try {
        st = await fs.promises.stat(file)
      } catch {
        throw new Error(`找不到文件：${file}`)
      }
      if (!st.isFile()) throw new Error(`不是文件：${file}`)
      const ext = path.extname(file).toLowerCase()
      if (UNPLAYABLE_EXT.has(ext)) {
        const { out, cmd } = convertHint(file)
        throw new Error(
          `DSH 的播放器（Chromium 内核）放不了 ${ext} 格式。先转成 ${path.extname(out)} 再播：\n${cmd}\n` +
          `没装 ffmpeg 的话：brew install ffmpeg。转好后用 play_video 播 ${out}`)
      }
      const kind = kindOf(file)
      if (!kind) {
        throw new Error(`不支持的格式：${ext || '（没有扩展名）'}。能播的：${[...VIDEO_EXT, ...AUDIO_EXT].join(' ')}`)
      }
      const url = urlFor(file)
      const label = args.title || path.basename(file)

      // 照官方 present 工具的机制：把视频作为 deliverable 呈现 →
      // turnTail 渲染内联播放器 + 原生文件芯片（在侧边栏预览）
      // title / autoplay / loop 跟着文件走，回复下方的播放器从这里读
      try {
        if (session && ctx.sessionProjections && typeof session.append === 'function') {
          const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
          if (boundary && Number.isInteger(boundary.lastTurn)) {
            session.append('deliverables/presented', {
              turn: boundary.lastTurn,
              callId: (exec && exec.callId) || 'play_video',
              files: [{
                path: file,
                description: `▶️ ${label}`,
                ...(args.title ? { title: String(args.title) } : {}),
                ...(args.autoplay ? { autoplay: true } : {}),
                ...(args.loop ? { loop: true } : {}),
              }],
            })
          }
        }
      } catch { /* 呈现失败不影响播放本体 */ }

      return {
        text: `▶️ ${label}（${kind === 'video' ? '视频' : '音频'}，${fmtSize(st.size)}）\n${url}`,
        url,
        kind,
        name: path.basename(file),
        size: fmtSize(st.size),
      }
    },
  })

  ctx.tools.register(tool)

  if (typeof ctx.on === 'function') {
    autoPresent(ctx, {
      kindOf,
      log: (e) => {
        try { ctx.logger.warn(`dsh-video-preview: 自动呈现出错：${e && e.message ? e.message : e}`) } catch { /* 没 logger 就算了 */ }
      },
    })
  }
}
