# tlive v1.0 入门指南

本指南将带你从零完成 tlive 配置。结束后，你会拥有一个运行中的守护进程、
至少一个已连接的 IM 机器人，以及一个可以从手机驱动的 Claude Code / Codex
会话。

**v1.0 变更说明：** tlive 不再是 PTY 终端包装器，也不再内置网页终端。它
已经演进为**以 MCP 为核心的 agent 编排基座**。旧版的 agent 包装子命令、
web terminal、hook 脚本全部移除。取而代之的是由守护进程持有一个 SDK
支撑的 runtime，你通过 IM 或本地 `claude` / `codex`（作为 MCP 客户端）
与之对话。

## 前置条件

- **Node.js 20+** 和 npm（推荐 Node 22）。
- 本地已安装 **Claude Code** 或 **Codex**——Companion 模式以及
  `/handoff-to-me` 之后的本地续聊需要。
- **Telegram / Discord / 飞书**任一平台的账号。可以同时启用多个。

## 安装

```bash
npm install -g tlive
tlive version
```

## 配置 —— `tlive setup`

```bash
tlive setup
```

向导支持 git 感知：会读取当前目录的 `git remote`，自动为你命名一个
workspace。写入/迁移配置到：

```text
~/.tlive/config.json
```

**v1.0 变更说明：** 配置从 `config.env` 迁移为 JSON。如果向导检测到 v0.x
的 `config.env`，会就地迁移并把旧文件备份为
`~/.tlive/config.v0-backup.env`。schema 由 `src/config/schema.ts`（Zod）
在守护进程启动时校验。

配置示例（完整 schema 见 `config.env.example` 与
[README.md](../README.md#config)）：

```json
{
  "version": "1",
  "workspaces": [
    { "id": "ws-…", "name": "my-project", "workdir": "/home/me/proj" }
  ],
  "channels": {
    "telegram": { "token": "…" }
  },
  "permissions": { "allowedUsers": ["…"] }
}
```

保护配置文件权限：

```bash
chmod 600 ~/.tlive/config.json
```

## 连接机器人

选择一个平台并按指南配置：

- [Telegram](setup-telegram-cn.md) —— 最快，约 5 分钟
- [Discord](setup-discord-cn.md) —— 约 10 分钟，需要服务器管理员权限
- [飞书 / Lark](setup-feishu-cn.md) —— 约 15 分钟，需要企业管理员审批

每个指南最终给出的 JSON 片段粘贴到 `~/.tlive/config.json` 的
`channels.<platform>` 即可。

## 安装 agent 集成

```bash
tlive install-integrations        # claude + codex + MCP 条目
```

或单独安装一端：

```bash
tlive install-integrations claude
tlive install-integrations codex
```

该命令会：

- 把 `src/skills/claude/` 拷贝到 `~/.claude/skills/tlive/`，注册 `/tlive`
  技能（用于 handoff）。
- 在 `~/.claude/settings.json` 中加入 `mcpServers.tlive`，指向
  `tlive mcp`（stdio server）。
- 把 `src/skills/codex/tlive.md` 拷贝到 Codex 的 prompts 目录。
- 提示 Companion 模式可选的
  `permissionPromptToolName: "mcp__tlive__approve"`。

## 启动守护进程

```bash
tlive start
tlive status
tlive doctor
```

`tlive doctor` 会执行结构化自检（config schema、平台凭证、daemon socket、
MCP 启动、warm pool）。全部通过是发布 preflight，也是
[smoke test](smoke-test.md) 的前提。

---

## 三种使用模式

任意组合都可以运行在同一个守护进程上。

### 模式 A —— Daemon mode（IM 为主）

守护进程持有 SDK runtime，IM 是唯一的交互入口。

**示例流程**

1. 打开 Telegram，私聊 `@yourbot`。
2. 发送：`帮我重构认证模块`。
3. 观察聊天中的变化：
   - 大约 100ms 内你的消息被添加 👁️ 反应。
   - **会话头**被置顶：`📁 my-project · 🤖 sonnet-4 · ⚡️ warm · 💰 $0.00`。
   - **活动 sticky** 持续更新：`🧠 thinking…` →
     `🔧 Read src/auth/cookies.ts` → `🔧 Grep passport-*` → 流式正文。
   - 当 Claude 要执行 `Bash(npm test)` 时，一张**权限卡**会出现，附带
     Allow / Deny / Always / Learn 按钮。
4. 点击 **Allow**。Claude 继续执行，sticky 更新为 `✅ done · 12.4s · $0.031`。
5. 中途改模型：发送 `/model opus`，会话头的 badge 立即变化。

适用人群：移动优先开发者；团队把 Claude 当成群组成员；"基本不开终端写代码"。

### 模式 B —— Companion mode（本地 CLI + MCP）

本地跑纯 `claude`，tlive 只充当 MCP 服务器；权限走 IM，由
`permissionPromptToolName` 路由。

**配置。** 运行 `tlive install-integrations claude` 后编辑
`~/.claude/settings.json`：

```json
{
  "mcpServers": {
    "tlive": { "command": "tlive", "args": ["mcp"] }
  },
  "permissionPromptToolName": "mcp__tlive__approve"
}
```

**示例流程**

1. 终端运行：`claude`（纯原生，不套 tlive）。
2. 告诉 Claude 跑测试：`请帮我跑 npm test`。
3. Claude 想执行 `Bash(npm test)`。由于设置了
   `permissionPromptToolName`，SDK 把权限请求走到 `tlive` MCP 服务器，
   而不是弹本地 TUI。
4. **手机收到推送**——IM 中出现一张权限卡，含 Bash 块、原因摘要、
   Allow/Deny 按钮。
5. 你点 **Allow**。MCP 工具返回 `{allow: true}`，本地 `claude` 解除
   阻塞，命令开始执行。

远程会话同样会出现在 `/sessions` 中，标记为
"💻 remote from local claude"。`/cost`、`/search`、`/export` 都可以
对它使用。

适用人群：终端流开发者，离开电脑时想让权限走手机。

### 模式 C —— Handoff（A、B 无缝切换）

一个 jsonl，同一时刻只能有一个写者——由 `workspace.activeSessionId`
保证。

**示例：Daemon → 本地**

1. 你在手机 IM 中驱动一个会话，alias 是 `a1b2c3d4`。
2. 到电脑前，在 IM 中发送：`/handoff-to-me`。
3. 守护进程停掉 runtime、释放 jsonl 锁，并在 IM 中回复：
   `📲 handed off to you —— 在本地运行: claude --resume a1b2c3d4`。
4. 本地：`claude --resume a1b2c3d4`。Claude 从 IM 放下的那一刻继续
   （system prompt、权限、工作目录、对话状态全部保留）。

**示例：本地 → Daemon**

在运行中的本地 `claude` 中输入：

```text
/tlive takeback a1b2c3d4
```

该技能会 POST 到守护进程 socket，daemon 恢复 SDK runtime，本地 claude
干净退出，IM 接管后续渲染。

---

## 故障排除入门

- **`config not found`** → 运行 `tlive setup`。首次启动会自动创建
  `~/.tlive/config.json`。
- **`daemon unreachable`** → `tlive start`。如果提示"已在运行"但
  `tlive status` 无响应，很可能是僵尸 socket：
  `rm ~/.tlive/daemon.sock` 后重试。
- **Token 看起来没问题但没收到消息** → `tlive doctor` 会做在线探测
  （Telegram 的 `getMe`、Discord 的 gateway 鉴权、飞书的
  `tenant_access_token`）。
- **权限卡按钮点了没反应** → `tlive daemon-logs --follow` 查看
  CallbackRouter 错误。常见原因：daemon 重启后旧卡失效——重新发一次
  触发消息即可。
- **`/sessions` 为空** → 会话存放在各 agent 的原生目录下
  （`~/.claude/projects/<slug>/*.jsonl`、`~/.codex/sessions/*.jsonl`）。
  `SessionDiscovery` 会读取它们；如果读取不到，检查工作区的 `workdir`
  是否指向正确目录。

完整排障表：[references/troubleshooting.md](../references/troubleshooting.md)。

## 下一步

- [45 条 IM 命令参考](commands.md)
- [手动 smoke test](smoke-test.md) —— 15 步发布前验证
- 平台配置指南：[Telegram](setup-telegram-cn.md) ·
  [Discord](setup-discord-cn.md) · [飞书](setup-feishu-cn.md)
- 返回 [README.md](../README.md) 查看架构与完整 CLI 列表。
