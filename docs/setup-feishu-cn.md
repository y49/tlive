# 飞书 / Lark 配置指南

[返回入门指南](getting-started-cn.md)

本指南带你创建飞书（或 Lark）自建应用并接入 tlive。飞书配置步骤
比其他平台略多 —— 需要创建应用、添加权限、订阅事件、发布版本并让
企业管理员审批。完成后你会拥有一个在配置的聊天中收发 Claude Code
状态通知——以及开启远程审批(`tlive mode full`)后、可在聊天里作答的
审批卡片——的机器人。

**v2.0：** 配置文件为 `~/.tlive/config.json`（JSON）。推荐用
`tlive setup` 向导填充 `adapters.feishu` 字段并注册 tlive 插件。

## 前置条件

- 飞书账号（国际版用 Lark）。
- 有创建 / 审批自建应用的管理员权限（或让管理员帮忙审批）。
- 约 15 分钟。

## 第一步 —— 创建自建应用

1. 打开开发者后台：
   - **飞书（中国）：** https://open.feishu.cn/app
   - **Lark（国际）：** https://open.larksuite.com/app
2. 登录。
3. 点击 **创建自建应用**。
4. 填写：
   - **应用名称** —— 例如「tlive」。
   - **描述** —— 例如「tlive 守护进程桥」。
5. 点击 **创建**。

## 第二步 —— 获取凭证

1. 进入应用的 **凭证与基础信息** 页面。
2. 记录：
   - **App ID** —— 形如 `cli_…`。
   - **App Secret** —— 较长的字母数字串。

App Secret 请妥善保管。

## 第三步 —— 批量开通权限

进入 **权限管理**，点 **批量开通**，粘贴：

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "im:chat:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ]
  }
}
```

### 权限用途

| 权限 | 作用 |
|---|---|
| `im:message`、`im:message:send_as_bot` | 机器人发送消息。 |
| `im:message:readonly`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly` | 读取私聊 / 群聊 @机器人 消息。 |
| `im:chat:readonly` | 查询聊天基础信息用于会话绑定。 |
| `cardkit:card:read`、`cardkit:card:write` | 交互式卡片（权限卡、会话头、活动 sticky、表单卡）。 |
| `im:resource` | 上传 / 下载附件（用户上传的图片、Claude 产出的文件）。 |

完整 UX 下以上全部必需。缺 `cardkit:card:write` 会禁用 sticky 的
就地编辑，降级为追加式渲染。

## 第四步 —— 配置事件（WebSocket）

在 **事件与回调**：

1. **事件订阅** 下点 **添加事件**，加入：
   - `im.message.receive_v1` —— 接收消息。
   - `card.action.trigger` —— 卡片按钮点击。
2. **回调模式** 选择 **长连接（WebSocket）**。
   **不要**选 HTTP 回调；tlive 只用 WebSocket，你无需公网地址。

> 仅支持长连接（WebSocket）：守护进程从你本机反向连飞书，不需要开防火墙
> 或配 TLS。

## 第五步 —— 发布并审批

1. 左侧 **版本管理与发布**。
2. **创建版本**：
   - **版本**：`1.0.0`。
   - **更新说明**：简短即可。
   - **可用范围**：选指定部门或「全部成员」。
3. 点 **提交审核**。
4. 企业管理员审批：
   - 飞书：https://feishu.cn/admin
   - Lark：https://larksuite.com/admin
   - 在 **应用审核** / **企业应用** 里找到你的应用，点 **通过**。

如果你自己就是管理员，提交后直接在管理后台自审通过即可。

## 第六步 —— 运行 `tlive setup`

```bash
tlive setup
```

channel 选择 **Feishu**，依次粘贴：

- App ID。
- App Secret。
- Chat ID —— 机器人发送的目标聊天的 `open_chat_id`(`oc_…`)。

向导写入 `~/.tlive/config.json`：

```json
{
  "adapters": {
    "feishu": {
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "…",
      "chatId": "oc_xxxxxxxxxxxxxxxx"
    }
  },
  "allowedSenders": [{ "channel": "feishu", "userId": "ou_xxxxxxxxxxxxxxxx" }]
}
```

| 字段 | 类型 | 作用 |
|---|---|---|
| `adapters.feishu.appId` | string | 开发者后台的 App ID。 |
| `adapters.feishu.appSecret` | string | 开发者后台的 App Secret。 |
| `adapters.feishu.chatId` | string | 机器人发送的目标聊天——它的 `open_chat_id`(以 `oc_` 开头)。**发送必需。** |
| `allowedSenders` | `{channel, userId}[]` | 可选的按用户加固——Open ID(`ou_…`)。空 ⇒ 信任已配置的聊天。 |

`chatId` **发送必需**。如果还没拿到,这一问留空、之后再补——从群信息里拿,
或在机器人收到你第一条消息后(第七步)从入站事件里读——再重跑 `tlive setup`
(或直接改文件)填上。

保护权限：

```bash
chmod 600 ~/.tlive/config.json
```

## 第七步 —— 启动并验证

```bash
tlive start
tlive status
```

飞书探测会调用 `auth/v3/tenant_access_token/internal`，返回
`code: 0` 即凭证有效;`mode:` 行显示当前姿态(默认 `notify`)。

打开飞书搜索应用名，机器人应出现在 **机器人** / **应用** 分类下。
先给它发 `/help` 确认能收到回复。想验证**审批卡**,先开远程审批
(`tlive mode full`),再触发一次 Claude 工具调用——默认 `notify` 模式下
不会发卡(工具提示留在本地)。

---

## v2.0 平台说明

- **事件传输：** 仅长连接（WebSocket）。无需公网地址——守护进程主动
  向外连接飞书。
- **交互卡片：** 审批卡使用飞书卡片 schema v2 的 callback 按钮行为。
- **入站过滤：** 适配器只接受来自已配置 `chatId` 的消息和卡片回调，
  其他聊天会被静默丢弃（fail-closed）。

## Lark 国际版

开发者 / 管理后台不同：

- 开发者后台：https://open.larksuite.com/app
- 管理后台：https://larksuite.com/admin

权限标识、事件名、API 形状,以及 tlive 配置(`appId` / `appSecret` /
`chatId`)完全相同。注意 tlive **暂不**提供飞书/Lark 端点切换(没有
`lark`/`domain` 配置字段)——用的是 `@larksuiteoapi/node-sdk` 默认。若你在
Lark 国际版且连不上,请提 issue。

---

## 常见问题

- **"应用未审批" / 飞书里找不到机器人。** 没发版本，或者管理员还没
  批准。
- **收不到事件。** 你选了 HTTP 回调，请改回长连接。
- **权限不足。** 某个 scope 是在上次发版之后新加的 —— 新建版本再审批。
- **"Invalid App ID" / "Invalid App Secret"。** 打错，或复制错了应用
  的凭证。
- **飞书里机器人有回复但 tlive 日志什么也没有。** `config.json` 漏了
  `adapters.feishu`，或者改完配置没有重新 `tlive start`。

返回 [入门指南](getting-started-cn.md) · [CLI 命令参考](commands.md)。
