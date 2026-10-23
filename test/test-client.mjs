/**
 * 客户端冒烟测试（不用开 DSH）：
 *   node test/test-client.mjs
 *
 * 用假的 __ModuleLoader__ / react / slots 把 lib/client.js 跑一遍：三个挂载点都注册上，
 * 几种输入渲染不抛错，播放出错时按服务端的回应给出对应的人话。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 极简 react：createElement 只记结构；useState 记在全局，方便测试里触发 setState
const states = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => { const box = { v: init }; states.push(box); return [box.v, (v) => { box.v = typeof v === 'function' ? v(box.v) : v }] },
  useEffect: () => {},
  useRef: (v = null) => ({ current: v }),
}
const realUseState = react.useState
let mod
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory((name) => (name === 'react' ? react : null)) } } }
globalThis.location = { href: 'http://127.0.0.1:1234/' }
new Function(src)()

const PKG = '@orderg-x/dsh-video-preview'
const tick = () => new Promise((r) => setTimeout(r, 0))
const heads = []
// 服务端每个回应都带 X-DSH-Video-Preview：新版的值是包名，旧版是 '1'；null = 路由还没挂上
const serving = (who) => async (url, init) => {
  heads.push(`${(init && init.method) || 'GET'} ${url}`)
  return { status: who ? 403 : 404, ok: false, headers: { get: (k) => (k === 'x-dsh-video-preview' ? who : null) } }
}
function fakeCtx() {
  const c = { slots: [], previews: [], disposers: [] }
  c.ctx = {
    slots: { register: (opts, render) => { c.slots.push({ opts, render }); return () => {} } },
    documentPreviews: { register: (o) => c.previews.push(o) },
    locale: { register: () => {}, t: () => '' },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') c.disposers.push(d) },
  }
  return c
}

// 改名后旧版 dsh-video-preview 还装着：是旧版服务端在应答，新版客户端一个槽都不挂
globalThis.fetch = serving('1')
const old = fakeCtx()
mod.apply(old.ctx)
await tick()
const oldCopyQuiet = old.slots.length === 0 && old.previews.length === 0 && heads[0] === 'HEAD /dsh-video-preview/preview'
// 路由还没挂上（宿主刚起）：先不挂，过一会儿再问；插件被停用就别再问了
heads.length = 0
globalThis.fetch = serving(null)
const early = fakeCtx()
mod.apply(early.ctx)
await tick()
const earlyQuiet = early.slots.length === 0 && heads.length === 1
early.disposers.forEach((d) => d())
await new Promise((r) => setTimeout(r, 2100))
const stopsAfterDispose = heads.length === 1

globalThis.fetch = serving(PKG)
const own = fakeCtx()
const { slots, previews, ctx } = own
mod.apply(ctx)
await tick()

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✓ ${name}`) } else { fail++; console.log(`✗ ${name} ${extra}`) }
}
/** 把元素树里所有文字拼起来，顺便展开函数组件 */
function text(el) {
  if (el == null || el === false) return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(text).join('')
  if (typeof el.type === 'function') return text(el.type(el.props))
  return text(el.props && el.props.children) + (el.children || []).map(text).join('')
}
/** 把最外层的函数组件展开成它画出来的东西 */
const expand = (el) => (el && typeof el.type === 'function' ? expand(el.type(el.props)) : el)
function find(el, pred) {
  return findAll(el, pred)[0] || null
}
function findAll(el, pred, out = []) {
  if (!el || typeof el !== 'object') return out
  if (Array.isArray(el)) { for (const c of el) findAll(c, pred, out); return out }
  if (typeof el.type === 'function') return findAll(el.type(el.props), pred, out)
  if (pred(el)) out.push(el)
  return findAll(el.children, pred, out)
}

check('旧版服务端在应答（改名后旧版还装着）→ 新版客户端一个槽都不挂', oldCopyQuiet, JSON.stringify({ slots: old.slots.length, heads }))
check('路由还没挂上 → 先不挂，等会儿再问', earlyQuiet)
check('插件停用后不再去问', stopsAfterDispose, heads.join(','))

const names = slots.map((s) => s.opts.name)
check('挂上 toolview / turnTail / 侧边栏三个槽', ['tool.call.toolview', 'conversation.chat.turnTail', 'sidebar.right.tab.document'].every((n) => names.includes(n)), names.join(','))
check('侧边栏预览只认播得了的格式', previews.length === 1 && previews[0].extensions.includes('mp4') && !previews[0].extensions.includes('avi'), previews[0] && previews[0].extensions.join(' '))

const slot = (n) => slots.find((s) => s.opts.name === n).render
const turn = (paths) => ({ data: { get: (k) => (k === 'deliverables' ? { presented: paths.map((p) => (typeof p === 'string' ? { path: p } : p)) } : undefined) } })

const tail = (paths) => slot('conversation.chat.turnTail')({ turn: turn(paths) })
let el = tail(['/m/a.mp4', '/m/b.mp3', '/m/c.avi', '/m/a.mp4', '/m/readme.md'])
let videos = findAll(el, (e) => e.type === 'video')
let audios = findAll(el, (e) => e.type === 'audio')
check('turnTail：mp4 + mp3 各一个播放器，avi / md 不画，重复的去掉', videos.length === 1 && audios.length === 1, `${videos.length} ${audios.length}`)
check('turnTail：视频没开播时不带系统播放条、src 带封面帧', videos[0] && videos[0].props.controls === false && videos[0].props.src.endsWith('#t=0.1'))
check('turnTail：视频卡能用键盘点开', !!find(el, (e) => e.props && e.props.role === 'button' && e.props.tabIndex === 0))
check('turnTail：音频是自绘的条（系统播放条不露）', audios[0] && !audios[0].props.controls && !!find(el, (e) => e.props && e.props.role === 'slider'))
check('turnTail：音频条上有文件名', text(el).includes('b.mp3'))
check('turnTail：没有交付文件时什么都不画', expand(tail([])) === null)
el = tail(['/m/1.mp4', '/m/2.mp4', '/m/3.mp4', '/m/4.mp4', '/m/5.mp3'])
check('turnTail：5 个 → 先露 3 个 + 「还有 2 个」', findAll(el, (e) => e.type === 'video' || e.type === 'audio').length === 3 && text(el).includes('还有 2 个媒体文件'), text(el))
el = tail(['/m/1.mp4', '/m/2.mp4', '/m/3.mp4', '/m/4.mp4'])
check('turnTail：4 个 → 全露，不折叠', findAll(el, (e) => e.type === 'video').length === 4 && !text(el).includes('还有'))
el = tail([{ path: '/m/a.mp4', title: '演示', autoplay: true, loop: true }, { path: '/m/b.mp3', loop: true }, '/m/c.mp4'])
videos = findAll(el, (e) => e.type === 'video')
audios = findAll(el, (e) => e.type === 'audio')
check('turnTail：play_video 的 title / autoplay / loop 生效', videos[0].props.autoPlay === true && videos[0].props.loop === true && text(el).includes('演示') && !text(el).includes('a.mp4'), text(el))
check('turnTail：音频的 loop 也生效', audios[0].props.loop === true && audios[0].props.autoPlay === false)
check('turnTail：没带这些参数的照旧', videos[1].props.autoPlay === false && videos[1].props.loop === false && text(el).includes('c.mp4'))

el = slot('tool.call.toolview')({ block: { kind: 'tool-call' } })
check('工具块：还在跑 → 准备播放', text(el).includes('准备播放'))
el = slot('tool.call.toolview')({ block: { content: [{ type: 'text', text: '▶️ 样片（视频，1.0 MB）\n/dsh-video-preview/media?t=abc&p=%2Fm%2Fa.mp4' }] } })
check('工具块：从输出里挖出地址', !!find(el, (e) => e.type === 'video' && e.props.src.includes('/dsh-video-preview/media?t=abc')))
el = slot('tool.call.toolview')({ block: { content: [{ type: 'text', text: `▶️ a (1).mp4（视频，1.0 MB）\n/dsh-video-preview/media?t=abc&p=${encodeURIComponent('/m/a (1).mp4')}` }] } })
check('工具块：文件名带括号，地址不截断', !!find(el, (e) => e.type === 'video' && e.props.src === `/dsh-video-preview/media?t=abc&p=${encodeURIComponent('/m/a (1).mp4')}#t=0.1`), JSON.stringify(find(el, (e) => e.type === 'video')?.props.src))
el = slot('tool.call.toolview')({ block: { content: [], isError: true, error: { message: '找不到文件：/x.mp4' } } })
check('工具块：出错显示错误', text(el).includes('找不到文件'))

const sidebar = (props) => slot('sidebar.right.tab.document')(props)
const srcOf = (e) => (find(e, (x) => x.type === 'video' || x.type === 'audio') || { props: {} }).props.src || ''
// DSH 的地址：工作区外的绝对路径在会话 id 后面是 //
el = sidebar({ resourceAddress: 'dsh-resource://file/session/s1//m/song.flac' })
check('侧边栏：音频用 audio（绝对路径地址）', !!find(el, (e) => e.type === 'audio' && e.props.src === '/dsh-video-preview/preview?p=%2Fm%2Fsong.flac'), srcOf(el))
el = sidebar({ resourceAddress: { path: '/m/clip.mov' } })
check('侧边栏：视频用 video', !!find(el, (e) => e.type === 'video'))
el = sidebar({ resourceAddress: 'dsh-resource://file/absolute/m/a%20b.mp4' })
check('侧边栏：absolute 地址', srcOf(el) === '/dsh-video-preview/preview?p=%2Fm%2Fa%20b.mp4', srcOf(el))
// 工作区里的文件：地址里是相对路径，真实路径找宿主的 useResource 要
let asked = ''
el = sidebar({ resourceAddress: 'dsh-resource://file/session/s1/out%20put.mp4', useResource: (a) => { asked = a; return { status: 'live', value: { absolutePath: '/w/out put.mp4', version: '1' } } } })
check('侧边栏：相对路径用宿主给的 absolutePath', srcOf(el) === '/dsh-video-preview/preview?p=%2Fw%2Fout%20put.mp4' && asked === 'dsh-resource://file/session/s1/out%20put.mp4', srcOf(el))
el = sidebar({ resourceAddress: 'dsh-resource://file/session/s1/out.mp4', useResource: () => ({ status: 'loading' }) })
check('侧边栏：宿主还没解析完 → 准备中，不去根目录找', srcOf(el) === '' && text(el).includes('准备播放'), srcOf(el) + text(el))
el = sidebar({ resourceAddress: 'dsh-resource://file/session/s1/out.mp4', useResource: () => ({ status: 'failed', failure: {} }) })
check('侧边栏：宿主说找不到 → 文件找不到了', srcOf(el) === '' && text(el).includes('找不到'), srcOf(el) + text(el))
el = sidebar({ resourceAddress: 'dsh-resource://file/session/s1/out.mp4' })
check('侧边栏：老宿主没有 useResource → 不把相对路径当成 /out.mp4', srcOf(el) === '' && text(el).includes('拿不到文件路径'), srcOf(el) + text(el))
el = sidebar({ resourceAddress: 'dsh-resource://file/session/s1//m/a.mp4', useResource: () => ({ status: 'loading' }) })
check('侧边栏：绝对路径地址不用等宿主', srcOf(el) === '/dsh-video-preview/preview?p=%2Fm%2Fa.mp4', srcOf(el))

// 出错诊断：HEAD 回什么就说什么
async function diagnoseWith(response, file = '/m/x.mkv') {
  globalThis.fetch = async () => response
  states.length = 0
  let video = find(tail([file]), (e) => e.type === 'video')
  video.props.onError()
  await new Promise((r) => setTimeout(r, 0))
  const reason = states.find((s) => typeof s.v === 'string' && s.v).v
  // 用诊断结果重新渲染一次，拿到要显示的字
  react.useState = (init) => [typeof init === 'string' ? reason : init, () => {}]
  const shown = text(tail([file]))
  const code = find(tail([file]), (e) => e.props && e.props.className === 'dvp-code')
  react.useState = realUseState
  return { reason, text: shown, cmd: code ? text(code) : '' }
}
/** 让 sh 真的解析一遍转码命令（ffmpeg 换成 printf），看拿到的参数是不是原样的路径 */
const shArgs = (cmd) => execFileSync('/bin/sh', ['-c', cmd.replace(/^ffmpeg /, "printf '%s\\n' ")], { encoding: 'utf8' }).split('\n').slice(0, -1)
const ok = (status) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (k === 'x-dsh-video-preview' ? '1' : null) } })
let d = await diagnoseWith(ok(200))
check('出错 + 服务端 200 → 编码不支持，给 ffmpeg 命令', d.reason === 'unsupported' && d.cmd.startsWith("ffmpeg -i '/m/x.mkv'") && d.cmd.endsWith("'/m/x-h264.mp4'"), d.cmd)
d = await diagnoseWith(ok(200), '/m/y.mp4')
let args = shArgs(d.cmd)
check('mp4 编码不支持 → 转码输出名和输入不同（ffmpeg 不让同名）', args[1] === '/m/y.mp4' && args.at(-1) === '/m/y-h264.mp4', JSON.stringify(args))
const evil = `/m/a $(echo PWNED) \`echo X\` "q" it's.mp4`
d = await diagnoseWith(ok(200), evil)
args = shArgs(d.cmd)
check('转码命令：文件名里的 $(...) / 反引号 / 引号都只是字面', args[1] === evil && args.at(-1) === evil.replace(/\.mp4$/, '-h264.mp4') && !args.some((a) => a.includes('PWNED') && !a.includes('$(')), JSON.stringify(args))
d = await diagnoseWith(ok(404))
check('出错 + 404 → 文件找不到了', d.reason === 'notFound' && d.text.includes('找不到'), d.text)
d = await diagnoseWith(ok(401))
check('出错 + 401 → 没有权限', d.reason === 'denied', d.reason)
d = await diagnoseWith({ status: 404, ok: false, headers: { get: () => null } })
check('出错 + 不是插件回的 404 → 服务没挂上，提示重启', d.reason === 'noServer' && d.text.includes('重启'), d.text)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
