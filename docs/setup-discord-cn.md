# Discord 配置指南（v1.0）

[返回入门指南](getting-started-cn.md)

本指南带你创建 Discord 机器人并接入 tlive v1.0。完成后你会拥有一个已
注册 slash 命令、按会话自动开 thread、用 Discord 原生 Modal 弹窗做
elicitation 表单的机器人。

**v1.0 变更说明：** 配置改为 `~/.tlive/config.json`（JSON，不再是环境
变量）。Slash 命令在 daemon 启动时通过
`applications.{id}.commands.put` 动态注册。

## 前置条件

- Discord 账号。
- 你有管理员权限的服务器（免费自建即可）。
- 约 10 分钟。

## 第一步 —— 创建 Discord 应用

1. 打开 [Discord 开发者后台](https://discord.com/developers/applications)。
2. 右上角 **New Application**，命名（如 "tlive"），点击 **Create**。

## 第二步 —— 创建 Bot 用户

1. 左侧 **Bot**。
2. 点击 **Reset Token**，确认。
3. **立即复制 Token** —— 只能看到一次（但可以随时重置）。

下拉至 **Privileged Gateway Intents**，开启：

- **Message Content Intent** —— 读取消息内容必需。

> 若未开启 Message Content Intent，机器人能连上但读不到任何消息，这是
> 最常见的配置错误。

### v1.0 需要的 intents（规范 §10.2）

| Intent | 作用 |
|---|---|
| Guild Messages | 接收服务器消息。 |
| Message Content | 读取消息文本内容。 |
| Guild Message Reactions | 发送 👁️ 反应作为 ack。 |
| Direct Messages | 支持私聊机器人。 |

## 第三步 —— 邀请机器人

1. 左侧 **OAuth2** → **URL Generator**。
2. **Scopes**：勾选 `bot` 和 `applications.commands`。
3. **Bot Permissions**：勾选
   - Send Messages
   - Read Message History
   - Manage Messages
   - Add Reactions
   - Create Public Threads
   - Send Messages in Threads
4. 复制底部的 **Generated URL**，浏览器打开，选择服务器，授权。

## 第四步 —— 获取 ID

开启 **开发者模式**：用户设置 → Advanced → Developer Mode = on。

- **User ID**：右键自己的用户名 → **Copy User ID**。
- **Channel ID**（可选）：右键频道 → **Copy Channel ID**。可限定机器人
  只在该频道响应。

## 第五步 —— 运行 `tlive setup`

```bash
tlive setup
```

channel 选择 **Discord**，依次粘贴：

- Bot token。
- 允许的用户 ID（逗号分隔）。
- （可选）允许的频道 ID。

向导会写入 `~/.tlive/config.json`：

```json
{
  "channels": {
    "discord": {
      "token": "MTIzNDU2Nzg5.Gh7x2A.xxxxx…",
      "allowedUsers": ["111111111"],
      "allowedChannels": ["333333333"]
    }
  }
}
```

字段说明（规范 §10.2）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `token` | string | 开发者后台的 Bot token。 |
| `allowedUsers` | string[] | User ID 白名单。 |
| `allowedChannels` | string[] | Channel ID 白名单（可选）。 |
| `registerSlashCommands` | boolean | 启动时调用 `applications.commands.put`（默认 `true`）。 |
| `proxy` | string | 仅支持 `http://` 或 `https://`（discord.js 不支持 SOCKS）。 |

保护权限：

```bash
chmod 600 ~/.tlive/config.json
```

## 第六步 —— 启动与验证

```bash
tlive start
tlive doctor
```

Discord 探测会登录 gateway。机器人上线后 tlive 自动注册 slash 命令，
在频道里输入 `/` 应该能看到 `/new`、`/sessions`、`/help` 等。

对机器人私聊或 @机器人发条消息，你应该看到 👁️ 反应、新开的会话
thread，以及流式回复。

---

## v1.0 平台要求（规范 §10.2）

- **Gateway + REST。** 事件走 WebSocket，发送 / 编辑 / 附件走 REST。
- **Slash 命令注册。** `applications.{id}.commands.put` 在启动时注册 15
  条最常用命令；剩下的 30 条照样能用，只是不出现在自动补全里。
- **一会话一 thread。** 会话头消息触发 `startThread`，后续渲染都进这个
  thread，保持主频道整洁。
- **Modal 弹窗做 elicitation。** 原生
  `InteractionResponseType.Modal`（标题 + 文本框），通过 `ModalSubmit`
  事件汇总。
- **按钮 + 下拉菜单。** 用于权限卡和多选表单字段。

## 代理

```json
{
  "channels": {
    "discord": { "token": "…", "proxy": "http://127.0.0.1:7890" }
  }
}
```

只支持 `http://` / `https://`。需要 SOCKS 时走系统级透明代理（如 Clash
TUN 模式）。

---

## 常见问题

- **机器人离线。** Token 错 / Message Content Intent 没开 / 守护进程
  没启动（`tlive status`）。
- **机器人在线但不回复。** 基本都是 Message Content Intent 没开，回去
  开启。
- **"Missing Access" / "Missing Permissions"。** 频道设了权限覆盖，
  未允许机器人角色。检查频道权限。
- **Slash 命令不自动补全。** 首次启动要几分钟传播；或者你把
  `registerSlashCommands` 设成 `false` 了。
- **启动时 "Invalid token"。** 去开发者后台重置，更新
  `config.json`。

返回 [入门指南](getting-started-cn.md) · [IM 命令参考](commands.md)。
