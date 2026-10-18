/**
 * 路由和工具的回归测试（不用开 DSH）：
 *   node test/test-routes.mjs
 *
 * 用一个假的 ctx 把插件装起来，真起一个 HTTP 服务打它：
 * 把门（Host / 跨站 / Origin / 登录态 / 只给媒体文件 / 软链接）、Range、HEAD、读盘出错不崩、
 * play_video 对播不了的格式给转码建议。HOME 指到临时目录，不碰你自己的签名密钥。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvp-test-'))
process.env.HOME = tmp
const dir = path.join(tmp, 'media')
fs.mkdirSync(dir)
const body = Buffer.from('0123456789abcdef')
const files = {
  mp4: path.join(dir, 'a.mp4'),
  m4a: path.join(dir, 'b.m4a'),
  empty: path.join(dir, 'empty.mp4'),
  txt: path.join(dir, 'secret.txt'),
  link: path.join(dir, 'sneaky.mp4'),
  locked: path.join(dir, 'locked.mp4'),
  avi: path.join(dir, 'old.avi'),
  wma: path.join(dir, 'old.wma'),
  missing: path.join(dir, 'gone.mp4'),
}
fs.writeFileSync(files.mp4, body)
fs.writeFileSync(files.m4a, body)
fs.writeFileSync(files.empty, '')
fs.writeFileSync(files.txt, 'top secret')
fs.symlinkSync(files.txt, files.link)
fs.writeFileSync(files.locked, body)
fs.writeFileSync(files.avi, body)
fs.writeFileSync(files.wma, body)

const { apply } = await import(new URL('../lib/index.js', import.meta.url))

const routes = new Map()
const tools = new Map()
let conn = null
let port = 0
const appended = []
apply({
  effect: (fn) => fn(),
  webServer: {
    register: (r) => { routes.set(r.path, r.handler); return () => {} },
    getOrigin: () => `http://127.0.0.1:${port}`,
  },
  tools: { register: (t) => tools.set(t.name, t) },
  sessionProjections: { stateOf: () => ({ lastTurn: 3 }) },
  get: (name) => (name === 'connection' ? conn : undefined),
})

const server = http.createServer((req, res) => {
  const h = routes.get(new URL(req.url, 'http://x').pathname)
  if (h) return h(req, res)
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
port = server.address().port

const secret = fs.readFileSync(path.join(tmp, '.dsh', 'cache', 'dsh-video-preview.secret'), 'utf8').trim()
const sign = (f) => crypto.createHmac('sha256', secret).update(f).digest('hex').slice(0, 32)
const media = (f, t = sign(f)) => `/dsh-video-preview/media?t=${t}&p=${encodeURIComponent(f)}`
const preview = (f) => `/dsh-video-preview/preview?p=${encodeURIComponent(f)}`

function get(p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted: true }))
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.end()
  })
}

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✓ ${name}`) } else { fail++; console.log(`✗ ${name} ${extra}`) }
}

try {
  // ── media（带签名）──
  let r = await get(media(files.mp4))
  check('media：签名对 → 200 + 整个文件 + 标记头', r.status === 200 && r.body.equals(body) && r.headers['x-dsh-video-preview'] === '1', r.status)
  check('media：Content-Type 是 video/mp4', r.headers['content-type'] === 'video/mp4', r.headers['content-type'])
  r = await get(media(files.mp4), { headers: { range: 'bytes=2-5' } })
  check('Range 2-5 → 206 + 对应字节', r.status === 206 && r.body.toString() === '2345' && r.headers['content-range'] === `bytes 2-5/${body.length}`, `${r.status} ${r.headers['content-range']}`)
  r = await get(media(files.mp4), { headers: { range: 'bytes=-3' } })
  check('Range 后 3 字节', r.status === 206 && r.body.toString() === 'def', r.status)
  r = await get(media(files.mp4), { headers: { range: 'bytes=10-' } })
  check('Range 10- → 到结尾', r.status === 206 && r.body.toString() === 'abcdef', r.status)
  r = await get(media(files.mp4), { headers: { range: `bytes=${body.length}-` } })
  check('Range 起点越界 → 416', r.status === 416 && r.headers['content-range'] === `bytes */${body.length}`, r.status)
  r = await get(media(files.mp4), { headers: { range: 'bytes=5-2' } })
  check('Range 倒着写 → 当没带，回 200', r.status === 200 && r.body.equals(body), r.status)
  r = await get(media(files.mp4), { headers: { range: 'bytes=0-1,4-5' } })
  check('多段 Range → 回 200 整个文件', r.status === 200 && r.body.equals(body), r.status)
  r = await get(media(files.mp4), { method: 'HEAD' })
  check('HEAD → 200、只回头', r.status === 200 && r.body.length === 0 && r.headers['content-length'] === String(body.length), r.status)
  check('HEAD 带整个文件大小的头', r.headers['x-dsh-video-size'] === String(body.length), r.headers['x-dsh-video-size'])
  r = await get(media(files.mp4), { headers: { range: 'bytes=2-5' } })
  check('Range 时大小头还是整个文件', r.headers['x-dsh-video-size'] === String(body.length), r.headers['x-dsh-video-size'])
  r = await get(media(files.empty))
  check('空文件 → 200、长度 0', r.status === 200 && r.body.length === 0, r.status)
  r = await get(media(files.empty), { headers: { range: 'bytes=0-' } })
  check('空文件带 Range → 200 不报错', r.status === 200, r.status)
  r = await get(media(files.m4a))
  check('音频 m4a → audio/mp4', r.status === 200 && r.headers['content-type'] === 'audio/mp4', r.headers['content-type'])

  r = await get(media(files.mp4, 'deadbeef'))
  check('签名错 → 403', r.status === 403)
  r = await get(media(files.mp4), { headers: { host: `evil.example:${port}` } })
  check('Host 不是本机（DNS 重绑定）→ 403', r.status === 403, r.status)
  r = await get(media(files.mp4), { headers: { 'sec-fetch-site': 'cross-site' } })
  check('跨站请求 → 403', r.status === 403, r.status)
  r = await get(media(files.mp4), { headers: { origin: 'http://evil.example' } })
  check('Origin 不是自己 → 403', r.status === 403, r.status)
  r = await get(media(files.mp4), { headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } })
  check('Origin 是自己 → 200', r.status === 200, r.status)
  r = await get(media(files.txt))
  check('签名对但不是媒体文件 → 403', r.status === 403, r.status)
  r = await get(media(files.link))
  check('软链接 .mp4 指向 .txt → 403', r.status === 403, r.status)
  r = await get(media(files.missing))
  check('文件不在 → 404', r.status === 404, r.status)

  fs.chmodSync(files.locked, 0)
  r = await get(media(files.locked))
  check('没权限读的文件 → 403，不往外抛错', r.status === 403, r.status)
  r = await get(media(files.mp4))
  check('……而且服务还活着', r.status === 200, r.status)
  fs.chmodSync(files.locked, 0o644)

  const big = path.join(dir, 'big.mp4')
  fs.writeFileSync(big, Buffer.alloc(32 << 20))
  const aborted = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: media(big), headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.once('data', () => { req.destroy(); resolve(true) })
    })
    req.on('error', () => {})
    req.end()
  })
  await new Promise((r) => setTimeout(r, 100))
  r = await get(media(files.mp4))
  check('播到一半关掉（32MB 文件）：服务照常', aborted && r.status === 200, r.status)

  // ── preview（没 token，靠登录态）──
  conn = null
  r = await get(preview(files.mp4))
  check('preview：拿不到 connection 服务时本机能播', r.status === 200 && r.body.equals(body), r.status)
  r = await get(preview(files.mp4), { headers: { host: `evil.example:${port}` } })
  check('preview：Host 不是本机 → 403', r.status === 403, r.status)
  r = await get(preview(path.resolve('package.json')), { headers: { host: `evil.example:${port}`, cookie: 'dsh-auth-x=1' } })
  check('preview：伪造 cookie 读任意文件（原来的漏洞）→ 403', r.status === 403 && !r.body.toString().includes('"name"'), r.status)
  r = await get(preview(files.txt), { headers: { cookie: 'dsh-auth-x=1' } })
  check('preview：非媒体文件 → 403', r.status === 403, r.status)

  conn = { requestRejection: (req) => (String(req.headers.cookie || '').includes('dsh-auth-good=ok') ? undefined : 401) }
  r = await get(preview(files.mp4))
  check('preview：交给 DSH 验登录，没 cookie → 401', r.status === 401 && r.headers['x-dsh-video-preview'] === '1', r.status)
  r = await get(preview(files.mp4), { headers: { cookie: 'dsh-auth-forged=1' } })
  check('preview：伪造的 cookie → 401', r.status === 401, r.status)
  r = await get(preview(files.mp4), { headers: { cookie: 'dsh-auth-good=ok', range: 'bytes=0-3' } })
  check('preview：登录态对 → 206', r.status === 206 && r.body.toString() === '0123', r.status)
  r = await get(preview('/etc/hosts'), { headers: { cookie: 'dsh-auth-good=ok' } })
  check('preview：登录了也不给非媒体文件', r.status === 403, r.status)

  // ── play_video 工具 ──
  const tool = tools.get('play_video')
  const exec = { callId: 'c1', agent: { session: { append: (type, data) => appended.push({ type, data }) } } }
  const out = await tool.execute({ path: files.mp4, title: '样片' }, exec)
  check('工具：mp4 → 带签名的地址', out.url === media(files.mp4) && out.kind === 'video', out.url)
  check('工具：作为交付文件呈现', appended.length === 1 && appended[0].type === 'deliverables/presented' && appended[0].data.turn === 3)
  const errOf = async (args) => { try { await tool.execute(args, {}); return '' } catch (e) { return e.message } }
  let m = await errOf({ path: files.avi })
  check('工具：avi → 说清楚播不了 + ffmpeg 转 mp4', /放不了 \.avi/.test(m) && m.includes('ffmpeg') && m.includes('old.mp4'), m)
  m = await errOf({ path: files.wma })
  check('工具：wma → 建议转 m4a', m.includes('old.m4a'), m)
  m = await errOf({ path: files.txt })
  check('工具：txt → 不支持的格式', m.includes('不支持的格式'), m)
  m = await errOf({ path: files.missing })
  check('工具：文件不在 → 找不到文件', m.includes('找不到文件'), m)
  m = await errOf({ path: '~/media/a.mp4' })
  check('工具：支持 ~ 开头的路径', m === '', m)
} finally {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
