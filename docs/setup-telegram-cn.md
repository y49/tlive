# Telegram 配置指南

[返回入门指南](getting-started-cn.md)

本指南带你创建 Telegram 机器人并将其接入 tlive。完成后你就能在已配置的
聊天中收到 Claude Code 工具审批卡片和状态通知。

**v2.0：** 配置文件为 `~/.tlive/config.json`，由 `tlive setup` 向导
写入，同时安装 Claude Code hooks。

## 前置条件

- Telegram 账号。
- 约 5 分钟。
- （可选，用于"一会话一话题"）一个把机器人设为管理员的**话题群组
  (forum group)**。

## 第一步 —— 通过 @BotFather 创建机器人

1. 在 Telegram 搜索 **@BotFather**，发送 `/newbot`。
2. 设置**显示名**（例如「我的 tlive bot」）。
3. 设置**用户名** —— 必须以 `bot` 结尾（如 `my_tlive_bot`）。
4. BotFather 会回一个 Token，形如
   `7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。
5. 复制完整 Token，并妥善保管。

推荐 BotFather 设置：

| `/setprivacy` | Disable | 让机器人能读到群消息（群组/话题群组必需）。 |

> tlive 启动时通过 `setMyCommands` 自动注册命令菜单，无需手动
> `/setcommands`（参见规范 §10.1 `bot-commands.ts`）。

## 第二步 —— 获取 Chat ID

tlive 需要知道要把消息发到哪个聊天。

1. 在 Telegram 搜索机器人用户名，点 **Start** 开始对话。
2. 发一条任意消息（如 `hello`）。
3. 浏览器打开（把 `YOUR_TOKEN` 换成 Token）：
   ```text
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
4. 在 JSON 中找 `"chat":{"id":123456789,...}` —— 那串数字就是你的 Chat ID。
5. **群聊/话题群**的 Chat ID 是负数，如 `-1001234567890`。

## 第三步 —— （可选）白名单用户 ID

若不想让任何搜到机器人的人都能用，用 user ID 过滤。

1. 搜索 **@userinfobot**，随便发一条消息。
2. 它会回复你的数字 Telegram user ID。
3. 收集所有需要授权的用户 ID。

> 建议：至少设置 `chatId` 或 `allowedUsers` 之一。

## 第四步 —— 运行 `tlive setup`

```bash
tlive setup
```

在询问 channel 时选择 **Telegram**，依次粘贴：

- Bot token。
- Chat ID（留空则允许任意授权用户私聊）。
- 授权用户 ID（逗号分隔）。

向导会把如下配置写入 `~/.tlive/config.json`：

```json
{
  "channels": {
    "telegram": {
      "token": "7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "chatId": "123456789",
      "allowedUsers": ["123456789"],
      "requireMention": true
    }
  }
}
```

后续可以手动编辑。字段说明（规范 §10.1）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `token` | string | BotFather 给的 bot token。 |
| `chatId` | string \| string[] | 限定特定 chat（负数 = 群组）。 |
| `allowedUsers` | string[] | 用户白名单。 |
| `requireMention` | boolean | 群里是否要求 @机器人（默认 `true`）。 |
| `webhook` | object | 见下文"Webhook 模式"，不填则走长轮询。 |
| `proxy` | string | `http://`、`https://`、`socks4://`、`socks5://`。 |

保护配置权限：

```bash
chmod 600 ~/.tlive/config.json
```

## 第五步 —— 启动与验证

```bash
tlive start
tlive status
```

`tlive status` 输出里 Telegram 探测会调用 `getMe`，✅ 意味着 token
有效、网络可达。

在配置的 Telegram 聊天中触发一次 Claude 工具调用，你应该看到一张带
Allow / Deny 按钮的审批卡片。

---

## v2.0 平台说明

- **传输层：** 默认长轮询；可选 webhook。
- **Inline 键盘：** 用于审批卡按钮（Allow / Deny）。
- **入站过滤：** 适配器只接受来自已配置 `chatId` 的消息和按钮回调，
  未配置的聊天会被静默丢弃（fail-closed）。

## Webhook 模式（可选）

生产环境建议 webhook：

```json
{
  "channels": {
    "telegram": {
      "token": "…",
      "webhook": {
        "url": "https://your-domain.com/telegram-webhook",
        "secret": "random-hex-string",
        "port": 8443
      }
    }
  }
}
```

守护进程在指定端口暴露 webhook；TLS 终止由你来做（nginx / Caddy /
fly.io 网关均可）。

## 代理

```json
{
  "channels": {
    "telegram": { "token": "…", "proxy": "socks5://127.0.0.1:1080" }
  }
}
```

支持：`http://`、`https://`、`socks4://`、`socks5://`。

---

## 常见问题

- **私聊可以但群里不回复。** BotFather 里把 `/setprivacy` 关掉；若
  `requireMention: true`，发群消息时需要 `@yourbot …`。
- **启动时 "Unauthorized"。** Token 可能被重置，复制最新的。
- **`getUpdates` 返回空。** 先给机器人发条消息，再刷新该链接。
- **权限卡按钮点了没反应。** 见
  [references/troubleshooting.md](../references/troubleshooting.md)
  的 "Permission card buttons not working" 一节。

返回 [入门指南](getting-started-cn.md) · [CLI 命令参考](commands.md)。
