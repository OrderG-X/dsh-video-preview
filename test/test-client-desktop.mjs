/**
 * 桌面版客户端测试（不用开 DSH）：
 *   node test/test-client-desktop.mjs
 *
 * 桌面版的页面在 dsh-app:// 下，经它转发的媒体拖不了进度条。这里假装在 dsh-app://app/ 里，
 * 用一个最小的 hooks 实现把回复下方的播放器跑一遍：先不给 src → 问 /direct 要直连地址 → 换上；
 * 直连地址出错退回转发地址，再出错才去诊断。
 */
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PKG = '@orderg-x/dsh-video-preview'

// 最小 hooks：每次整棵重画前把下标归零，状态按调用顺序存
let hooks = []
let at = 0
const effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => {
    const k = at++
    if (!(k in hooks)) hooks[k] = init
    return [hooks[k], (v) => { hooks[k] = typeof v === 'function' ? v(hooks[k]) : v }]
  },
  useEffect: (fn) => { at++; effects.push(fn) },
  useRef: (v = null) => { at++; return { current: v } },
}

const calls = []
const DIRECT = 'http://127.0.0.1:4321/dsh-video-preview/media?d=abc&e=9&p=%2Fm%2Fa.mp4'
let directStatus = 200
globalThis.fetch = async (url, init) => {
  calls.push(`${(init && init.method) || 'GET'} ${url}`)
  const head = { get: (k) => (k === 'x-dsh-video-preview' ? PKG : null) }
  if (String(url).startsWith('/dsh-video-preview/direct')) {
    return { status: directStatus, ok: directStatus === 200, headers: head, json: async () => ({ src: DIRECT }) }
  }
  return { status: 200, ok: true, headers: head }
}

let mod
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory((name) => (name === 'react' ? react : null)) } } }
globalThis.location = { href: 'dsh-app://app/' }
new Function(src)()

const slots = []
mod.apply({
  slots: { register: (opts, render) => { slots.push({ opts, render }); return () => {} } },
  documentPreviews: { register: () => {} },
  locale: { register: () => {}, t: () => '' },
  effect: (fn) => fn(),
})
const tick = () => new Promise((r) => setTimeout(r, 0))
await tick()

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✓ ${name}`) } else { fail++; console.log(`✗ ${name} ${extra}`) }
}
function findAll(el, pred, out = []) {
  if (!el || typeof el !== 'object') return out
  if (Array.isArray(el)) { for (const c of el) findAll(c, pred, out); return out }
  if (typeof el.type === 'function') return findAll(el.type(el.props), pred, out)
  if (pred(el)) out.push(el)
  return findAll(el.children, pred, out)
}

const tail = slots.find((s) => s.opts.name === 'conversation.chat.turnTail').render
const turn = { data: { get: (k) => (k === 'deliverables' ? { presented: [{ path: '/m/a.mp4' }] } : undefined) } }
const render = () => { at = 0; return findAll(tail({ turn }), (e) => e.type === 'video')[0] }
const runEffects = async () => { effects.splice(0).forEach((fn) => fn()); await tick(); await tick() }

let video = render()
check('桌面版：直连地址拿到之前不给 src（不先按转发地址加载）', video && video.props.src === undefined, video && video.props.src)
await runEffects()
check('桌面版：问 /direct 要直连地址', calls.includes(`GET /dsh-video-preview/direct?p=${encodeURIComponent('/m/a.mp4')}`), calls.join(' | '))
video = render()
check('桌面版：换上直连地址，带封面帧', video.props.src === DIRECT + '#t=0.1', video.props.src)

calls.length = 0
video.props.onError()
video = render()
check('直连出错 → 退回转发地址，不急着报错', video.props.src === `/dsh-video-preview/preview?p=${encodeURIComponent('/m/a.mp4')}#t=0.1` && !calls.some((c) => c.startsWith('HEAD')), `${video.props.src} ${calls.join(' | ')}`)
video.props.onError()
await tick()
check('转发地址也出错 → 才去诊断', calls.some((c) => c.startsWith('HEAD /dsh-video-preview/preview')), calls.join(' | '))

// 服务端不给直连（宿主不在本机地址上 / 旧版服务端）：照旧走转发
hooks = []
effects.length = 0
calls.length = 0
directStatus = 404
render()
await runEffects()
video = render()
check('不给直连 → 照旧用转发地址', video.props.src === `/dsh-video-preview/preview?p=${encodeURIComponent('/m/a.mp4')}#t=0.1` && calls.some((c) => c.startsWith('GET /dsh-video-preview/direct')), `${video.props.src} ${calls.join(' | ')}`)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
