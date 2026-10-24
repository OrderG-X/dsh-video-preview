/**
 * 自动呈现：这一轮里新生成的视频 / 音频，不用模型调 play_video，回合结束时自动挂上播放器。
 *
 * 做法（全走官方事件，不改 DSH）：
 *   session/event 里盯住这一轮的 tool/call（参数）、tool/result（输出）、assistant/message（回复正文），
 *   从里面挖出像媒体文件路径的字符串；回合收尾前（agent/turn-stopping）逐个 stat，
 *   留下「存在、是普通文件、这一轮里才写过」的，append 一条 deliverables/presented ——
 *   和 play_video / 官方 present 同一条通道，turnTail 播放器和交付芯片自然就出来了。
 *
 * 去噪：回复正文里提到的新文件优先（那是模型要交给用户的）；正文一个都没提，才用命令里挖到的。
 * 老文件（这一轮之前就有的）不算：修改时间、创建时间、ctime 任一落在这一轮里就算新
 * （下载、解压出来的文件修改时间常是旧的）；同一轮已经呈现过的不重复；最多 MAX_FILES 个。
 * 收尾钩子没跑到（中途停掉）才在实时的 turn/end 上补；重放历史时事件时间是旧的，不会往老会话里补东西。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXT_RE = /\.(mp4|m4v|mov|webm|ogv|mkv|3gp|mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)(?![A-Za-z0-9_])/gi
// 路径只会从这些字符后面开始（空白、引号、括号、= : , 等，含中文标点）
const BEFORE = new Set([...' \t"\'`=:,;()[]{}<>|*（）「」『』【】《》“”‘’，、：；'])
const MAX_STARTS = 12 // 每个扩展名往回最多试这么多个起点
const LOOKBACK = 1024 // 往回最多看这么远
const MAX_TOOL_GROUPS = 300
const MAX_TEXT_GROUPS = 100
const MAX_FILES = 8
const CLOCK_SLACK_MS = 2000 // 文件时间和事件时间的误差余量
const LIVE_MS = 120000 // turn/end 离现在超过这么久就当是重放

/**
 * 从一段文字里挖出可能是媒体路径的片段。
 * 每处 .mp4 之类的结尾给一组候选：从长到短（「/Users/me/My Movies/a.mp4」排在「Movies/a.mp4」前面），
 * 检查时取第一个真实存在的，这样带空格的路径也能认出来。
 */
export function candidatesIn(text) {
  const groups = []
  if (typeof text !== 'string' || !text) return groups
  for (const line of text.split(/\r?\n/)) {
    EXT_RE.lastIndex = 0
    let m
    while ((m = EXT_RE.exec(line))) {
      const end = m.index + m[0].length
      const from = Math.max(0, end - LOOKBACK)
      const starts = []
      for (let s = m.index - 1; s >= from && starts.length < MAX_STARTS; s--) {
        if (BEFORE.has(line[s])) continue
        if (s === 0 || BEFORE.has(line[s - 1])) starts.push(s)
      }
      if (starts.length) groups.push(starts.reverse().map((s) => line.slice(s, end)))
    }
  }
  return groups
}

/** 工具参数是 JSON 字符串：拆开把所有字符串值都拿出来（命令里的引号就不会挡路了） */
function stringsOf(value, out = []) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object') return stringsOf(parsed, out)
    } catch { /* 不是 JSON，就当普通文字 */ }
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) stringsOf(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) stringsOf(v, out)
  }
  return out
}

/** 消息里的文字块；assistant 的 reasoning 不算（那是打算，不是结果） */
function textsOf(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text)
}

/**
 * 会话现在的工作目录：DSH 的 workingDirectory 投影（会话里切过目录就是新的），
 * 没有就用会话头里建会话时的目录。都拿不到返回空串。
 */
export function sessionCwd(ctx, session) {
  let cwd
  try {
    cwd = ctx && ctx.sessionProjections && ctx.sessionProjections.stateOf(session, 'workingDirectory')
  } catch { /* 没装这个投影 */ }
  if (typeof cwd !== 'string' || !cwd) cwd = session && session.header && session.header.cwd
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : ''
}

/** Windows 上 DSH 用 Git Bash 跑命令，模型给的路径常是 /c/Users/… 这种写法：换成 C:\\Users\\…；别的系统原样 */
export function fromBashPath(p, platform = process.platform) {
  if (platform !== 'win32') return p
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p)
  return m ? `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}` : p
}

/**
 * 候选片段 → 每种写法一组绝对路径（相对路径按工作目录挨个试，越靠后的目录越新）。
 * 写法按顺序：字面的先试（文件名本身就可能带 %20），再试 URL 解码、shell 转义去掉的。
 */
function resolveAll(raw, cwds) {
  const p = raw.replace(/^file:\/\//i, '')
  const variants = [p]
  if (p.includes('%')) {
    try {
      const d = decodeURIComponent(p)
      if (d !== p) variants.push(d)
    } catch { /* 不是编码过的，只用字面的 */ }
  }
  for (const v of [...variants]) {
    if (!v.includes('\\')) continue
    // shell 里转义的空格：My\ Movies。Windows 上反斜杠是路径分隔符，只去掉空格前面那个
    variants.push(process.platform === 'win32' ? v.replace(/\\ /g, ' ') : v.replace(/\\(.)/g, '$1'))
  }
  return variants.map((v) => {
    v = fromBashPath(v)
    if (v === '~' || v.startsWith('~/')) v = path.join(os.homedir(), v.slice(1))
    return path.isAbsolute(v) ? [path.normalize(v)] : cwds.map((c) => path.resolve(c, v))
  })
}

/**
 * @param ctx 插件 ctx（要 ctx.on）
 * @param opts.kindOf 判断媒体类型（和路由同一把尺子）
 * @param opts.now 测试用
 * @param opts.log 出错时写日志
 */
export function autoPresent(ctx, { kindOf, now = Date.now, log = () => {} }) {
  const turns = new WeakMap()

  function addGroups(st, texts, tier) {
    const max = tier === 'text' ? MAX_TEXT_GROUPS : MAX_TOOL_GROUPS
    const list = st[tier]
    for (const t of texts) {
      for (const g of candidatesIn(t)) {
        if (list.length >= max) return
        const key = g[0]
        if (st.seen.has(tier + key)) continue
        st.seen.add(tier + key)
        list.push(g)
      }
    }
  }

  /** 这一轮里写过：修改时间、创建时间、ctime 任一落在这一轮里（下载、解压出来的修改时间常是旧的） */
  function isFresh(stat, st) {
    const t = Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0, stat.birthtimeMs || 0)
    return stat.isFile() && stat.size > 0 && t >= st.start - CLOCK_SLACK_MS
  }

  /**
   * 一组候选里取第一个存在的；它要是这一轮新写的媒体文件就返回路径。
   * 相对路径在好几个工作目录下都有：旧的跳过接着看，都是新的取最后一个目录（最近用过的）。
   */
  async function pick(group, st, cwds) {
    for (const raw of group) {
      for (const paths of resolveAll(raw, cwds)) {
        let exists = false
        let hit = null
        for (const p of paths) {
          let stat
          try { stat = await fs.promises.stat(p) } catch { continue }
          exists = true
          if (isFresh(stat, st) && kindOf(p)) hit = p
        }
        if (exists) return hit
      }
    }
    return null
  }

  /** 这些候选里「这一轮新写的媒体文件」，按出现顺序去重 */
  async function freshIn(groups, st, cwds) {
    const found = []
    for (const g of groups) {
      if (found.length >= MAX_FILES * 2) break
      const p = await pick(g, st, cwds)
      if (p && !found.includes(p)) found.push(p)
    }
    return found
  }

  /**
   * 挑出要呈现的文件并 append。回合收尾前（agent/turn-stopping）调一次，界面实时就能看到；
   * 收尾钩子没跑到（中途停掉、出错）才在 turn/end 补一次，那时要重新打开会话才看得到。
   * 可以重复调：已经呈现过的不会再来。
   */
  async function finish(session, st) {
    st.finished = true
    // 工具跑过的目录按最近用过的顺序排；会话的工作目录没被工具用过就排最前
    const base = sessionCwd(ctx, session)
    const cwds = [...st.cwds]
    if (base && !st.cwds.has(base)) cwds.unshift(base)
    // 正文里提到了新文件，就只认正文的（哪怕已经用 play_video 播过），命令里的中间文件不挂
    let fresh = await freshIn(st.text, st, cwds)
    if (!fresh.length) fresh = await freshIn(st.tool, st, cwds)
    const files = fresh.filter((p) => !st.presented.has(p)).slice(0, Math.max(0, MAX_FILES - st.auto))
    if (!files.length || typeof session.append !== 'function') return
    for (const p of files) st.presented.add(p)
    st.auto += files.length
    session.append('deliverables/presented', {
      turn: st.turn,
      callId: `dsh-video-preview:auto:${st.turn}:${++st.batches}`,
      files: files.map((p) => ({ path: p, description: `▶️ ${path.basename(p)}` })),
    })
  }

  function observe(session, event) {
    const d = (event && event.data) || {}
    if (event.type === 'turn/start') {
      turns.set(session, {
        turn: d.turn,
        start: typeof event.time === 'number' ? event.time : now(),
        cwds: new Set(), // 这一轮工具跑过的目录，最近用过的排最后
        text: [],
        tool: [],
        seen: new Set(),
        presented: new Set(),
        auto: 0,
        batches: 0,
        finished: false,
      })
      return
    }
    const st = turns.get(session)
    if (!st || (d.turn !== undefined && d.turn !== st.turn)) return
    switch (event.type) {
      case 'tool/call':
        addGroups(st, stringsOf(d.arguments), 'tool')
        break
      case 'tool/result':
        if (d.meta && typeof d.meta.cwd === 'string' && path.isAbsolute(d.meta.cwd)) {
          st.cwds.delete(d.meta.cwd)
          st.cwds.add(d.meta.cwd)
        }
        addGroups(st, textsOf(d.message && d.message.content), 'tool')
        break
      case 'assistant/message':
        addGroups(st, textsOf(d.message && d.message.content), 'text')
        break
      case 'deliverables/presented':
        for (const f of Array.isArray(d.files) ? d.files : []) {
          if (f && typeof f.path === 'string') st.presented.add(path.normalize(f.path))
        }
        break
      case 'turn/end': {
        turns.delete(session)
        const t = typeof event.time === 'number' ? event.time : now()
        if (st.finished || now() - t > LIVE_MS) return
        finish(session, st).catch((e) => log(e))
        break
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (session && event) observe(session, event)
    } catch (e) {
      log(e)
    }
  })

  // 回合正常收尾前：这时候 append，事件还在这一轮里，界面实时刷出播放器
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal } = {}) => {
    try {
      const session = agent && agent.session
      const st = session && turns.get(session)
      if (!st || st.turn !== turn || (signal && signal.aborted)) return
      await finish(session, st)
    } catch (e) {
      log(e)
    }
  })
}
