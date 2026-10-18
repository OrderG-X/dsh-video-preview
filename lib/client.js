/**
 * dsh-video-preview 的客户端部分 —— 三处挂载，把播放器送到用户眼前：
 *
 *   conversation.chat.turnTail（链式）→ 这一轮 present 过的媒体，
 *       播放器直接渲染在最终输出正下方（主显示位，不用点任何东西）
 *   documentPreviews + sidebar.right.tab.document → 侧边栏预览面板变播放器
 *   tool.call.toolview（key: play_video）→ 展开工具块后的小播放器（兜底）
 *
 * 回复下方的卡片：
 *   视频  只露画面（200 高、按原比例），角上标时长；鼠标移上去静音预览、浮出文件名和下载，
 *         点一下才从头带声音播，换成系统播放条
 *   音频  自己画的细条：圆形播放键 + 文件名 + 时长 + 可拖的进度条
 *   多个  一个一行，超过 3 个先折叠；同一时间只有一个在出声
 * 配色、圆角、字体全用 DSH 自己的设计变量（--dsw-*），深浅色主题跟着宿主走。
 *
 * 走官方客户端插件机制：window.__ModuleLoader__.load({ id, factory })，
 * factory 里 apply(ctx) → ctx.slots.register(...)。
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-preview',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let react = null
    try { react = require('react') } catch (_) { react = null }
    if (!react) {
      // 拿不到 react 就啥也别干了，安静退出，别把宿主搞崩
      exports.apply = () => {}
      exports.inject = ['slots', 'locale']
      return module.exports
    }
    const h = react.createElement

    const NS = 'dsh-video-preview'

    const ZH = {
      preparing: '准备播放…',
      noUrl: '拿不到播放地址',
      noPath: '拿不到文件路径',
      failed: '播放失败',
      media: '媒体',
      previewTitle: '媒体预览',
      notFound: '文件找不到了，可能被移走或删掉了',
      denied: '没有权限读这个文件（只能播本机的视频、音频）',
      noServer: '连不上播放服务。刚装或刚更新插件的话，重启一下 DSH',
      unsupported: '这个文件的编码 DSH 的播放器放不了，转一下再播：',
      download: '下载',
      play: '播放',
      pause: '暂停',
      seek: '播放进度',
      more: '还有 {n} 个媒体文件',
      less: '收起',
    }
    const EN = {
      preparing: 'Preparing…',
      noUrl: 'No media URL found',
      noPath: 'No file path',
      failed: 'Playback failed',
      media: 'Media',
      previewTitle: 'Media preview',
      notFound: 'File not found — it may have been moved or deleted',
      denied: 'Not allowed to read this file (only local video and audio)',
      noServer: 'Cannot reach the player service. Restart DSH after installing or updating the plugin',
      unsupported: 'The DSH player cannot decode this file. Convert it first:',
      download: 'Download',
      play: 'Play',
      pause: 'Pause',
      seek: 'Playback position',
      more: '{n} more media files',
      less: 'Show less',
    }

    const VIDEO_RE = /\.(mp4|m4v|mov|webm|ogv|mkv|3gp)$/i
    const AUDIO_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i
    const FOLD_AT = 3

    // ── 样式：一张样式表，:hover / 过渡这些内联样式做不了 ────────────────────────
    const FONT = 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif)'
    // 强调色照 DSH 自己「实心标签」的做法：底用正文色、图标用底色，深浅主题都清楚
    // （brand-primary 在深色主题里是白的，配白图标会看不见）
    const INK = 'var(--dsw-alias-label-primary, #1f1f1f)'
    const PAPER = 'var(--dsw-alias-bg-layer-1, #fff)'
    // 画面外的底：跟主题走，浅色下不会在圆角边上露一圈黑线
    const LETTERBOX = 'var(--dsw-alias-bg-layer-2, #111)'
    const CSS = `
.dvp-list{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin:6px 0 10px}
.dvp-video{position:relative;display:inline-block;vertical-align:top;max-width:100%;height:200px;border-radius:var(--dsw-radius-lg,12px);overflow:hidden;background:${LETTERBOX};border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));cursor:pointer;isolation:isolate;outline:none}
.dvp-video:focus-visible{box-shadow:0 0 0 2px ${INK}}
.dvp-video video{display:block;height:100%;width:auto;max-width:100%;min-width:200px;object-fit:contain;background:${LETTERBOX}}
.dvp-video.is-active{cursor:auto}
.dvp-video.is-active .dvp-play,.dvp-video.is-active .dvp-top,.dvp-video.is-active .dvp-badge,.dvp-video.is-active .dvp-bar{display:none}
.dvp-play{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.22);transition:transform .16s ease,background .16s ease,opacity .16s ease;pointer-events:none}
.dvp-video:hover .dvp-play{transform:scale(1.06);background:rgba(0,0,0,.58)}
.dvp-video.is-previewing .dvp-play{opacity:.85}
.dvp-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:6px;padding:8px 8px 22px 12px;background:linear-gradient(rgba(0,0,0,.62),rgba(0,0,0,0));color:#fff;font:12px/18px ${FONT};opacity:0;transition:opacity .16s ease}
.dvp-video:hover .dvp-top,.dvp-video:focus-visible .dvp-top{opacity:1}
.dvp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvp-sub{flex:none;opacity:.72;font-variant-numeric:tabular-nums}
.dvp-dl{flex:none;width:24px;height:24px;border-radius:var(--dsw-radius-sm,6px);display:flex;align-items:center;justify-content:center;color:inherit;opacity:.8;transition:background .12s ease,opacity .12s ease}
.dvp-dl:hover{opacity:1;background:rgba(255,255,255,.16)}
.dvp-badge{position:absolute;right:8px;bottom:8px;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.62);color:#fff;font:500 11px/16px ${FONT};font-variant-numeric:tabular-nums;pointer-events:none;transition:opacity .16s ease}
.dvp-bar{position:absolute;left:0;bottom:0;height:2px;background:rgba(255,255,255,.92);transition:width .25s linear;pointer-events:none}
.dvp-audio{display:flex;align-items:center;gap:10px;width:340px;max-width:100%;box-sizing:border-box;padding:8px 8px 8px 8px;border-radius:var(--dsw-radius-lg,12px);border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));font:12px/16px ${FONT}}
.dvp-btn{flex:none;width:32px;height:32px;padding:0;border:none;border-radius:50%;display:flex;align-items:center;justify-content:center;color:${PAPER};background:${INK};cursor:pointer;transition:transform .12s ease,opacity .12s ease}
.dvp-btn:hover{opacity:.86}
.dvp-btn:active{transform:scale(.94)}
.dvp-btn:focus-visible{outline:2px solid ${INK};outline-offset:2px}
.dvp-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dvp-row{display:flex;align-items:baseline;gap:8px}
.dvp-aname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}
.dvp-time{flex:none;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}
.dvp-track{position:relative;height:12px;display:flex;align-items:center;cursor:pointer;outline:none;touch-action:none}
.dvp-rail{position:absolute;left:0;right:0;height:3px;border-radius:2px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}
.dvp-fill{position:absolute;left:0;height:3px;border-radius:2px;background:${INK}}
.dvp-knob{position:absolute;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:${INK};opacity:0;transition:opacity .12s ease}
.dvp-track:hover .dvp-knob,.dvp-track:focus-visible .dvp-knob,.dvp-track.is-drag .dvp-knob{opacity:1}
.dvp-audio .dvp-dl{color:var(--dsw-alias-label-tertiary,#888);opacity:0}
.dvp-audio:hover .dvp-dl,.dvp-audio .dvp-dl:focus-visible{opacity:1}
.dvp-audio .dvp-dl:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
.dvp-note{width:340px;max-width:100%;box-sizing:border-box;padding:9px 12px;border-radius:var(--dsw-radius-lg,12px);border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));font:12px/18px ${FONT};color:var(--dsw-alias-label-secondary,#888)}
.dvp-note.is-wide{width:480px}
.dvp-note b{display:block;font-weight:500;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvp-err{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dvp-code{display:block;margin-top:6px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);font:11px/16px var(--dsw-font-markdown-code-font-family,ui-monospace,Menlo,monospace);background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit);user-select:all;word-break:break-all}
.dvp-more{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,#888);font:12px/18px ${FONT};cursor:pointer;transition:background .12s ease,color .12s ease}
.dvp-more:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
`
    function ensureStyle() {
      try {
        if (typeof document === 'undefined' || document.getElementById('dsh-video-preview-style')) return
        const el = document.createElement('style')
        el.id = 'dsh-video-preview-style'
        el.textContent = CSS
        document.head.appendChild(el)
      } catch (_) { /* 样式挂不上也别影响播放 */ }
    }

    // ── 小工具 ────────────────────────────────────────────────────────────────

    function fmtTime(sec) {
      if (!isFinite(sec) || sec < 0) return ''
      const s = Math.floor(sec)
      const hh = Math.floor(s / 3600)
      const mm = Math.floor((s % 3600) / 60)
      const ss = String(s % 60).padStart(2, '0')
      return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
    }

    /** 总时长四舍五入；不到 1 秒的显示 0:01，不显示 0:00 */
    function fmtTotal(sec) {
      return sec > 0 && isFinite(sec) ? fmtTime(Math.max(1, Math.round(sec))) : ''
    }

    function fmtSize(n) {
      if (!(n > 0)) return ''
      if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB'
      if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
      return Math.max(1, Math.round(n / 1024)) + ' KB'
    }

    function statusReason(r) {
      if (!r.headers.get('x-dsh-video-preview')) return 'noServer'
      if (r.status === 404) return 'notFound'
      if (r.status === 401 || r.status === 403) return 'denied'
      return r.ok ? '' : 'failed'
    }

    /** 播放器出错时问一下服务端到底怎么了：文件没了 / 没权限 / 服务没起 / 编码不支持 */
    function diagnose(url) {
      return fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' })
        .then((r) => statusReason(r) || 'unsupported')
        .catch(() => 'noServer')
    }

    /** 卡片一出来就 HEAD 一下：拿文件大小，文件已经没了也能马上说 */
    function probe(url) {
      return fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' })
        .then((r) => ({
          reason: statusReason(r),
          // 插件自己的头优先：Content-Length 可能被宿主的中间件拿掉
          size: Number(r.headers.get('x-dsh-video-size')) || Number(r.headers.get('content-length')) || 0,
        }))
        .catch(() => ({ reason: '', size: 0 }))
    }

    function pathOfUrl(url) {
      try { return new URL(url, location.href).searchParams.get('p') || '' } catch (_) { return '' }
    }

    function convertCmd(p, kind) {
      const src = p || 'input'
      const base = src.replace(/\.[^./]+$/, '')
      return kind === 'audio'
        ? `ffmpeg -i "${src}" -c:a aac "${base}.m4a"`
        : `ffmpeg -i "${src}" -c:v libx264 -c:a aac -movflags +faststart "${base}.mp4"`
    }

    /** 同一时间只让一个出声：带声音开播时把别的停掉（静音预览不算） */
    function solo(el) {
      try {
        if (!el || el.muted || typeof document === 'undefined') return
        document.querySelectorAll('.dvp-media').forEach((m) => { if (m !== el && !m.paused && !m.muted) m.pause() })
      } catch (_) { /* ignore */ }
    }

    const icon = (d, size) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true },
      h('path', { d, fill: 'currentColor' }))
    const PLAY = 'M5 3.2v9.6c0 .5.6.8 1 .5l7.2-4.8c.4-.3.4-.8 0-1L6 2.7c-.4-.3-1 0-1 .5z'
    const PAUSE = 'M4.5 3h2.2v10H4.5zM9.3 3h2.2v10H9.3z'
    const DL = 'M7.25 2h1.5v6.4l2.2-2.2 1.06 1.06L8 11.27 3.99 7.26l1.06-1.06 2.2 2.2zM3 12.5h10V14H3z'

    function DownloadLink(props) {
      return h('a', {
        className: 'dvp-dl', href: props.url, download: props.name || 'media',
        title: props.title, 'aria-label': props.title,
        onClick: (e) => e.stopPropagation(),
      }, icon(DL, 14))
    }

    /** 播放器出错 → 先诊断再给人话；换了地址就清掉旧错误 */
    function useMediaError(url) {
      const [reason, setReason] = react.useState('')
      react.useEffect(() => { setReason('') }, [url])
      return [reason, () => { if (url) diagnose(url).then(setReason) }, setReason]
    }

    /** 文件大小 + 一出来就发现的错误 */
    function useProbe(url, setReason) {
      const [meta, setMeta] = react.useState({ size: 0 })
      react.useEffect(() => {
        let alive = true
        if (url) probe(url).then((r) => { if (!alive) return; setMeta({ size: r.size }); if (r.reason) setReason(r.reason) })
        return () => { alive = false }
      }, [url])
      return meta
    }

    /** 出错卡：说清楚怎么了，编码不支持的附上转码命令 */
    function ErrorCard(props) {
      const { reason, media, t } = props
      const wide = reason === 'unsupported'
      return h('div', { className: 'dvp-note' + (wide ? ' is-wide' : '') },
        h('b', { title: media.name }, media.name || t('media', ZH.media)),
        h('span', { className: 'dvp-err' }, t(reason, ZH[reason] || ZH.failed)),
        wide ? h('code', { className: 'dvp-code' }, convertCmd(pathOfUrl(media.url), media.kind)) : null)
    }

    // ── 视频卡 ────────────────────────────────────────────────────────────────

    function VideoTile(props) {
      const { media, t } = props
      const ref = react.useRef(null)
      const [reason, onError, setReason] = useMediaError(media.url)
      const meta = useProbe(media.url, setReason)
      const [state, setState] = react.useState({ active: false, previewing: false, duration: 0, at: 0 })
      const set = (patch) => setState((s) => ({ ...s, ...patch }))
      if (reason) return h(ErrorCard, { reason, media, t })

      const v = () => ref.current
      const activate = () => {
        const el = v()
        if (!el || state.active) return
        set({ active: true, previewing: false })
        el.loop = !!media.loop
        el.muted = false
        try { el.currentTime = 0 } catch (_) { /* ignore */ }
        const p = el.play()
        if (p && p.catch) p.catch(() => {})
      }
      const enter = () => {
        const el = v()
        if (!el || state.active) return
        el.muted = true
        el.loop = true
        const p = el.play()
        if (p && p.catch) p.catch(() => {})
        set({ previewing: true })
      }
      const leave = () => {
        const el = v()
        if (!el || state.active) return
        el.pause()
        try { el.currentTime = 0.1 } catch (_) { /* ignore */ } // 回到封面那一帧
        set({ previewing: false, at: 0 })
      }
      const sub = [fmtSize(meta.size)].filter(Boolean).join(' · ')
      const playLabel = t('play', ZH.play) + ' ' + (media.name || '')

      return h('div', {
        className: 'dvp-video' + (state.active ? ' is-active' : '') + (state.previewing ? ' is-previewing' : ''),
        role: state.active ? undefined : 'button',
        tabIndex: state.active ? undefined : 0,
        'aria-label': state.active ? undefined : playLabel,
        onMouseEnter: enter,
        onMouseLeave: leave,
        onClick: activate,
        onKeyDown: (e) => { if (!state.active && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate() } },
      },
        h('video', {
          ref,
          className: 'dvp-media',
          // #t=0.1：没开播时也画出第一帧当封面，不是一块黑
          src: media.url + '#t=0.1',
          controls: state.active,
          autoPlay: !!media.autoplay,
          playsInline: true,
          preload: 'metadata',
          onLoadedMetadata: (e) => set({ duration: e.currentTarget.duration || 0 }),
          onDurationChange: (e) => set({ duration: e.currentTarget.duration || 0 }),
          onTimeUpdate: (e) => { if (state.previewing) set({ at: e.currentTarget.currentTime || 0 }) },
          onPlay: (e) => { if (!e.currentTarget.muted) { solo(e.currentTarget); if (!state.active) set({ active: true, previewing: false }) } },
          onError,
        }),
        h('span', { className: 'dvp-play' }, icon(PLAY, 18)),
        h('div', { className: 'dvp-top' },
          h('span', { className: 'dvp-name' }, media.name || t('media', ZH.media)),
          sub ? h('span', { className: 'dvp-sub' }, sub) : null,
          h(DownloadLink, { url: media.url, name: media.name, title: t('download', ZH.download) })),
        state.duration > 0 && isFinite(state.duration) ? h('span', { className: 'dvp-badge' }, fmtTotal(state.previewing ? Math.max(0.01, state.duration - state.at) : state.duration)) : null,
        state.previewing && state.duration > 0 && isFinite(state.duration)
          ? h('span', { className: 'dvp-bar', style: { width: Math.min(100, (state.at / state.duration) * 100) + '%' } })
          : null)
    }

    // ── 音频条 ────────────────────────────────────────────────────────────────

    function AudioBar(props) {
      const { media, t } = props
      const ref = react.useRef(null)
      const trackRef = react.useRef(null)
      const [reason, onError, setReason] = useMediaError(media.url)
      const meta = useProbe(media.url, setReason)
      const [state, setState] = react.useState({ playing: false, duration: 0, at: 0, drag: false })
      const set = (patch) => setState((s) => ({ ...s, ...patch }))
      if (reason) return h(ErrorCard, { reason, media, t })

      const a = () => ref.current
      const toggle = () => {
        const el = a()
        if (!el) return
        if (el.paused) { const p = el.play(); if (p && p.catch) p.catch(() => {}) } else el.pause()
      }
      const seekTo = (clientX) => {
        const el = a()
        const tr = trackRef.current
        if (!el || !tr || !state.duration) return
        const r = tr.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
        el.currentTime = ratio * state.duration
        set({ at: el.currentTime })
      }
      const ratio = state.duration ? Math.min(1, state.at / state.duration) : 0
      const total = fmtTotal(state.duration)
      const time = state.at > 0 || state.playing
        ? (total ? `${fmtTime(state.at)} / ${total}` : fmtTime(state.at))
        : total

      return h('div', { className: 'dvp-audio', title: media.name },
        h('audio', {
          ref,
          className: 'dvp-media',
          src: media.url,
          preload: 'metadata',
          autoPlay: !!media.autoplay,
          loop: !!media.loop,
          onLoadedMetadata: (e) => set({ duration: e.currentTarget.duration || 0 }),
          onDurationChange: (e) => set({ duration: e.currentTarget.duration || 0 }),
          onTimeUpdate: (e) => { if (!state.drag) set({ at: e.currentTarget.currentTime || 0 }) },
          onPlay: (e) => { solo(e.currentTarget); set({ playing: true }) },
          onPause: () => set({ playing: false }),
          onEnded: () => set({ playing: false, at: 0 }),
          onError,
        }),
        h('button', {
          className: 'dvp-btn', type: 'button', onClick: toggle,
          'aria-label': state.playing ? t('pause', ZH.pause) : t('play', ZH.play),
        }, icon(state.playing ? PAUSE : PLAY, 14)),
        h('div', { className: 'dvp-body' },
          h('div', { className: 'dvp-row' },
            h('span', { className: 'dvp-aname' }, media.name || t('media', ZH.media)),
            meta.size ? h('span', { className: 'dvp-time' }, fmtSize(meta.size)) : null,
            time ? h('span', { className: 'dvp-time' }, time) : null),
          h('div', {
            ref: trackRef,
            className: 'dvp-track' + (state.drag ? ' is-drag' : ''),
            role: 'slider', tabIndex: 0,
            'aria-label': t('seek', ZH.seek),
            'aria-valuemin': 0, 'aria-valuemax': Math.round(state.duration), 'aria-valuenow': Math.round(state.at),
            'aria-valuetext': time,
            onPointerDown: (e) => { try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) { /* ignore */ } set({ drag: true }); seekTo(e.clientX) },
            onPointerMove: (e) => { if (state.drag) seekTo(e.clientX) },
            onPointerUp: () => set({ drag: false }),
            onPointerCancel: () => set({ drag: false }),
            onKeyDown: (e) => {
              const el = a()
              if (!el || !state.duration) return
              const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0
              if (!step) return
              e.preventDefault()
              el.currentTime = Math.min(state.duration, Math.max(0, el.currentTime + step))
              set({ at: el.currentTime })
            },
          },
            h('span', { className: 'dvp-rail' }),
            h('span', { className: 'dvp-fill', style: { width: ratio * 100 + '%' } }),
            h('span', { className: 'dvp-knob', style: { left: ratio * 100 + '%' } }))),
        h(DownloadLink, { url: media.url, name: media.name, title: t('download', ZH.download) }))
    }

    function MediaCard(props) {
      return props.media.kind === 'audio' ? h(AudioBar, props) : h(VideoTile, props)
    }

    /** 翻译函数：优先宿主 locale 服务，查不到回退中文默认值 */
    function makeT(ctx) {
      const loc = ctx && ctx.locale
      if (loc && typeof loc.t === 'function') {
        return (k, def) => loc.t(NS + '.' + k) || loc.t(k) || def || k
      }
      return (k, def) => def || k
    }

    /** 从工具块里把播放地址挖出来 —— 多个来源都试一遍，稳一点 */
    function readMedia(block) {
      if (!block) return null
      const meta = block.presentationMeta || block.meta || {}
      const call = block.call || {}
      // 工具结果的文本内容：这个框架形态在 content 数组里（[{type:'text',text}]）
      let text = String(block.output || block.text || '')
      if (Array.isArray(block.content)) {
        text = block.content.map((c) => (c && c.text) || '').join('\n')
      }
      let url = meta.url || ''
      let kind = meta.kind || ''
      let name = meta.name || meta.title || call.title || ''
      let size = meta.size || ''

      // 兜底：从输出文本里找 /dsh-video-preview/media 开头的地址
      if (!url) {
        const m = text.match(/\/dsh-video-preview\/media\?[^\s)]+/)
        if (m) url = m[0]
        if (!name) {
          const n = text.match(/▶️\s*(.+?)（/)
          if (n) name = n[1]
        }
        const sz = text.match(/（[^（]*?([\d.]+\s*[KMG]?B)）/)
        if (sz) size = sz[1]
      }
      if (!kind) {
        const k = String(text).match(/（(视频|音频)，/)
        kind = k ? (k[1] === '音频' ? 'audio' : 'video') : 'video'
      }
      if (!url) return null
      return { url, kind, name, size, autoplay: !!meta.autoplay, loop: !!meta.loop }
    }

    /** 工具块里的兜底播放器（展开 play_video 的调用块才看得到） */
    function ToolView(props) {
      const block = props.block
      const t = typeof props.t === 'function' ? props.t : (k, def) => def || k
      const running = !block || block.kind === 'tool-call' || !('content' in block)
      const failed = block && (block.isError || block.error !== undefined)
      if (failed) {
        const msg = ((block.error && (block.error.message || block.error)) || t('failed', ZH.failed)) + ''
        return h('div', { className: 'dvp-note is-wide' }, h('span', { className: 'dvp-err' }, msg))
      }
      const media = running ? null : readMedia(block)
      if (!media) return h('div', { className: 'dvp-note' }, running ? t('preparing', ZH.preparing) : t('noUrl', ZH.noUrl))
      return h('div', { className: 'dvp-list' }, h(MediaCard, { media, t }))
    }

    // ── turnTail 内联播放器：这一轮 present 过的视频直接渲染在最终输出下方 ─────────
    // 官方 deliverables 把 presented 文件挂在 turn.data 上并在 turnTail 画芯片；
    // 我们在同一个链上追加一个条目，把媒体文件渲染成真正的播放器。

    function TurnTailPlayers(props) {
      const turn = props.turn
      const t = typeof props.t === 'function' ? props.t : (k, def) => def || k
      const [open, setOpen] = react.useState(false)
      const data = turn && typeof turn.data !== 'undefined' && turn.data && typeof turn.data.get === 'function' ? turn.data : null
      const files = data ? (data.get('deliverables')?.presented ?? []) : []
      const seen = new Set()
      const items = []
      for (const f of files) {
        const p = String((f && f.path) || '')
        const isAudio = AUDIO_RE.test(p)
        // 只管播得了的格式；avi 之类留给原生文件芯片，不给一个放不出来的黑框
        if (!isAudio && !VIDEO_RE.test(p)) continue
        if (seen.has(p)) continue
        seen.add(p)
        items.push({
          url: '/dsh-video-preview/preview?p=' + encodeURIComponent(p),
          kind: isAudio ? 'audio' : 'video',
          name: p.split('/').pop() || p,
        })
      }
      if (!items.length) return null
      // 多了先折叠：一轮生成一堆的时候不刷屏（多出来的只差一个就不折，省得「还有 1 个」）
      const fold = items.length > FOLD_AT + 1 && !open
      const shown = fold ? items.slice(0, FOLD_AT) : items
      const rest = items.length - shown.length
      return h('div', { className: 'dvp-list' },
        shown.map((m) => h(MediaCard, { key: m.url, media: m, t })),
        fold
          ? h('button', { className: 'dvp-more', type: 'button', onClick: () => setOpen(true) },
              t('more', ZH.more).replace('{n}', String(rest)), ' ▾')
          : items.length > FOLD_AT + 1
            ? h('button', { className: 'dvp-more', type: 'button', onClick: () => setOpen(false) }, t('less', ZH.less), ' ▴')
            : null)
    }

    // ── 侧边栏视频预览：注册 documentPreviews 渲染器，预览面板直接变播放器 ────────
    const MEDIA_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', '3gp',
      'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba']

    function previewPathOf(resourceAddress) {
      let s = ''
      if (!resourceAddress) return ''
      if (typeof resourceAddress === 'string') s = resourceAddress
      else if (typeof resourceAddress.path === 'string') return resourceAddress.path
      else return ''
      if (s.indexOf('dsh-resource://') === 0) {
        // dsh-resource://file/session/<sessionId>/<绝对路径>
        const m = /^dsh-resource:\/\/file\/session\/[^/]+(\/.+)$/.exec(s)
        return m ? decodeURIComponent(m[1]) : ''
      }
      if (s.indexOf('file://') === 0) return decodeURIComponent(s.replace(/^file:\/\//, ''))
      return s
    }

    function VideoPreviewBody(props) {
      const t = typeof props.t === 'function' ? props.t : (k, def) => def || k
      const p = previewPathOf(props.resourceAddress)
      const src = p ? '/dsh-video-preview/preview?p=' + encodeURIComponent(p) : ''
      const [reason, onError] = useMediaError(src)
      if (!p) {
        return h('p', { style: { padding: 16, color: '#888', fontSize: 13 } }, t('noPath', ZH.noPath))
      }
      const audio = AUDIO_RE.test(p)
      const media = { url: src, kind: audio ? 'audio' : 'video', name: p.split('/').pop() || p }
      if (reason) {
        return h('div', { style: { padding: 16 } }, h(ErrorCard, { reason, media, t }))
      }
      const player = audio
        ? h('div', { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', padding: '0 16px' } },
            h('audio', { src, controls: true, preload: 'metadata', onError, className: 'dvp-media', style: { width: '100%' } }))
        : h('video', {
            src, controls: true, playsInline: true, preload: 'metadata', onError, className: 'dvp-media',
            onPlay: (e) => solo(e.currentTarget),
            style: { flex: 1, width: '100%', minHeight: 0, objectFit: 'contain', background: '#000' },
          })
      return h('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#000' } },
        player,
        h('div', { style: { padding: '6px 12px', fontSize: 12, color: '#aaa', background: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, media.name))
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots) return
      ensureStyle()

      // 注册词典（en/zh）：失败不致命，t() 会回退到中文默认值
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          if (ctx.effect) ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-video-preview: locale')
          else ctx.locale.register(NS, { en: EN, zh: ZH })
        } else if (ctx.locale && typeof ctx.locale.define === 'function') {
          ctx.locale.define('en', NS, EN)
          ctx.locale.define('zh', NS, ZH)
        }
      } catch (_) { /* 词典注册失败不挡播放器 */ }

      const t = makeT(ctx)
      const register = () => ctx.slots.register(
        { name: 'tool.call.toolview', key: 'play_video', locale: NS },
        (props) => h(ToolView, { ...props, t })
      )
      // turnTail：这一轮 present 过的媒体 → 内联播放器，直接出现在最终输出下方
      const registerTail = () => ctx.slots.register(
        { name: 'conversation.chat.turnTail', id: 'dsh-video-preview', locale: NS },
        (props) => h(TurnTailPlayers, { ...props, t })
      )
      // 侧边栏视频预览渲染器：deliverable 芯片点「在侧边栏预览」→ 这里播放
      const registerPreview = () => {
        try {
          if (ctx.documentPreviews && typeof ctx.documentPreviews.register === 'function') {
            ctx.documentPreviews.register({
              id: 'dsh-video-preview',
              extensions: MEDIA_EXTS,
              binaryExtensions: MEDIA_EXTS,
              priority: 'plugin',
              title: () => t('previewTitle', ZH.previewTitle),
              loading: 'renderer',
              wrap: false,
            })
          }
        } catch (e) { console.warn('[dsh-video-preview] 预览渲染器注册失败:', e) }
        ctx.slots.register(
          { name: 'sidebar.right.tab.document', key: 'dsh-video-preview', locale: NS },
          (props) => h(VideoPreviewBody, { ...props, t })
        )
      }

      try {
        if (typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('tool.call.toolview', () => {
            try { register() } catch (e) { console.warn('[dsh-video-preview] 注册失败:', e) }
          })
          ctx.slots.inject('conversation.chat.turnTail', () => {
            try { registerTail() } catch (e) { console.warn('[dsh-video-preview] turnTail 注册失败:', e) }
          })
          ctx.slots.inject('sidebar.right.tab.document', () => {
            try { registerPreview() } catch (e) { console.warn('[dsh-video-preview] 预览槽注册失败:', e) }
          })
          return
        }
      } catch (e) { console.warn('[dsh-video-preview] slots.inject 失败，改用直接注册:', e) }

      try { register() } catch (e) { console.warn('[dsh-video-preview] 直接注册失败:', e) }
      try { registerTail() } catch (e) { console.warn('[dsh-video-preview] turnTail 直接注册失败:', e) }
      try { registerPreview() } catch (e) { console.warn('[dsh-video-preview] 预览槽直接注册失败:', e) }
    }

    exports.apply = apply
    // 注意：这里是**客户端服务名**（短的），不是包名。写包名会一直 pending。
    exports.inject = ['slots', 'locale', 'documentPreviews']
    return module.exports
  },
})
