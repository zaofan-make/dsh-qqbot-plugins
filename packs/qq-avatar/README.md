# 群友头像下载（qq-avatar）

把群友的 QQ 头像下到本地，并**直接发到群里**。免鉴权、免 token。

## 用法

| 谁用 | 怎么用 | 效果 |
|---|---|---|
| 群友 | `/头像` | 存**自己**的头像，发到群里 |
| 群友 | `/头像 做早饭` | 按群昵称模糊匹配，存对方的 |
| 群友 | `/头像 E9020753…`（32 位 openid） | 直接按 openid 存 |
| AI | 工具 `qq_avatar`（`who` 可省） | 同上，返回文件路径 |

- 文件落在 `{dataRoot}/.qqbot-extensions/.state/avatars/{昵称}_{openid前8}.jpg`
- 图走**被动回复**通道（命令/工具本来就在回合内），不占主动推送配额
- 命令执行完只做**静默注入**（`appendSilent`：落上下文、不唤醒、不发消息），所以群里只会看到那张图

## 头像 URL 是这么来的

QQ 互联 `get_user_info` 的 `figureurl_qq_1/_2` 字段，官方示例就是：

```
http://q.qlogo.cn/qqapp/100312990/DE1931D5330620DBD07FB4A5422917B6/40
```

2018-02-11 域名迁移（`q.qlogo.cn` → `thirdqq.qlogo.cn`）后结构不变：

```
https://thirdqq.qlogo.cn/qqapp/{appId}/{openid}/{size}
```

- **不需要 access_token**：纯 CDN 直链（文档里其他 QQ 互联接口都要用户 OAuth token，机器人拿不到）
- `size` 文档只写 `40` / `100`，实测 `640`（最大）和 `0`（原图）也能取
- `openid` 要用**本机器人视角**的那个（群消息里的 `member_openid`）

## 名字反查

没有现成的"群成员列表"接口（平台未开放），所以读插件已经在维护的台账：

```
{dataRoot}/表情包/group-members.jsonl   # 每行 {ts,gid,mid,name}
```

和在群里发过言 / 申请过入群的人都能查到；从没发过言的查不到（这是平台限制，不是 bug）。

## 目录结构

```
qqbot-pack.json
cover.png
lib/avatar.mjs          ← 台账读取 + 名字反查 + qlogo 下载（工具与命令共用）
tools/qq_avatar.mjs     ← AI 可调工具
commands/头像.mjs        ← 斜杠命令
```
