# DeepSeek 全家桶 · 联网搜索 / OCR / ASR / TTS

把 DeepSeek 官方 2026-11-13 发布的「全家桶应用 API」接成一套 QQ 机器人工具：
联网搜索（含**深度思考搜索**与**按图搜索**）、阅读链接、OCR、ASR、TTS（含出站语音合成）。

## 装了会多出什么

| 工具 / 扩展 | 干什么 | 对应官方接口 |
|---|---|---|
| `dskit_search` | 服务端联网搜索，带引用。`thinking=true` 走**深度思考搜索**（多步搜索 / 打开网页 / 页内查找），`images=` 可**按图搜索** | `deepseek_web_search` 服务端工具 |
| `dskit_readurl` | 读你给的链接并作答（最多 10 个） | `deepseek_read_url` 服务端工具 |
| `dskit_ocr` | PDF / Word / PPT / 图片 → 文字，可带版面坐标；长文档落盘后只回前几页 | `POST /v1/tools/ocr` |
| `dskit_asr` | 本地音频 → 文字（16bit WAV / Ogg Opus，≤8MiB、≤120s） | `POST /v1/tools/asr` |
| `dskit_tts` | 说明 `[语音合成]` 标记怎么用 + 试听 + 只存文件 | `POST /v1/tools/tts` |
| **出站扩展** | 正文里写 `[语音合成]…[/语音合成]`，自动合成并发出**真语音消息** | `POST /v1/tools/tts` |

## 配置

插件面板 → 扩展设置里找到「DeepSeek 全家桶」：

- **DeepSeek API Key**：<https://platform.deepseek.com> → API keys。
  **当前模型是 DeepSeek 官方时可以留空** —— 会自动复用宿主 `~/.dsh/.credentials.yaml` 里的
  `refs.DEEPSEEK_API_KEY`（"当前模型是官方，就用这个模型的 api"）。面板填了则优先用面板的
- Base URL / 模型：默认 `https://api.deepseek.com` + `deepseek-flash`（官方规定联网工具只支持 deepseek-flash）
- 五个能力各有开关；TTS 还能选音色（`stella` 女 / `tide` 男）与输出格式

> **可见性**：当前 provider 是 DeepSeek 官方（含宿主 Key）→ 工具出现；
> provider 不是官方时，必须自己在面板填 Key 才会出现；两者都没有 → 工具对 AI 完全不可见。
> 这是扩展的 `enabled` 钩子实现的，改完配置下一轮生效，不用重启。

## 语音合成的标记语法

```
[语音合成]主人早上好～[/语音合成]
[语音合成|tide]这句用男声读[/语音合成]
[语音合成]开闭同标记也认[语音合成]
```

规则：标记整段摘掉、剩下的正文照常发；剥完一个字不剩就只发语音；一条正文可以写多个标记。
**不支持情绪/语速/音量**（DeepSeek TTS 没有这些参数，别照火山那套写）；单条 ≤10,000 计费字符。

## 价格（官方刊例，2026-11）

- 网页搜索：按**查询词条数**计费（一次调用 3 个查询词 = 3 次）
- 图片搜索：每张图 1 次
- 网页抓取：按成功抓取的网页数
- OCR：1.5 元 / 1,000 页
- ASR：0.78 元 / 小时（限时 5 折 0.39）
- TTS：3 元 / 10,000 字符（限时 5 折 1.5；汉字算 2 字符）

## 限制（都是官方硬限制）

- 联网 / 阅读链接**只支持 `deepseek-flash`**；`tool_choice` 不能强制指定这两个工具
- 声明了服务端联网工具后，**不能同时声明别的函数工具**（所以 `dskit_search` 是"独立跑一轮对话"的实现）
- 阅读链接只认**最后一条用户消息**里的 URL，最多前 10 个
- OCR：≤100MiB、≤1,000 页、上传 120s 内完成、整体 180s；并发 15
- ASR：只吃 16bit PCM WAV / Ogg Opus，≤8MiB、≤120s
- TTS：整段合成 ≤10,000 计费字符；WebSocket 流式另说（本包未用）

## 目录结构

```
deepseek-kit/
├─ qqbot-pack.json
├─ lib/
│  ├─ dskit-config.mjs   配置读取（面板 → ext-config 合并）+ 可见性判据
│  └─ dskit-api.mjs      五个接口的最小封装（只依赖 Node 内置 fetch）
├─ tools/
│  ├─ dskit_search.mjs
│  ├─ dskit_readurl.mjs
│  ├─ dskit_ocr.mjs
│  ├─ dskit_asr.mjs
│  └─ dskit_tts.mjs
└─ outbound/
   └─ dskit-tts.mjs      出站：标记 → 语音消息（同时声明设置页 schema）
```

## 依赖

- 插件 ≥ **1.12.31**（需要扩展工具的 `enabled` 条件可见钩子）
- Node ≥ 18（内置 `fetch` / `FormData` / `Blob`）
- 不需要额外 npm 包
