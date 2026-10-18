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
 * 老文件（这一轮之前就有的）不算；同一轮已经呈现过的不重复；最多 MAX_FILES 个。
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

/** 候选片段 → 绝对路径（相对路径按这一轮见过的工作目录挨个试） */
function resolveAll(raw, cwds) {
  let p = raw.replace(/^file:\/\//i, '')
  if (p.includes('%')) {
    try { p = decodeURIComponent(p) } catch { /* 不是编码过的，原样用 */ }
  }
  const variants = [p]
  if (p.includes('\\')) variants.push(p.replace(/\\(.)/g, '$1')) // shell 里转义的空格：My\ Movies
  const out = []
  for (let v of variants) {
    if (v === '~' || v.startsWith('~/')) v = path.join(os.homedir(), v.slice(1))
    if (path.isAbsolute(v)) out.push(path.normalize(v))
    else for (const c of cwds) out.push(path.resolve(c, v))
  }
  return out
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

  /** 一组候选里取第一个存在的；它要是这一轮新写的媒体文件就返回路径 */
  async function pick(group, st) {
    for (const raw of group) {
      for (const p of resolveAll(raw, st.cwds)) {
        let stat
        try { stat = await fs.promises.stat(p) } catch { continue }
        const fresh = stat.isFile() && stat.size > 0 && stat.mtimeMs >= st.start - CLOCK_SLACK_MS
        return fresh && kindOf(p) ? p : null
      }
    }
    return null
  }

  /** 这些候选里「这一轮新写的媒体文件」，按出现顺序去重 */
  async function freshIn(groups, st) {
    const found = []
    for (const g of groups) {
      if (found.length >= MAX_FILES * 2) break
      const p = await pick(g, st)
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
    // 正文里提到了新文件，就只认正文的（哪怕已经用 play_video 播过），命令里的中间文件不挂
    let fresh = await freshIn(st.text, st)
    if (!fresh.length) fresh = await freshIn(st.tool, st)
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
      const cwds = new Set()
      if (typeof session.cwd === 'string' && session.cwd) cwds.add(session.cwd)
      turns.set(session, {
        turn: d.turn,
        start: typeof event.time === 'number' ? event.time : now(),
        cwds,
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
        if (d.meta && typeof d.meta.cwd === 'string' && d.meta.cwd) st.cwds.add(d.meta.cwd)
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
