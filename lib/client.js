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
      const meta = block.presentationMeta || block.meta || block.data || block.result || {}
      let url = meta.url || block.url || ''
      let kind = meta.kind || 'video'
      let name = meta.name || meta.title || ''
      let size = meta.size || ''

      // 兜底：从输出文本里找 /dsh-video-preview/media 开头的地址
      if (!url) {
        const text = String(block.output || block.text || '')
        const m = text.match(/\/dsh-video-preview\/media\?[^\s)]+/)
        if (m) url = m[0]
        if (!name) {
          const n = text.match(/▶️\s*(.+?)（/)
          if (n) name = n[1]
        }
      }
      if (!url) return null
      return { url, kind, name, size, autoplay: !!meta.autoplay, loop: !!meta.loop }
    }

    function VideoCard(props) {
      const block = props.block
      const t = typeof props.t === 'function' ? props.t : (k, def) => def || k
      const running = block && !('kind' in block)
      const failed = block && (block.isError || block.error !== undefined)
      const media = readMedia(block)
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

      try {
        if (typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('tool.call.toolview', () => {
            try { register() } catch (e) { console.warn('[dsh-video-preview] 注册失败:', e) }
          })
          return
        }
      } catch (e) { console.warn('[dsh-video-preview] slots.inject 失败，改用直接注册:', e) }

      try { register() } catch (e) { console.warn('[dsh-video-preview] 直接注册失败:', e) }
    }

    exports.apply = apply
    // 注意：这里是**客户端服务名**（短的），不是包名。写包名会一直 pending。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
