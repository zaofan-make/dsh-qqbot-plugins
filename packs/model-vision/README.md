# 模型读图 · model_see

**一个工具成包**：用「当前会话正在用的那个模型」看图，只把**文字**带回上下文。

## 为什么需要它

群友发图时，插件默认只把**本地路径**写进上下文（不塞 `image block`，除非开了「图片聚合」）。
想让模型真看到图，通常会让模型调 `read_image` —— 但那条路会把图变成 `image block` 永久驻留历史：
**之后每轮请求都重发这张图**（视觉 token 每轮重算 + 每轮重新过输入审核），
一旦撞上上游内容审核（如 10013），整个会话就每轮必挂，只能 `/bot-clear` 止损。

`model_see` 把「看图」变成**工具产文本**：图在工具内部发给视觉模型，回来的只有一段文字，
上下文里不会出现 image block，也就没有每轮重发与毒会话的问题。

## 用法

```
model_see(images="D:\\素材\\a.jpg", prompt="描述这张图")
model_see(images="https://x.com/a.png\nD:\\素材\\b.jpg", prompt="这两张图有什么区别？")
```

- `images`：本地绝对路径或 `http(s)` 链接，多个用换行 / 竖线 / 逗号分隔
- `prompt`：**必填**，要模型看图回答什么
- `model`：可选，覆盖模型（默认=当前会话的模型）
- `maxTokens`：可选，默认**不传**（GLM 视觉模型收到 `max_tokens` 会报 1210）
- `detail`：可选 `low` / `high` / `auto`（部分服务商支持）

## 它是怎么拿到「当前模型」的

| 项 | 来源（优先级从左到右） |
|---|---|
| provider / model | `env.manager.getEffectiveModel(scope, peerId)` → `env.provider` / `agent.session.requestContext()` → 面板配置 |
| Base URL | 面板配置 → 按 provider 内置默认（deepseek / zhipu / openai / 火山 / dashscope / siliconflow …） |
| API Key | 面板配置 → 宿主 `credentials` seam（`ctx.get('credentials').resolve(ref)`）→ 兜底直读 `~/.dsh/.credentials.yaml` 的 `refs.*` |

走的是**标准 OpenAI 兼容**请求：

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
{
  "model": "deepseek-flash",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "描述这张图" },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,…" } }
  ]}]
}
```

所以换服务商只改 `baseUrl` 与模型名即可；本地图按**文件头**判类型（QQ 落盘的文件常没扩展名）。

## 不支持的模型

直接让上游报错并原样带回（含 HTTP 状态与 code）——
`1210` = 参数非法（常见于把图发给纯文本模型 / 传了 `max_tokens`）、
`10013` = 内容审核、`400` = 请求不合法。

## 安装

把 `tools/model_see.mjs` 放到 `{数据根}/.qqbot-extensions/tools/` 即可（改完 `tools_reload` 生效）。
插件面板 → 扩展设置里会出现「模型读图 · 设置」，可填 Key / Base URL / 模型 / max_tokens。

## 依赖

- 插件 ≥ 1.12.31
- Node ≥ 18（内置 `fetch` / `AbortSignal.timeout`）
- 不需要额外 npm 包
