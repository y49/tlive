# tlive

[![npm version](https://img.shields.io/npm/v/tlive)](https://www.npmjs.com/package/tlive)
[![CI](https://github.com/y49/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/y49/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md)

> **厂商中立、自托管的 AI 编码 agent 远程审批 + 实时监看层。**
>
> 你的 `claude` / `codex` 照常在终端里跑。tlive 借两家都支持的**开放 hook 机制**,
> 把审批卡和状态推到 **Telegram / 飞书**,并在你自己的机器上提供 **web 仪表板 +
> 真实终端**——在任何设备上批准、回复、发截图,甚至接管打字。**订阅还是 API key
> 都能用**,会话与数据永不离开你的机器。

## 30 秒跑起来

```bash
npm install -g tlive

tlive setup        # 向导:先用 Claude Code/Codex 自己的插件管理器注册 tlive
                    # 插件(hooks/skill//tlive:* 命令),再问 IM 凭据——也可以
                    # 整个跳过,进 Claude/Codex 里说"帮我配置 tlive"
tlive start        # 起 daemon —— 打印 web 地址 + 手机扫码二维码

tlive run claude   # (可选)包装会话 → 实时 web 终端 + 预览卡
```

扫一次码,dashboard 列出所有会话。工具调用需要审批时,IM 收到带
**允许 / 拒绝 / 总是允许** 按钮的卡片,web 卡片同步亮红。

## 两档集成

| | 只装 hooks(照常跑 `claude`/`codex`) | 包装(`tlive run claude`/`codex`) |
|---|---|---|
| 审批卡(IM + web) | ✅ | ✅ |
| IM 回复续跑 | ✅(续跑窗口内) | ✅ |
| dashboard 会话卡 | ✅ 状态 / 最后一句 | ✅ + 实时终端预览 |
| 真实 web 终端(xterm) | — | ✅ 多设备、手机键条 |
| IM 引用回复 → 打字进终端 | — | ✅ |
| IM 发图/文件 → agent | — | ✅(下载后注入路径) |
| web 粘贴/拖拽上传 | — | ✅ |

只装 hooks 永远可用,包装是纯加法。IM 消息带标签区分:`[⌨ label]`(包装,可注入)
vs `[label]`(仅 hooks)。

## 功能一览

- **审批** —— Claude Code 上是双通道:`PermissionRequest` hook 与本地权限
  对话**并行**——两边同时可答,先到先得。IM 按钮 / web 卡默认 30 分钟内可答
  (`approvals.claudeWindowSec` 可配至约 24 小时);
  在键盘上答了,远程卡几秒内自动收尾("已在终端处理")。Codex 上是 tlive
  接管(adopt-or-spawn)一个 `codex app-server` companion 进程,Codex TUI
  自动连上它——远程卡和原生提示同样并行竞速,先答先得,没有窗口要配
  (见安全模型)。diff/命令渲染、高危模式标记、
  secret 打码。**"总是允许 \<工具\>"** 按工具放行(内存态,重启清零)——在
  Claude Code 上现在等于远程替你点掉原生对话;`/trust on|off` 整体暂停审批。
  **绝不自动拒绝**;没人答时本地提示一直有效。
- **续跑** —— `Stop` 时回复 IM 消息(或 web 回复框),会话继续。
- **daemon 懒启动** —— 仅装 hooks 的会话不再需要先手动 `tlive start`:
  `SessionStart` 时 shim(以及 `tlive run` 启动时)检测到 daemon 未运行,会
  自动 detached 拉起(不阻塞会话)。`daemon.autoStart: false` 可关闭;
  `tlive start` 手动启动语义不变。
- **失败告警(仅 Claude Code)** —— `PostToolUseFailure`(工具调用失败)与
  `StopFailure`(会话级错误,如 rate-limit/billing)会推一条 ❌ IM 消息。纯
  旁路,不影响任何审批决策;Codex 没有对应 hook,只对 Claude Code 生效。
- **会话内欢迎提示(仅 Claude Code)** —— IM 还没配置时,`SessionStart` 会往
  会话上下文里注入一句提示,引导你说"帮我配置 tlive";配置好之后就不再出现。
  Codex 不注入。
- **web 终端** —— `tlive run <cmd>` 在 `/s/<id>` 提供 pty:xterm.js、多设备
  **last-input 布局权**(谁打字网格归谁,其他端等比缩放)、晚到客户端全屏重建、
  软键盘感知布局、触屏查看/输入双模式、可拖动可收起的快捷键条
  (Esc/Tab/⇧Tab/Ctrl-C/…)、字号调节、复制屏幕弹层。
- **dashboard** —— `/` 列出会话:状态徽章、"卡住 Nm"、最后一句、着色审批卡、
  实时终端预览、per-session 静音、📎 上传、回复框。
- **给 agent 喂任何东西** —— IM 引用回复文本、IM 图片/文件、终端页粘贴/拖拽、
  dashboard 📎。统一落 `~/.tlive/inbox`(自动清理:48 小时 / 256MB 总量),
  以 bracketed paste 打进 pty。

## 安装:走插件,不再手写配置

`tlive setup`(以及 `tlive setup --hooks-only`)不再手改
`~/.claude/settings.json` / `~/.codex/hooks.json`,而是调用**各家自己的
插件管理器**:

- Claude Code:`claude plugin marketplace add <内置目录>` 再
  `claude plugin install tlive@tlive --scope user`。
- Codex(`codex` 在 `PATH` 上时):`codex plugin marketplace add <内置目录>`
  再 `codex plugin add tlive@tlive`。

Claude Code 插件里打包了 9 个 hook 事件、一个 `tlive` skill(用法/诊断/
安全模型,挂在 `/tlive:*` 命名空间下)、以及 `/tlive:url`、`/tlive:status`
两个 slash 命令。Codex 插件只带 skill——Codex 没有 hook 也不需要,它的集成
方式是 app-server companion(见下文)。厂商会把插件
**复制**进自己的 cache(Claude Code 是 `~/.claude/plugins/cache`,Codex 是
`$CODEX_HOME/plugins/cache/tlive/tlive/local/`)——升级 `tlive` 本体之后,
重跑一次 `tlive setup --hooks-only` 刷新这份拷贝。

用过早期直写 hooks 的开发版?请手动删一次旧条目(否则会双发)——见
[docs/manual-hooks.md](docs/manual-hooks.md) 附录。tlive 本身不再改动你的
厂商配置文件。

**老版本厂商没有插件 CLI**:`tlive setup` 会检测到(`claude plugin list` /
`codex plugin marketplace add` 失败)并打印指向手动配置附录的提示:
[docs/manual-hooks.md](docs/manual-hooks.md)——完整的 `settings.json`
hooks 块和 `hooks.json`,可以直接拷进去。

卸载(`npm uninstall -g tlive`)会尽力用各家 CLI 卸掉插件,并清理残留的旧
直写 hooks;`~/.tlive` 下的配置和日志保留。

**先从 GitHub 直接尝鲜**(不用等 npm 发布插件):`claude plugin marketplace
add y49/tlive` 再 `claude plugin install tlive@tlive`,直接从仓库根的
`marketplace.json` 拉插件(hooks/skill/命令)。引擎本体还是要装:
`npm i -g tlive`——daemon/CLI 靠它,hooks 调它。

`tlive setup` 在同时检测到 `claude` 和 `codex` 都在 `PATH` 上时会问**装到
哪**:`[1] Claude Code [2] Codex [3] 都装(默认)`。插件注册永远先于 IM 凭据
询问,IM 这步可以整段跳过——直接回车过掉,之后在 Claude Code 或 Codex 里说
"帮我配置 tlive"(Claude Code 里也可直接跑 `/tlive:setup`;Codex 无斜杠命令,
说那句话即可),AI 会交互式带你配完。

## Codex:app-server companion

Codex 没有 hook、也没有信任这一步——上面 Claude 那套 hooks/trust 流程完全
不适用。tlive 改为接管一个 `codex app-server --listen unix://…` 进程:
如果 tlive 的 socket 路径上已经有一个在监听就直接 adopt,没有就自己 spawn
并托管(带 respawn/backoff)。你跑的任何 `codex` TUI 都会**自动连上**那个
socket——这是 Codex 自身的特性,不是 tlive 每次会话去配置的。

在那条 RPC 连接上,tlive 订阅 Codex 自己的 thread/turn 事件,并通过
`ServerRequest` 驱动审批:Codex 请求权限决策时,tlive 把同一个请求同时
广播给 IM/web 和原生 TUI 提示——**先答先得**,和 Claude Code 的并行通道
语义一致。没有窗口要配置:原生提示永远不会被 tlive 卡住,因此也没有什么
会超时。

如果 companion 连不上(没装 Codex、respawn 耗尽了 backoff、或者在
win32 上——`codex app-server` 那边还没接好),`tlive status` 会如实报告
(`codex: app-server companion unreachable — approvals local-only`),
Codex 照常走它自己的本地审批流——没有 IM/web 卡,不会崩,只是少了远程
通道。

## 为什么不用官方远程?

官方远程(Claude Remote Control / Codex 手机端 / Channels)有 tlive 正好补上的
结构性空白:

- **跨 agent** —— 一套配置同时管 Claude Code 和 Codex。
- **API-key 用户** —— 官方远程不支持;tlive 不关心你怎么认证。
- **自托管** —— 链路上没有厂商云;web 由单 token 把门。
- **飞书** —— 官方渠道不覆盖。

tlive 刻意**不做**"手机从零 vibe coding"——官方远程做得更好。tlive 是给你已经
在跑的会话做审批 / 监看 / 插话的那一层。

## 安全模型

- **web**:每个 HTTP/WS 请求都要 token(`~/.tlive/web-token`,0600)。默认绑
  `0.0.0.0` 方便手机走局域网——token 是门。想只留本机,设
  `web.bind: "127.0.0.1"`。
- **`web.publicUrl`**(可选,如 tailscale/HTTPS 反代):设置后 IM 消息携带
  **含 token 的**深链——聊天必须可信,否则别设。
- **IM 入站**:fail-closed。非配置 chat 的消息/按钮一律丢弃;群聊场景可加
  `allowedSenders` 按用户加固。
- **`/trust on` 与"总是允许"是高危开关**:会自动放行。两者皆内存态、daemon
  重启即清。优先用按工具放行而非 `/trust`。你自己 Claude 设置里的
  `permissions.deny` 永远赢——hook 无法越过它。
- **兜底是静默**:没配 chat、超时、daemon 没起 → hook 输出 `{}`,Claude 在
  本地终端照常提示,就像 tlive 不存在。
- **Codex 审批天然 fail-safe**——原生提示永远不会被 tlive 卡住(没有窗口,
  也就没有超时);companion 连不上时 Codex 就走自己的本地审批流,`tlive
  status` 会报告 `codex: app-server companion unreachable — approvals
  local-only`。companion 在线时,远程卡和原生提示同场竞速——先答先得,和
  Claude Code 的并行通道语义一致。

## CLI

```
tlive setup            向导 + 注册厂商插件(幂等);--hooks-only 只重装插件
tlive start | stop     daemon 生命周期(stop 幂等)
tlive status           健康态、web 地址 + 二维码、配置路径
tlive logs [-f]        看 daemon 日志
tlive run <cmd> …      包装进程:本地终端 + web 终端
tlive url              打印 dashboard 地址 + 二维码(全屏应用盖住 run banner 时用)
tlive hook <event>     hook shim(Claude Code 调用,不是给你用的;
                        Codex 没有 hook——见 app-server companion)
```

IM 命令:`/perm on|off`(静音)、`/trust on|off`、`/help`。
引用任意会话消息回复 = 打字进那个会话。

## 配置(`~/.tlive/config.json`)

```jsonc
{
  "adapters": {
    "telegram": { "token": "…", "chatIdAllowList": ["123"] },
    "feishu":   { "appId": "…", "appSecret": "…", "chatId": "oc_…" }
  },
  "web": {
    "enabled": true,          // 默认 true
    "bind": "0.0.0.0",        // 默认;只留本机用 127.0.0.1
    "port": 7681,
    "publicUrl": "https://dev.example.ts.net"  // 可选:IM 深链
  },
  "daemon": {
    "autoStart": true         // 默认 true;设 false 关闭 session-start 懒启动
  },
  "allowedSenders": [{ "channel": "telegram", "userId": "42" }]  // 可选
}
```

## 使用技巧

- **会话保活**:tlive 有意不拥有会话——`tlive run` 随终端退出而结束。想要
  detach/reattach:`tmux new -s work tlive run claude`。tmux 管保活,tlive 管
  远程层。
- **手机上滚动**:查看模式下手指滑动会转成滚轮事件——全屏 TUI(claude)的
  对话区像桌面鼠标滚轮一样滚动。看完整历史用键条上的 `Ctrl-R`(transcript)。
- **如何感知被包裹?** 被包裹的进程环境里有 `TLIVE_SESSION=<id>`(类似
  `$TMUX`);`tlive run` 在包裹内拒绝嵌套。同一目录开多个包裹会话没问题——
  各自独立卡片,包裹内的 hook 流量经 `TLIVE_SESSION` 精确归属到对应卡。
- **Windows**:设计上支持(命名管道、ConPTY),但实测少于 Linux/macOS——
  欢迎提 issue。

## 架构

```
你自己的 claude ────────── hooks ──▶ tlive hook shim ──IPC──▶ daemon
你自己的 codex ─────────── rpc ───▶ tlive app-server companion ──▶ daemon
tlive run <cmd>(前台拥有 pty)── per-session socket ──▶ 桥接
                                                        daemon ──▶ IM adapters(Telegram/飞书)
                                                        daemon ──▶ web(token 门):dashboard + /s/<id>
```

- **daemon 不拥有会话**:只撮合审批/续跑、fan-out pty 字节、服务 web。
- **冻结面**(由 `tests/contract/` 锁定的契约)见 [KERNEL.md](KERNEL.md)。

## 从 v1.0 升级

v1.0 用 Agent SDK 驱动会话;v2 转向 hook 层(见 `CHANGELOG.md`)。Breaking、
无迁移:重跑 `tlive setup`。v1.0 保留在 git tag `v1.0-sdk-bridge`。

## 开发

```bash
git clone https://github.com/y49/tlive
cd tlive
pnpm install
npm run typecheck && npm test && npm run build
```

## 许可

MIT,见 [LICENSE](LICENSE)。贡献指南:[CONTRIBUTING.md](CONTRIBUTING.md)。
