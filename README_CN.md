# tlive v1.0

[![npm version](https://img.shields.io/npm/v/tlive)](https://www.npmjs.com/package/tlive)
[![CI](https://github.com/y49/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/y49/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md)

> **IM 原生的 agent 织网，基于 MCP。**
> 一次安装，所有 agent 都获得 session memory、IM 通知、远程审批、多 agent
> 编排、定时任务,以及联邦化的 MCP 注册表。用 Telegram、Discord 或飞书驱动
> Claude Code 和 Codex，完全不开终端——或者继续在终端里用 claude / codex,
> 通过 MCP 把权限审批转到手机上。

## 三种使用方式

- **Daemon 模式** —— IM 就是你唯一的界面。`tlive start`、打开你的 bot、发消息。
  Claude / Codex 在 tlive daemon 里运行。
- **Companion 模式** —— 继续在本地用 `claude` / `codex`。在配置里加上
  `permissionPromptToolName: "mcp__tlive__approve"` —— 离开电脑时所有权限
  请求都推到 IM 等你审批。
- **Handoff 切换** —— 在手机 IM 里开始,到了笔记本前接着干。
  `claude --resume <alias>` 无缝续上。或者在终端里跑 `/tlive takeback`
  把控制权交回 IM。

## 快速开始

```bash
npm install -g tlive

tlive setup                  # git 感知的向导:workspace + IM token
tlive install-integrations   # 装 Claude skill + Codex prompt + MCP 入口
tlive start                  # 启动 daemon
tlive doctor                 # 结构化健康检查
```

## 从 v0.x 升级

v1.0 是完整重写。v0.x 的 PTY 包装、jsonl 扫描器、web 终端、hooks bridge
全部移除。IM 是唯一的交互界面,MCP 是程序化入口。

如果你以前把 tlive 当作"带 IM 通知的 Claude Code 终端包装"在用:v1.0 不兼容。
锁在 `tlive@0.8.x`,或者直接用原生 Claude Code / Codex CLI。

首次运行时 `tlive setup` 会把你的 `~/.tlive/config.env` 迁移成
`~/.tlive/config.json`;旧文件会备份到 `~/.tlive/config.v0-backup.env`
(或 `.v0-backup.json`)。

## 亮点

- **45 条 IM 斜杠命令** —— session 运行时的 `/model` / `/mode` / `/perm`,
  加上 `/rewind` / `/fork` / `/budget` / `/cost` / `/status`,动态拉取的
  `/models` / `/agents`。完整列表见 `docs/commands.md`。
- **8 锚点消息 UX** —— 表情 ack、session 头、活动粘滞、流式 agent 回复、
  4 种权限卡片、elicitation 表单、todo 粘滞、附件。
- **多模态** —— 从 IM 发图片和文件,Claude 直接读。Claude 在 workspace 里
  创建文件 → IM 收到下载链接。
- **MCP 联邦** —— 在 agent 配置里加一条 `tlive-self`,每个 agent 都能访问
  你的 session 历史、memory、通知,以及任何你注册的下游 MCP server。
- **Sampling、Resources (`tlive://…`)、Prompts (`/prompts tlive-*`)** ——
  tlive 是完整的 MCP 公民,不只是一个工具 namespace。
- **Warm runtime pool + cache 感知的 pre-warm** —— session 启动从 ~500ms
  降到 ~50ms,Anthropic 的 5 分钟 prompt cache 在空闲间隙保持热态。
- **定时任务** —— `/schedule daily 9am tlive-daily-standup`,session 自己跑。
- **跨 agent 流水线** —— `/pipeline run plan-impl-review "refactor auth"`
  串起 Claude 规划 → Codex 实现 → Claude 审阅。
- **每个 session 一个 thread** —— Telegram / Discord / 飞书上自动开线程。
- **多聊天镜像** —— primary chat 拿交互按钮,mirrors 只读渲染,互不污染。
- **审批策略学习** —— 点权限卡片的 "Learn",下次同类请求自动解析。
- **100% 原生 jsonl 兼容** —— 任何 tlive 驱动的 session 都能用
  `claude --resume <sdkSessionId>` 接管。

## CLI 命令面

```
Daemon 生命周期
  tlive start                      启动 daemon
  tlive stop                       优雅停止
  tlive status                     daemon + session 快照
  tlive doctor                     结构化健康检查
  tlive daemon-logs [N] [-f]       滚动 daemon 日志

Handoff
  tlive handoff  <alias>           交给本地 claude --resume
  tlive takeback <sdkSessionId>    daemon 收回一个本地驱动的会话

向导
  tlive setup                      git 感知的配置向导
  tlive install-integrations [all|claude|codex]
                                   安装 Claude skill / Codex prompt

MCP
  tlive mcp                        stdio MCP 服务器(供 Claude / Codex 调用)

Meta
  tlive version
  tlive update
```

聊天、prompts、运行时切换、预算 —— 一律通过 IM 命令或 MCP 工具调用。CLI
只管 daemon 本身。

## 配置

配置文件位于 `~/.tlive/config.json`:

```json
{
  "version": "1",
  "workspaces": [
    { "id": "ws-…", "name": "tlive", "workdir": "/home/me/tlive",
      "gitRemote": "git@github.com:…", "defaults": { "provider": "claude" } }
  ],
  "channels": {
    "telegram": { "token": "…" },
    "discord":  { "token": "…" },
    "feishu":   { "appId": "…", "appSecret": "…" }
  },
  "permissions": { "allowedUsers": ["…"], "defaults": { "fs_write": "ask" } },
  "schedules":   [ /* cron 任务 */ ],
  "mcpRegistry": { /* 下游 MCP servers */ }
}
```

`tlive setup` 以交互方式编辑它,daemon 启动时校验 schema。

## 架构

一图概览:

- **Daemon** (`src/daemon/`) —— 长驻 Node 进程,持有本地 Claude / Codex
  runtime,路由 MCP,向 IM adapter 分发。
- **Runtime** (`src/runtime/`) —— 单一 `AgentRuntime` 接口;Claude 基于
  `@anthropic-ai/claude-agent-sdk`,Codex 基于 `codex app-server`。
- **Session** (`src/session/`) —— LocalSession (daemon 自持 runtime) +
  RemoteSession (MCP 驱动),由 `SessionLike` 统一。
- **Permission / Attachment** (`src/permission/`, `src/attachment/`) —— 4
  类权限,策略学习,双向附件。
- **MCP** (`src/mcp/`) —— tlive-self server、下游联邦、cron、跨 agent
  orchestrator、内置 servers。
- **IM** (`src/im/`, `src/platform/`) —— SessionFrontend + 12 个 renderer +
  Telegram / Discord / 飞书 adapter。

v1.0 完整设计见 `docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md`。

## 开发

```bash
git clone https://github.com/y49/tlive
cd tlive
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT。详见 [LICENSE](LICENSE)。

## Contributing

见 [CONTRIBUTING.md](CONTRIBUTING.md)。
</content>
</invoke>