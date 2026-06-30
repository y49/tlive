# tlive

[![npm version](https://img.shields.io/npm/v/tlive)](https://www.npmjs.com/package/tlive)
[![CI](https://github.com/y49/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/y49/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md)

> **厂商中立、自托管的 AI 编码 agent「远程审批 + 监看」层。**
>
> 你在沙发上、在路上,Claude Code / Codex 卡在权限确认上——tlive 用两家都已
> 支持的**开放 hook 机制**,把权限审批、状态通知推到**你选的渠道(含飞书)**,
> 手机上一键批准让它继续。跨 Claude / Codex,**不挑订阅还是 API key**,
> **会话和数据都不出你的机器**。

## 它怎么工作

tlive **不驱动你的会话**——你照常在终端里跑你自己的 `claude` / `codex`。
tlive 只往 `~/.claude/settings.json` 装几个 hook:

- **`PreToolUse`** → 每次工具调用前,把审批卡推到飞书/Telegram,你点"允许/拒绝",
  hook 阻塞等你的回应。
- **`Stop`** → Claude 停下时推通知,你回一句话作为续跑指令。
- **`Notification` / `PostToolUse`** → 状态 / 工具活动通知。

会话始终是你本地交互式的 `claude` —— 留在订阅额度内,不经任何厂商云中转。
**没绑定 chat / 超时时,hook 静默退出、回落到本地终端弹窗**(不自动批、不全拒)。

## 为什么不用官方自带的远程?

官方远程(Claude Remote Control / Codex 手机端)有**结构性、不会消失的空白**:

- **跨 agent** —— Anthropic 的远程不会控制 Codex,反之亦然;tlive 一套同时管两家。
- **API key 用户** —— 官方远程明确不支持;tlive 不挑鉴权。
- **自托管** —— 官方跑厂商云;tlive 跑在你机器上。
- **飞书** —— 官方 Channels 只有 Telegram / Discord / iMessage;tlive 原生飞书。

tlive 填的就是这块——**官方结构上做不到、也不会做的那一层**。

**不做什么**:tlive 不做"在手机上从零写代码"——那块交给官方 Remote Control /
Codex 手机端,它们做得更好且免费。tlive 只做审批、通知、监看。

## 快速开始

```bash
npm install -g tlive

tlive setup                 # 向导:workspace + IM 凭证(Telegram / 飞书)
tlive install-integrations  # 往 ~/.claude/settings.json 写 hooks
tlive start                 # 启动常驻 daemon

# 然后照常在你的 workspace 目录里跑:
claude
```

工具调用需要审批时,你绑定的飞书 / Telegram 会收到带按钮的卡片。

## CLI 命令面

```
Daemon 生命周期
  tlive start | stop | restart | status | doctor | daemon-logs

Hook 集成
  tlive hook <event>          Claude hook shim(读 stdin,输出 decision;由 Claude 调用)
  tlive install-integrations  写 ~/.claude/settings.json hooks(幂等)
  tlive approve <requestId>   命令行兜底批准一个待处理权限

Workspace
  tlive workspace add | list | remove

向导 / Meta
  tlive setup
  tlive version | update
```

## 架构

- **Daemon**(`src/kernel/daemon/`)—— 常驻 Node 进程,跑 IPC server + IM adapter,
  撮合审批 / 续跑 / 通知。
- **Hook shim**(`src/cli/subcommands/hook.ts` + `src/kernel/hook/normalizer.ts`)
  —— Claude 调用的薄入口,stdin → IPC → decision。
- **撮合**(`src/kernel/daemon/permission-router.ts`、
  `src/kernel/permission/continue-broker.ts`)—— 按 workspace 把请求路由到绑定的
  IM chat,阻塞等回应。
- **IM adapters**(`src/adapters/im/`)—— Telegram(grammy)、飞书(lark)。
- **IPC**(`src/kernel/ipc/`)—— 跨平台 unix socket / Windows 命名管道。

`claude` / `codex` 是**你自己的进程**,tlive 通过它们 settings 里的 hook 做松耦合
集成——没有 SDK、没有版本绑定、不经厂商云。

## 从 v1.0 升级

v1.0 是用 Agent SDK 驱动会话的 IM 桥。v2.0 改为 hook 层(详见 `CHANGELOG.md`)。
这是 breaking change,不提供自动迁移:重新跑 `tlive setup` + `tlive install-integrations`。
v1.0 架构保留为 git tag `v1.0-sdk-bridge`。

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
