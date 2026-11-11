/**
 * 无头浏览器的进程管理（不开真浏览器，用假进程）：node --test test/test-browser.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const { createBrowser } = await import(new URL('../lib/browser.js', import.meta.url))

/** 会走完 withPage 的假浏览器：log 记下收到的指令、强杀信号；log.stuck 时不理 Browser.close（只能强杀） */
function pageLaunch(log, { pid = 1, killDelay = 1 } = {}) {
  let opened = 0
  const launch = () => {
    opened++
    const p = new EventEmitter()
    const input = new PassThrough()
    const output = new PassThrough()
    p.pid = pid
    p.stdio = [null, null, null, input, output]
    p.kill = (sig) => { log.killed = sig || 'SIGTERM'; setTimeout(() => p.emit('exit', 0), killDelay) }
    let buf = ''
    input.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        log.push(msg.method)
        const r = (result) => output.write(JSON.stringify({ id: msg.id, result }) + '\0')
        if (msg.method === 'Target.createTarget') r({ targetId: 'T1' })
        else if (msg.method === 'Target.attachToTarget') r({ sessionId: 'S1' })
        else if (msg.method === 'Page.navigate') {
          r({ frameId: 'T1' })
          setTimeout(() => output.write(JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'S1', params: {} }) + '\0'), 2)
        } else if (msg.method === 'Browser.close') { r({}); if (!log.stuck) setTimeout(() => p.emit('exit', 0), 1) }
        else r({})
      }
    })
    return p
  }
  return { launch, opened: () => opened }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('关浏览器：先让它自己关（Browser.close），不强杀——强杀会在系统临时目录留下 com.google.Chrome.XXXXXX', async () => {
  const log = []
  const { launch } = pageLaunch(log)
  const b = createBrowser({ bin: '/fake/chrome', launch, platform: 'linux', idleMs: 10 })
  try {
    assert.equal(await b.withPage({ url: 'http://127.0.0.1:9/a.html', w: 100, h: 100 }, async () => 'x'), 'x')
    await wait(60)
    assert.equal(b.running(), false)
    assert.ok(log.includes('Browser.close'), log.join(','))
    assert.equal(log.killed, undefined)
  } finally { b.destroy() }
})

test('关浏览器：不肯自己退的到点强杀；关的途中新来的等它退了再开一个', async () => {
  const log = []
  log.stuck = true
  const { launch, opened } = pageLaunch(log)
  const b = createBrowser({ bin: '/fake/chrome', launch, platform: 'linux', idleMs: 10 })
  try {
    await b.withPage({ url: 'http://127.0.0.1:9/a.html', w: 100, h: 100 }, async () => 'x')
    await wait(60)
    assert.ok(log.includes('Browser.close'), '先请它自己关')
    const during = await b.withPage({ url: 'http://127.0.0.1:9/b.html', w: 100, h: 100 }, async () => 'ran')
    assert.equal(during, 'ran')
    assert.equal(log.killed, 'SIGKILL')
    assert.equal(opened(), 2)
  } finally { log.stuck = false; b.destroy(); await wait(20) }
})

test('关浏览器（Windows）：taskkill 还没杀完时来的新任务，等旧的退了再开一个', async () => {
  const log = []
  const { launch, opened } = pageLaunch(log, { killDelay: 150 })
  const b = createBrowser({ bin: '/fake/chrome', launch, platform: 'win32', idleMs: 10, log: () => {} })
  try {
    await b.withPage({ url: 'http://127.0.0.1:9/a.html', w: 100, h: 100 }, async () => 'x')
    await wait(60)
    const during = await b.withPage({ url: 'http://127.0.0.1:9/b.html', w: 100, h: 100 }, async () => 'ran').catch((e) => e.message)
    assert.equal(during, 'ran')
    assert.equal(opened(), 2)
  } finally { b.destroy(); await wait(200) }
})
