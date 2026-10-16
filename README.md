# dsh-video-preview

![hero](assets/hero.png)

让 DSH（DeepSeek Harness）的对话流里直接播放本地视频/音频：说一句「用 play_video 播 xxx.mp4」，播放器就出现在最终输出的正下方——Claude 桌面端 / Codex 同款位置，不用点任何东西。

![demo](assets/demo.gif)

## 它解决什么

DSH 的消息渲染块只有 text / image / file / table，**没有 video**，工具调用块又默认折叠。这个插件用纯官方插件 API 补上内联播放（零 `@deepseek-ai/*` 依赖，和官方 `present` 工具同款机制）。

一次 `play_video` 调用后，用户能看到：

1. **turnTail 内联播放器**（主显示位）——渲染在每轮输出的收尾区，紧跟模型回复，原生 `<video controls>`，可拖进度条
2. **deliverable 文件芯片**——输出里原生可见的文件条，点「在侧边栏预览」打开大屏播放器
3. **侧边栏预览 = 播放器**——注册了 `documentPreviews` 媒体渲染器，侧边栏预览面板直接播放（DSH 原生把 mp4 列为「不可预览」，这里接管）
4. **工具块小播放器**（兜底）——展开工具调用块后可见

附带福利：模型用自带 `present` 工具交付的媒体文件，也会自动获得 turnTail 内联播放器。

## 架构

```
服务端  play_video 工具 ──校验文件──▶ 返回带签名的 URL
            │
            └─append deliverables/presented 事件（官方 present 工具同款通道）
路由    /dsh-video-preview/media    签名 token 鉴权 · HTTP Range 流式（大文件不进内存）
        /dsh-video-preview/preview  宿主登录 cookie 鉴权 · 供侧边栏/turnTail
客户端  turnTail 槽 / documentPreviews 渲染器 / toolview 槽
```

签名密钥持久化在 `~/.dsh/cache/dsh-video-preview.secret`（0600），token = HMAC(密钥， 文件绝对路径)——同一台机器上 URL 跨重启、跨宿主（web / 桌面端）都有效。

支持格式：mp4 / webm / mov / m4v / mkv / avi / ogv / ts / 3gp / flv，音频 mp3 / wav / ogg / m4a / aac / flac / opus / weba / wma。

## 安装

```sh
dsh plugin --profile desktop add link:/path/to/dsh-video-preview
```

装完**必须重启 DSH**（ESM 有缓存，客户端 bundle 的 rev 在宿主启动时算死，不重启不生效）。改了插件代码同理。

## 用法

对话里直接说「用 play_video 播 /Users/me/Movies/a.mp4」。参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | 是 | 本地文件绝对路径（支持 `~`） |
| `title` | 否 | 播放器标题，默认文件名 |
| `autoplay` | 否 | 自动播放（浏览器通常会拦） |
| `loop` | 否 | 循环播放 |

## 结构

- `lib/index.js` —— 服务端：工具 + deliverables 事件 + 两条流式路由
- `lib/client.js` —— 客户端：turnTail 播放器 / 侧边栏预览渲染器 / toolview 兜底（`exports.inject` 是客户端**短服务名**，写包名会一直 pending）
- `cordis.patch.yml` —— bundle patch（insert 行的 `name` 必须是完整包名，客户端按它解析 bundle）

## 已验证

web 端与桌面端（DeepSeek Harness 0.2.0-rc.2）端到端实测：turnTail 播放器 `playing: true`、1920px 解码、seek/Range/缓冲全通、跨宿主 URL 无 403。

参考实现：[@goodandready/dsh-image-gen](https://www.npmjs.com/package/@goodandready/dsh-image-gen)（客户端插件套路）与官方 `dsh-tool-present`（deliverables 通道）。
