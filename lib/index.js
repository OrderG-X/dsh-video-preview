/**
 * dsh-video-preview —— 让 DSH 的对话流里能直接播视频。
 *
 * 背景：DSH 的渲染块只有 text / image / file / table，**没有 video**。
 * 所以官方路子里没法内联播放。这里换一条：
 *
 *   服务端  play_video 工具 → 返回一个带 token 的本地 URL
 *   路由    /dsh-video-preview/media  → 支持 HTTP Range 的流式响应（能拖进度条）
 *   客户端  tool.call.toolview 槽 → 渲染 <video controls>
 *
 * 客户端那块走的是官方客户端插件机制（跟 dsh-image-gen 内联图片同一个套路）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const name = 'dsh-video-preview'
export const inject = ['tools', 'webServer']

const ROUTE = '/dsh-video-preview/media'

/** 每次启动换一个 token —— 路由不是裸奔的 */
const TOKEN = crypto.randomBytes(16).toString('hex')

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv', '.ts', '.3gp', '.flv'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba', '.wma'])

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ogv': 'video/ogg', '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp', '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus',
  '.weba': 'audio/webm', '.wma': 'audio/x-ms-wma',
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

function urlFor(file) {
  const p = encodeURIComponent(file)
  return `${ROUTE}?t=${TOKEN}&p=${p}`
}

// ── 流式路由（支持 Range，所以能拖进度条）────────────────────────────────────

function mediaHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.searchParams.get('t') !== TOKEN) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    return res.end('forbidden')
  }
  const file = url.searchParams.get('p') || ''
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    return res.end('missing p')
  }
  let stat
  try {
    stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('not found')
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const total = stat.size
  const range = req.headers.range

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    return fs.createReadStream(file).pipe(res)
  }

  // Range: bytes=start-end
  const m = /bytes=(\d*)-(\d*)/.exec(range)
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` })
    return res.end()
  }
  let start = m[1] === '' ? total - Number(m[2]) : Number(m[1])
  let end = m[1] === '' || m[2] === '' ? total - 1 : Number(m[2])
  start = Math.max(0, Math.min(start, total - 1))
  end = Math.max(start, Math.min(end, total - 1))
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(file, { start, end }).pipe(res)
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
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: mediaHandler,
  }), 'dsh-video-preview: media route')

  const tool = defineTool({
    name: 'play_video',
    description:
      '在对话里内联播放一个本地视频或音频文件（mp4/webm/mov/mkv/avi/ogv/mp3/wav/flac…）。' +
      '传绝对路径即可，播放器会直接出现在消息里，可以拖进度条。' +
      '视频文件较大时不会读进内存 —— 走的是 HTTP Range 流式传输。',
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
    presentCall: (args) => {
      const file = path.resolve(String(args.path || '').replace(/^~(?=\/|$)/, process.env.HOME || '~'))
      let info = { url: '', kind: 'video', name: path.basename(file), size: '', path: file }
      try {
        const st = fs.statSync(file)
        info = {
          ...info,
          url: urlFor(file),
          kind: kindOf(file) || 'video',
          size: fmtSize(st.size),
        }
      } catch { /* 文件不存在时前端会显示错误 */ }
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
    async execute(args) {
      const raw = String(args.path || '')
      if (!raw) throw new Error('path 不能为空')
      const file = path.resolve(raw.replace(/^~(?=\/|$)/, process.env.HOME || '~'))
      let st
      try {
        st = fs.statSync(file)
      } catch {
        throw new Error(`找不到文件：${file}`)
      }
      if (!st.isFile()) throw new Error(`不是文件：${file}`)
      const kind = kindOf(file)
      if (!kind) {
        throw new Error(`不支持的格式：${path.extname(file)}（支持 ${[...VIDEO_EXT, ...AUDIO_EXT].join(' ')}）`)
      }
      const url = urlFor(file)
      const label = args.title || path.basename(file)
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
}
