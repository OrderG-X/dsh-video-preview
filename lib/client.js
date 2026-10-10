/**
 * dsh-video-preview 的客户端部分 —— 把 play_video 的结果渲染成真正的播放器。
 *
 * 走的是 DSH 官方客户端插件机制（跟 dsh-image-gen 内联图片同一个套路）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory 里 apply(ctx) → ctx.slots.register('tool.call.toolview', key: 工具名)
 *
 * 渲染出来的就是一个原生 <video controls>，src 指向服务端的 Range 流式路由，
 * 所以长视频能拖进度条、不会把整个文件读进内存。
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

    const NS = 'dsh-video-preview'

    const ZH = {
      preparing: '准备播放…',
      noUrl: '拿不到播放地址',
      failed: '播放失败',
      loadFailed: '播放器加载失败 —— 确认 DSH 是重启过的（服务端路由要重新注册）',
      download: '下载',
    }
    const EN = {
      preparing: 'Preparing…',
      noUrl: 'No media URL found',
      failed: 'Playback failed',
      loadFailed: 'Player failed to load — restart DSH so the server route is re-registered',
      download: 'Download',
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

    function VideoCard(props) {
      const block = props.block
      const t = typeof props.t === 'function' ? props.t : (k, def) => def || k
      // 消息体路径直接给 media；工具块路径从 block 推断状态再挖地址
      const running = !props.media && (!block || block.kind === 'tool-call' || !('content' in block))
      const failed = !props.media && block && (block.isError || block.error !== undefined)
      const media = props.media || readMedia(block)
      const [err, setErr] = react.useState(false)

      const box = {
        margin: '8px 0',
        borderRadius: '10px',
        overflow: 'hidden',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
        background: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.06))',
        maxWidth: '720px',
      }
      const head = {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '7px 11px', fontSize: '12px',
        color: 'var(--dsw-alias-text-l2, #888)',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
      }

      if (failed) {
        const msg = (block && (block.error && (block.error.message || block.error)) || t('failed', ZH.failed)) + ''
        return react.createElement('div', { style: { ...box, padding: '10px 12px', color: 'var(--dsw-alias-text-danger, #d9534f)', fontSize: '13px' } }, '⚠️ ' + msg)
      }
      if (running || !media) {
        return react.createElement('div', { style: { ...box, padding: '10px 12px', fontSize: '13px', color: 'var(--dsw-alias-text-l2, #888)' } },
          running ? t('preparing', ZH.preparing) : t('noUrl', ZH.noUrl))
      }

      const label = (media.name || '媒体') + (media.size ? ` · ${media.size}` : '')
      const player = media.kind === 'audio'
        ? react.createElement('audio', {
            src: media.url, controls: true, autoPlay: media.autoplay, loop: media.loop,
            style: { width: '100%', display: 'block', padding: '10px' },
            onError: () => setErr(true),
          })
        : react.createElement('video', {
            src: media.url, controls: true, autoPlay: media.autoplay, loop: media.loop,
            playsInline: true, preload: 'metadata',
            style: { width: '100%', display: 'block', maxHeight: '70vh', background: '#000' },
            onError: () => setErr(true),
          })

      return react.createElement('div', { style: box },
        react.createElement('div', { style: head },
          react.createElement('span', null, media.kind === 'audio' ? '🎵' : '🎬'),
          react.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
          react.createElement('a', {
            href: media.url, download: media.name || 'media',
            style: { color: 'inherit', textDecoration: 'none', opacity: .75 },
            title: t('download', ZH.download),
          }, '⤓')
        ),
        player,
        err ? react.createElement('div', { style: { padding: '8px 11px', fontSize: '12px', color: 'var(--dsw-alias-text-danger, #d9534f)' } },
          t('loadFailed', ZH.loadFailed)) : null
      )
    }

    // ── turnTail 内联播放器：这一轮 present 过的视频直接渲染在最终输出下方 ─────────
    // 官方 deliverables 把 presented 文件挂在 turn.data 上并在 turnTail 画芯片；
    // 我们在同一个链上追加一个条目，把媒体文件渲染成真正的播放器。

    function TurnTailPlayers(props) {
      const turn = props.turn
      const data = turn && typeof turn.data !== 'undefined' && turn.data && typeof turn.data.get === 'function' ? turn.data : null
      const files = data ? (data.get('deliverables')?.presented ?? []) : []
      const seen = new Set()
      const players = []
      for (const f of files) {
        const p = String((f && f.path) || '')
        const isAudio = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|wma)$/i.test(p)
        if (!/\.(mp4|mov|m4v|webm|mkv|avi|ogv|ts|3gp|flv|mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|wma)$/i.test(p)) continue
        if (seen.has(p)) continue
        seen.add(p)
        players.push(react.createElement(VideoCard, {
          key: p,
          media: {
            url: '/dsh-video-preview/preview?p=' + encodeURIComponent(p),
            kind: isAudio ? 'audio' : 'video',
            name: p.split('/').pop() || p,
            size: '',
          },
          t: (k, def) => def || k,
        }))
      }
      return players.length ? react.createElement('div', { style: { margin: '2px 0 6px' } }, players) : null
    }

    // ── 侧边栏视频预览：注册 documentPreviews 渲染器，预览面板直接变播放器 ────────
    const MEDIA_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'ogv', 'ts', '3gp', 'flv',
      'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma']

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
      const p = previewPathOf(props.resourceAddress)
      const name = p ? p.split('/').pop() : ''
      if (!p) {
        return react.createElement('p', { style: { padding: 16, color: '#888', fontSize: 13 } }, '拿不到文件路径')
      }
      const src = '/dsh-video-preview/preview?p=' + encodeURIComponent(p)
      return react.createElement('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#000' } },
        react.createElement('video', {
          src, controls: true, playsInline: true, preload: 'metadata',
          style: { flex: 1, width: '100%', minHeight: 0, objectFit: 'contain', background: '#000' },
        }),
        react.createElement('div', { style: { padding: '6px 12px', fontSize: 12, color: '#aaa', background: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name))
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots) return

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
        (props) => react.createElement(VideoCard, { ...props, t })
      )
      // turnTail：这一轮 present 过的媒体 → 内联播放器，直接出现在最终输出下方
      const registerTail = () => ctx.slots.register(
        { name: 'conversation.chat.turnTail', id: 'dsh-video-preview', locale: NS },
        (props) => react.createElement(TurnTailPlayers, props)
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
              title: () => '媒体预览',
              loading: 'renderer',
              wrap: false,
            })
          }
        } catch (e) { console.warn('[dsh-video-preview] 预览渲染器注册失败:', e) }
        ctx.slots.register(
          { name: 'sidebar.right.tab.document', key: 'dsh-video-preview', locale: NS },
          (props) => react.createElement(VideoPreviewBody, props)
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
