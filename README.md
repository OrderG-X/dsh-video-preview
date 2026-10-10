# dsh-video-preview

让 DSH（DeepSeek Harness）的对话流里直接播放本地视频/音频：一个 `play_video` 工具 + 内联播放器卡片，Claude 桌面端式的体验。

## 解决什么

DSH 的渲染块只有 text / image / file / table，没有 video。这个插件补上：

- **`play_video` 工具**：传本地文件的绝对路径，播放器直接出现在消息里，可以拖进度条
- **Range 流式路由**：`/dsh-video-preview/media`（每次启动随机 token 鉴权），大文件不进内存
- **客户端渲染**：`tool.call.toolview` 槽里渲染原生 `<video controls>` / `<audio controls>`；URL 是相对路径，web 端（3080）和桌面端（`dsh-app://` 转发，Range/206 透传）都通

支持格式：mp4 / webm / mov / m4v / mkv / avi / ogv / ts / 3gp / flv，音频 mp3 / wav / ogg / m4a / aac / flac / opus / weba / wma。

## 安装

```sh
dsh plugin --profile desktop add link:/path/to/dsh-video-preview
```

装完**必须重启 DSH**（ESM 有缓存，不重启不生效）。

## 用法

对话里直接说「用 play_video 播 /Users/me/Movies/a.mp4」。参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | 是 | 本地文件绝对路径 |
| `title` | 否 | 播放器标题，默认文件名 |
| `autoplay` | 否 | 自动播放（浏览器通常会拦） |
| `loop` | 否 | 循环播放 |

## 结构

- `lib/index.js` —— 服务端：注册工具 + 流式媒体路由
- `lib/client.js` —— 客户端：toolview 槽渲染播放器（`exports.inject` 是客户端**短服务名**，写包名会一直 pending）
- `cordis.patch.yml` —— bundle patch（insert 行的 `name` 必须是完整包名，客户端按它解析 bundle）

参考实现：[@goodandready/dsh-image-gen](https://www.npmjs.com/package/@goodandready/dsh-image-gen)（同款客户端插件套路）。
