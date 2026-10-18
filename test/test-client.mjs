/**
 * 客户端冒烟测试（不用开 DSH）：
 *   node test/test-client.mjs
 *
 * 用假的 __ModuleLoader__ / react / slots 把 lib/client.js 跑一遍：三个挂载点都注册上，
 * 几种输入渲染不抛错，播放出错时按服务端的回应给出对应的人话。
 */
import fs from 'node:fs'

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

const slots = []
const previews = []
const ctx = {
  slots: { register: (opts, render) => { slots.push({ opts, render }); return () => {} } },
  documentPreviews: { register: (o) => previews.push(o) },
  locale: { register: () => {}, t: () => '' },
  effect: (fn) => fn(),
}
mod.apply(ctx)

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

const names = slots.map((s) => s.opts.name)
check('挂上 toolview / turnTail / 侧边栏三个槽', ['tool.call.toolview', 'conversation.chat.turnTail', 'sidebar.right.tab.document'].every((n) => names.includes(n)), names.join(','))
check('侧边栏预览只认播得了的格式', previews.length === 1 && previews[0].extensions.includes('mp4') && !previews[0].extensions.includes('avi'), previews[0] && previews[0].extensions.join(' '))

const slot = (n) => slots.find((s) => s.opts.name === n).render
const turn = (paths) => ({ data: { get: (k) => (k === 'deliverables' ? { presented: paths.map((p) => ({ path: p })) } : undefined) } })

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

el = slot('tool.call.toolview')({ block: { kind: 'tool-call' } })
check('工具块：还在跑 → 准备播放', text(el).includes('准备播放'))
el = slot('tool.call.toolview')({ block: { content: [{ type: 'text', text: '▶️ 样片（视频，1.0 MB）\n/dsh-video-preview/media?t=abc&p=%2Fm%2Fa.mp4' }] } })
check('工具块：从输出里挖出地址', !!find(el, (e) => e.type === 'video' && e.props.src.includes('/dsh-video-preview/media?t=abc')))
el = slot('tool.call.toolview')({ block: { content: [], isError: true, error: { message: '找不到文件：/x.mp4' } } })
check('工具块：出错显示错误', text(el).includes('找不到文件'))

el = slot('sidebar.right.tab.document')({ resourceAddress: 'dsh-resource://file/session/s1/m/song.flac' })
check('侧边栏：音频用 audio', !!find(el, (e) => e.type === 'audio' && e.props.src === '/dsh-video-preview/preview?p=%2Fm%2Fsong.flac'))
el = slot('sidebar.right.tab.document')({ resourceAddress: { path: '/m/clip.mov' } })
check('侧边栏：视频用 video', !!find(el, (e) => e.type === 'video'))

// 出错诊断：HEAD 回什么就说什么
async function diagnoseWith(response) {
  globalThis.fetch = async () => response
  states.length = 0
  let video = find(tail(['/m/x.mkv']), (e) => e.type === 'video')
  video.props.onError()
  await new Promise((r) => setTimeout(r, 0))
  const reason = states.find((s) => typeof s.v === 'string' && s.v).v
  // 用诊断结果重新渲染一次，拿到要显示的字
  react.useState = (init) => [typeof init === 'string' ? reason : init, () => {}]
  const shown = text(tail(['/m/x.mkv']))
  react.useState = realUseState
  return { reason, text: shown }
}
const ok = (status) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (k === 'x-dsh-video-preview' ? '1' : null) } })
let d = await diagnoseWith(ok(200))
check('出错 + 服务端 200 → 编码不支持，给 ffmpeg 命令', d.reason === 'unsupported' && d.text.includes('ffmpeg -i "/m/x.mkv"') && d.text.includes('/m/x.mp4'), d.text)
d = await diagnoseWith(ok(404))
check('出错 + 404 → 文件找不到了', d.reason === 'notFound' && d.text.includes('找不到'), d.text)
d = await diagnoseWith(ok(401))
check('出错 + 401 → 没有权限', d.reason === 'denied', d.reason)
d = await diagnoseWith({ status: 404, ok: false, headers: { get: () => null } })
check('出错 + 不是插件回的 404 → 服务没挂上，提示重启', d.reason === 'noServer' && d.text.includes('重启'), d.text)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
