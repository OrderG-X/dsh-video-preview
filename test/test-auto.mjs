/**
 * 自动呈现的测试（不用开 DSH）：
 *   node test/test-auto.mjs
 *
 * 喂一串假的 session/event，看回合结束时会不会、该不该自动挂上播放器：
 * 新文件挂、老文件不挂、正文优先、带空格的路径、相对路径、已经播过的不重复、重放历史不动手。
 * （ctime 改不了，「真·老文件」只能先建好再真等过时间余量，所以这个测试要跑两秒多）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvp-auto-'))
process.env.HOME = process.env.USERPROFILE = tmp
const { autoPresent, candidatesIn, fromBashPath } = await import(new URL('../lib/auto-present.js', import.meta.url))

const dir = path.join(tmp, 'My Movies')
fs.mkdirSync(dir)
// old：只把修改时间改到一小时前（像下载、解压出来的文件）；ctime 还是现在
const make = (name, { old = false, size = 16, at = dir } = {}) => {
  const p = path.join(at, name)
  fs.writeFileSync(p, Buffer.alloc(size, 1))
  if (old) {
    const t = new Date(Date.now() - 3600e3)
    fs.utimesSync(p, t, t)
  }
  return p
}
// 真·老文件：这一轮开始前就在，修改时间、ctime、创建时间都旧
const dirA = path.join(tmp, 'A')
const dirB = path.join(tmp, 'B')
fs.mkdirSync(dirA)
fs.mkdirSync(dirB)
const stale = make('old.mp4')
const oldA = make('result.mp4', { at: dirA })
await new Promise((r) => setTimeout(r, 2300)) // 等过 CLOCK_SLACK_MS（2 秒）
const newB = make('result.mp4', { at: dirB })
const rec = make('录屏 1.mov')
const voice = make('voice.m4a')
const empty = make('empty.mp4', { size: 0 })
const notes = make('notes.txt')
const cut = make('cut.mp4')
const tmpClip = make('tmp-clip.webm')

const kindOf = (f) => (/\.(mp4|mov|webm)$/i.test(f) ? 'video' : /\.(m4a|mp3)$/i.test(f) ? 'audio' : null)
let listener
let stopping
autoPresent({
  on: (name, fn) => { if (name === 'session/event') listener = fn; if (name === 'agent/turn-stopping') stopping = fn },
  // 和 DSH 一样：会话里切过的目录在 workingDirectory 投影里，没切过就是 undefined
  sessionProjections: { stateOf: (s, key) => (key === 'workingDirectory' ? s.wd : undefined) },
}, { kindOf })

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✓ ${name}`) } else { fail++; console.log(`✗ ${name} ${extra}`) }
}

check('Git Bash 路径 /c/Users/… → C:\\Users\\…（Windows）', fromBashPath('/c/Users/张三/a b/x.mp4', 'win32') === 'C:\\Users\\张三\\a b\\x.mp4', fromBashPath('/c/Users/张三/a b/x.mp4', 'win32'))
check('Git Bash 路径：只有盘符 /d → D:\\', fromBashPath('/d', 'win32') === 'D:\\')
check('Git Bash 路径：不是盘符开头的不动', fromBashPath('/Users/x/a.mp4', 'win32') === '/Users/x/a.mp4')
check('Git Bash 路径：别的系统不动', fromBashPath('/c/x.mp4', 'darwin') === '/c/x.mp4')

let seq = 0
/** 跑一轮：events 里是 [type, data]，返回回合结束后 append 出来的东西 */
async function runTurn(events, { turn = 1, time = Date.now() - 1000, endTime = Date.now(), cwd = tmp, wd, stop = 1 } = {}) {
  const appended = []
  // 和 DSH 一样：建会话时的目录在 header.cwd，会话对象上没有 cwd
  const session = { header: { cwd }, wd, append: (type, data) => { appended.push({ type, data, ended }); send(type, data) } }
  let ended = false
  const send = (type, data, t = Date.now()) => listener(session, { type, seq: seq++, time: t, data: { turn, ...data } })
  send('turn/start', {}, time)
  for (const [type, data] of events) send(type, data)
  for (let i = 0; i < stop; i++) await stopping({ agent: { session }, turn, signal: new AbortController().signal })
  ended = true
  send('turn/end', { reason: { kind: 'completed' } }, endTime)
  await new Promise((r) => setTimeout(r, 50))
  return appended
}
const call = (command) => ['tool/call', { callId: 'c', name: 'bash', arguments: JSON.stringify({ command }) }]
const result = (text, cwd) => ['tool/result', { message: { content: [{ type: 'text', text }], isError: false }, ...(cwd ? { meta: { cwd } } : {}) }]
const say = (text) => ['assistant/message', { message: { content: [{ type: 'reasoning', text: '想想：' + stale }, { type: 'text', text }] } }]
const paths = (out) => (out[0] ? out[0].data.files.map((f) => f.path) : [])

// 挖路径
const g = candidatesIn(`已保存到 /Users/me/My Movies/a.mp4。`)
check('挖路径：带空格的完整路径排在半截前面', g.length === 1 && g[0].indexOf('/Users/me/My Movies/a.mp4') >= 0 && g[0].indexOf('/Users/me/My Movies/a.mp4') < g[0].indexOf('Movies/a.mp4'), JSON.stringify(g))
check('挖路径：普通文字里没有就是空', candidatesIn('今天天气不错').length === 0)
check('挖路径：.mp4x 不算', candidatesIn('/a/b.mp4x').length === 0)

// 正文提到新文件 → 自动挂
let out = await runTurn([call(`screencapture -v -V 3 "${rec}"`), result(''), say(`录好了：${rec}`)])
check('录屏：正文写了路径 → 自动呈现', paths(out).length === 1 && paths(out)[0] === rec, JSON.stringify(paths(out)))
check('录屏：走 deliverables/presented、turn 对、callId 有', out[0] && out[0].type === 'deliverables/presented' && out[0].data.turn === 1 && out[0].data.callId.length > 0)
check('录屏：说明里带文件名', out[0] && out[0].data.files[0].description.includes('录屏 1.mov'))
check('录屏：在回合收尾前就挂上（界面实时能看到）', out[0] && out[0].ended === false)

// 收尾钩子跑两次（有人续了一步）→ 不重复挂
out = await runTurn([say(`录好了：${rec}`)], { stop: 2 })
check('收尾钩子跑两次也只挂一次', out.length === 1, out.length)

// 中途停掉，收尾钩子没跑 → turn/end 时补挂
out = await runTurn([say(`录好了：${rec}`)], { stop: 0 })
check('中途停掉 → turn/end 时补挂', out.length === 1 && out[0].ended === true && paths(out).join() === rec, JSON.stringify(out))

// 正文没提，命令里有 → 用命令里的
out = await runTurn([call(`say -o "${voice}" hi`), result('done'), say('好了')])
check('正文没提路径 → 用命令里挖到的', paths(out).join() === voice, JSON.stringify(paths(out)))

// 正文优先：命令里的中间文件不挂
out = await runTurn([call(`cp x "${tmpClip}" && mv x "${cut}"`), result(''), say(`剪好了 **${cut}**`)])
check('正文提到成品 → 只挂成品，中间文件不挂', paths(out).join() === cut, JSON.stringify(paths(out)))

// 老文件、空文件、非媒体、reasoning 里提到的都不挂
out = await runTurn([call(`ls "${dir}"`), result(`${stale}\n${empty}\n${notes}`), say(`找到了 ${stale} 和 ${notes}`)], { time: Date.now() })
check('老文件 / 空文件 / 非媒体 / 想法里的都不挂', out.length === 0, JSON.stringify(paths(out)))

// 下载、解压出来的：修改时间是旧的，但 ctime / 创建时间是这一轮
const fetched = make('downloaded.mp4', { old: true })
out = await runTurn([say(`下载好了：${fetched}`)], { time: Date.now() })
check('下载 / 解压出来的（修改时间旧）也算新', paths(out).join() === fetched, JSON.stringify(paths(out)))

// 文件名字面就带 %20（curl -O 存下来的）：先按字面找
const pct = make('clip%20one.mp4')
out = await runTurn([say(`生成了 ${pct}`)])
check('文件名字面带 %20 → 按字面认', paths(out).join() === pct, JSON.stringify(paths(out)))
const spaced = make('clip one.mp4')
out = await runTurn([say(`生成了 ${pct}`)])
check('字面的和解码后的都在 → 认字面的', paths(out).join() === pct, JSON.stringify(paths(out)))
out = await runTurn([say(`生成了 ${voice.replace(/ /g, '%20')}`)])
check('URL 编码过的路径还是能解码认出来', paths(out).join() === voice, JSON.stringify(paths(out)))
fs.rmSync(spaced)

// 相对路径同名：先见的目录里是旧文件 → 接着看后面的目录
out = await runTurn([result('ok', dirA), result('ok', dirB), say('做好了 result.mp4')], { cwd: '/nonexistent', time: Date.now() })
check('同名相对路径：前一个目录里是旧的 → 用后面目录里新的', paths(out).join() === newB, JSON.stringify(paths(out)))
out = await runTurn([result('ok', dirB), result('ok', dirA), say('做好了 result.mp4')], { cwd: '/nonexistent', time: Date.now() })
check('同名相对路径：最后的目录里是旧的 → 还是用新的那个', paths(out).join() === newB, JSON.stringify(paths(out)))
out = await runTurn([say('做好了 result.mp4')], { cwd: dirA, time: Date.now() })
check('同名相对路径：只有旧的 → 不挂', out.length === 0, JSON.stringify(paths(out)))
make('result.mp4', { at: dirA }) // A 里也写成新的
out = await runTurn([result('ok', dirA), result('ok', dirB), say('做好了 result.mp4')], { cwd: '/nonexistent' })
check('同名相对路径：都是新的 → 取最后一个工具的目录（B）', paths(out).join() === newB, JSON.stringify(paths(out)))
out = await runTurn([result('ok', dirB), result('ok', dirA), say('做好了 result.mp4')], { cwd: '/nonexistent' })
check('同名相对路径：都是新的 → 取最后一个工具的目录（A）', paths(out).join() === oldA, JSON.stringify(paths(out)))

// 会话的工作目录：header.cwd；会话里切过目录（workingDirectory 投影）以切过的为准
out = await runTurn([say('做好了 result.mp4')], { cwd: dirB })
check('相对路径按会话头里的 cwd 找', paths(out).join() === newB, JSON.stringify(paths(out)))
out = await runTurn([say('做好了 result.mp4')], { cwd: dirB, wd: dirA })
check('会话里切过目录 → 按切过的目录找', paths(out).join() === oldA, JSON.stringify(paths(out)))

// 相对路径按工具的工作目录找
out = await runTurn([call('cd sub && make'), result('wrote cut.mp4', dir), say('做好了 cut.mp4')], { cwd: '/nonexistent' })
check('相对路径按工具的 cwd 找', paths(out).join() === cut, JSON.stringify(paths(out)))

// shell 转义的空格
out = await runTurn([say(`在这：${rec.replace(/ /g, '\\ ')}`)])
check('shell 转义的空格也认', paths(out).join() === rec, JSON.stringify(paths(out)))

// 已经用 play_video 播过的不重复
out = await runTurn([['deliverables/presented', { callId: 'p', files: [{ path: rec }] }], say(`看 ${rec} 和 ${voice}`)])
check('已经呈现过的不重复，只补没呈现的', paths(out).join() === voice, JSON.stringify(paths(out)))

// 正文提到的成品已经用 play_video 播过 → 不退回去挂命令里的中间文件
out = await runTurn([call(`cp x "${tmpClip}"`), ['deliverables/presented', { callId: 'p', files: [{ path: cut }] }], say(`成品：${cut}`)])
check('成品已经播过 → 中间文件也不挂', out.length === 0, JSON.stringify(paths(out)))

// 一个都没有 → 什么都不 append
out = await runTurn([say('没有视频')])
check('没东西 → 不 append', out.length === 0)

// 重放历史：turn/end 是很久以前的 → 不动手
out = await runTurn([say(`录好了：${rec}`)], { time: Date.now() - 600e3, endTime: Date.now() - 300e3, stop: 0 })
check('重放历史会话 → 不往老会话里补', out.length === 0)

// 别的轮次的事件不串
const appended = []
const session = { header: { cwd: tmp }, append: (type, data) => appended.push({ type, data }) }
listener(session, { type: 'turn/start', time: Date.now() - 1000, data: { turn: 5 } })
listener(session, { type: 'assistant/message', time: Date.now(), data: { turn: 4, message: { content: [{ type: 'text', text: rec }] } } })
listener(session, { type: 'turn/end', time: Date.now(), data: { turn: 5 } })
await new Promise((r) => setTimeout(r, 50))
check('上一轮的消息不算进这一轮', appended.length === 0)

// 坏事件不抛
let threw = false
try {
  listener(session, { type: 'tool/call', data: { turn: 5, arguments: '{bad json' } })
  listener(session, null)
  listener(session, { type: 'turn/end' })
} catch { threw = true }
check('坏事件不往外抛', !threw)

// 最多 8 个
const many = Array.from({ length: 12 }, (_, i) => make(`clip${i}.mp4`))
out = await runTurn([say(many.join('\n'))])
check('一轮最多挂 8 个', paths(out).length === 8, paths(out).length)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
