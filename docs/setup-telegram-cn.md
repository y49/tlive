# Telegram 配置指南

[返回入门指南](getting-started-cn.md)

本指南带你创建 Telegram 机器人并将其接入 tlive。完成后你就能在已配置的
聊天中收到 Claude Code 状态通知——以及开启远程审批(`tlive mode full`)后、
可在聊天里作答的审批卡片。

**v2.0：** 配置文件为 `~/.tlive/config.json`，由 `tlive setup` 向导
写入,并注册 tlive 插件(hooks + skill + 命令)。

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
> `/setcommands`。

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

## 第三步 —— （可选）授权发送者

tlive 默认信任来自白名单聊天里的任何人。想进一步按*用户*限制(群聊有用),
收集 user ID:

1. 搜索 **@userinfobot**，随便发一条消息。
2. 它会回复你的数字 Telegram user ID。
3. 每个用户加一条 `allowedSenders`(见第四步)。

> 建议:至少设置 `chatIdAllowList`(限定哪些聊天)或 `allowedSenders`
> (限定哪些用户)之一。

## 第四步 —— 运行 `tlive setup`

```bash
tlive setup
```

在询问 channel 时选择 **Telegram**，依次粘贴：

- Bot token。
- Chat ID(机器人发送的目标聊天)。

向导会把如下配置写入 `~/.tlive/config.json`：

```json
{
  "adapters": {
    "telegram": {
      "token": "7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "chatIdAllowList": ["123456789"]
    }
  },
  "allowedSenders": [{ "channel": "telegram", "userId": "123456789" }]
}
```

后续可以手动编辑。

| 字段 | 类型 | 作用 |
|---|---|---|
| `adapters.telegram.token` | string | BotFather 给的 bot token。 |
| `adapters.telegram.chatIdAllowList` | string[] | 机器人发送、且接受输入的聊天 ID;其它聊天的入站一律丢弃(fail-closed)。负数 = 群组/话题群。 |
| `allowedSenders` | `{channel, userId}[]` | 可选的按用户加固(第三步)。空 ⇒ 信任白名单聊天里的任何人。 |

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
有效、网络可达；`mode:` 行显示当前姿态(默认 `notify`)。

先给机器人发 `/help` 确认能收到回复。想验证**审批卡**,先开远程审批
(`tlive mode full`),再触发一次 Claude 工具调用——默认 `notify` 模式下
不会发卡(工具提示留在本地)。

---

## v2.0 平台说明

- **传输层：** 长轮询(无需公网 URL / webhook / TLS——守护进程主动外连
  Telegram)。
- **Inline 键盘：** 用于审批卡按钮（Allow / Deny）。
- **入站过滤：** 适配器只接受来自 `chatIdAllowList` 里聊天的消息和按钮回调,
  其它聊天一律静默丢弃（fail-closed）。

---

## 常见问题

- **私聊可以但群里不回复。** BotFather 里把 `/setprivacy` 关掉,并确认群的
  ID 在 `chatIdAllowList` 里。
- **启动时 "Unauthorized"。** Token 可能被重置，复制最新的。
- **`getUpdates` 返回空。** 先给机器人发条消息，再刷新该链接。
- **权限卡按钮点了没反应。** 远程审批是 opt-in 的,默认的 `notify` 姿态从不
  hold 审批,也就没有可作答的卡。用 `tlive mode full` 切换。若卡片出现但按钮
  不生效,先 `tlive status` 确认 daemon 活着,再看 `tlive logs`。

返回 [入门指南](getting-started-cn.md) · [CLI 命令参考](commands.md)。
