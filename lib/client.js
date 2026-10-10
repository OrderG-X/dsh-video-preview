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

    // ── 消息体播放器：视频"车票"附件 → <video>，普通图片照常渲染 ────────────────
    // 服务端把路径+签名编码进 1×1 占位附件的 name（dvp-<base64url(path)>-<token>），
    // render 成 image 块进消息体；我们覆写 conversation.message.images 槽识别它。

    function parseTicket(attachment) {
      const name = attachment && typeof attachment.name === 'string' ? attachment.name : ''
      const m = /^dvp-([A-Za-z0-9_-]+)-([0-9a-f]{32})$/.exec(name)
      if (!m) return null
      try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const file = new TextDecoder().decode(bytes)
        const base = file.split('/').pop() || file
        return {
          url: `/dsh-video-preview/media?t=${m[2]}&p=${encodeURIComponent(file)}`,
          kind: /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|wma)$/i.test(file) ? 'audio' : 'video',
          name: base,
          size: '',
        }
      } catch (_) { return null }
    }

    /** 普通图片的兜底渲染（没有咱们的覆写时官方就是这么画的，这里保持能用） */
    function PlainImage({ attachment, load, big }) {
      const [src, setSrc] = react.useState(null)
      const [open, setOpen] = react.useState(false)
      react.useEffect(() => {
        let alive = true
        Promise.resolve(load ? load(attachment) : null).then(
          (u) => { if (alive) setSrc(u || '') },
          () => { if (alive) setSrc('') },
        )
        return () => { alive = false }
      }, [attachment])
      return react.createElement(react.Fragment, null,
        react.createElement('button', {
          type: 'button',
          onClick: () => { if (src) setOpen(true) },
          style: {
            display: 'block', padding: 0, margin: big ? '8px 0' : 2, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
            borderRadius: big ? 10 : 6, overflow: 'hidden', background: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.06))',
            width: big ? 'min(480px, 100%)' : 64, height: big ? 'auto' : 64, cursor: src ? 'zoom-in' : 'default',
          },
        }, src
          ? react.createElement('img', { src, alt: attachment.name || 'image', style: { display: 'block', width: '100%', height: big ? 'auto' : 64, objectFit: 'cover' } })
          : react.createElement('div', { style: { width: '100%', height: '100%', minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#888' } }, '…')),
        open ? react.createElement('div', {
          onClick: () => setOpen(false),
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, cursor: 'zoom-out' },
        }, react.createElement('img', { src, alt: '', style: { maxWidth: '92vw', maxHeight: '92vh' } })) : null)
    }

    /** images 槽覆写：车票 → 播放器；其余 → 图片 */
    function MessageImagesWithVideo({ images, loadImage, align }) {
      const plain = []
      const tickets = []
      for (const image of images || []) {
        const media = parseTicket(image && image.attachment)
        if (media) tickets.push(media)
        else plain.push(image)
      }
      const big = plain.length === 1
      return react.createElement(react.Fragment, null,
        plain.length ? react.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: align === 'center' ? 'center' : 'flex-start', margin: '6px 0' } },
          plain.map((image, i) => react.createElement(PlainImage, { key: i, attachment: image.attachment, load: loadImage, big }))) : null,
        tickets.map((media, i) => react.createElement(VideoCard, { key: 'dvp' + i, media, t: (k, def) => def || k })))
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
      // 覆写消息体 images 槽（priority 抬高盖过官方默认），让视频车票直接在输出里可播
      const registerImages = () => ctx.slots.register(
        { name: 'conversation.message.images', priority: 5, locale: NS },
        (props) => react.createElement(MessageImagesWithVideo, props)
      )

      try {
        if (typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('tool.call.toolview', () => {
            try { register() } catch (e) { console.warn('[dsh-video-preview] 注册失败:', e) }
          })
          ctx.slots.inject('conversation.message.images', () => {
            try { registerImages() } catch (e) { console.warn('[dsh-video-preview] images 槽注册失败:', e) }
          })
          return
        }
      } catch (e) { console.warn('[dsh-video-preview] slots.inject 失败，改用直接注册:', e) }

      try { register() } catch (e) { console.warn('[dsh-video-preview] 直接注册失败:', e) }
      try { registerImages() } catch (e) { console.warn('[dsh-video-preview] images 槽直接注册失败:', e) }
    }

    exports.apply = apply
    // 注意：这里是**客户端服务名**（短的），不是包名。写包名会一直 pending。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
