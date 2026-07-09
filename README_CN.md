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

tlive setup        # 向导:IM 凭据 + 用 Claude Code/Codex 自己的插件管理器注册
                    # tlive 插件(hooks/skill//tlive:* 命令;PATH 里有 codex
                    # 就一并装,见下方「Codex」一节)
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

- **审批** —— `PreToolUse` hook 阻塞等你在 IM 按钮或 web 卡上回答。diff/命令
  渲染、高危模式标记、secret 打码。策略引擎自动放行只读工具;**"总是允许
  \<工具\>"** 按工具放行(内存态,重启清零);`/trust on|off` 整体暂停审批。
  **绝不自动拒绝**;超时回落到本地终端提示(Claude Code)或原生审批提示
  (Codex——fail-open 行为不同,见安全模型)。
- **续跑** —— `Stop` 时回复 IM 消息(或 web 回复框),会话继续。
- **daemon 懒启动** —— 仅装 hooks 的会话不再需要先手动 `tlive start`:
  `SessionStart` 时 shim(以及 `tlive run` 启动时)检测到 daemon 未运行,会
  自动 detached 拉起(不阻塞会话)。`daemon.autoStart: false` 可关闭;
  `tlive start` 手动启动语义不变。
- **失败告警(仅 Claude Code)** —— `PostToolUseFailure`(工具调用失败)与
  `StopFailure`(会话级错误,如 rate-limit/billing)会推一条 ❌ IM 消息。纯
  旁路,不影响任何审批决策;Codex 没有对应 hook,故不给它装。
- **本地审批等待提醒** —— Claude Code 自己的权限对话在终端弹出时(tlive 已
  回落/超时),IM 里的提醒消息会带 `⏳ 终端正在等待你的审批` 前缀,提示离屏
  用户回终端处理。
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
  `claude plugin install tlive@tlive --scope user -y`。
- Codex(`codex` 在 `PATH` 上时):`codex plugin marketplace add <内置目录>`
  再 `codex plugin add tlive@tlive`。

插件里打包了 hooks(CC 9 个事件 / Codex 5 个事件,与之前直写的集合完全一样)、
一个 `tlive` skill(用法/诊断/安全模型,挂在 `/tlive:*` 命名空间下)、以及
Claude Code 的 `/tlive:url`、`/tlive:status` 两个 slash 命令。厂商会把插件
**复制**进自己的 cache(Claude Code 是 `~/.claude/plugins/cache`,Codex 是
`$CODEX_HOME/plugins/cache/tlive/tlive/local/`)——升级 `tlive` 本体之后,
重跑一次 `tlive setup --hooks-only` 刷新这份拷贝。

首次插件安装成功还会**剥离**旧版本(直写年代)留下的 hooks,防止双发;
你自己无关的 hooks 不受影响。

**老版本厂商没有插件 CLI**:`tlive setup` 会检测到(`claude plugin list` /
`codex plugin marketplace add` 失败)并打印指向手动配置附录的提示:
[docs/manual-hooks.md](docs/manual-hooks.md)——完整的 `settings.json`
hooks 块和 `hooks.json`,可以直接拷进去。

卸载(`npm uninstall -g tlive`)会尽力用各家 CLI 卸掉插件,并清理残留的旧
直写 hooks;`~/.tlive` 下的配置和日志保留。

## Codex:hooks 需要一次性信任

装的事件(经插件,命令是 `tlive hook --codex <event>`):`PreToolUse`
(审批)、`Stop`(续跑)、`PostToolUse`、`UserPromptSubmit`、`SessionStart`。
Codex 没有 `Notification` 和 `SessionEnd` 这两个 hook,故不给它装。

坑在这:**Codex 对不信任的 hook 一律静默跳过**——不报错、不提示,就是不生效。
装完之后需要信任一次:

1. 交互式运行一次 `codex`。
2. 在它的 hooks review 里 approve tlive 的 hook——信任记录写进
   `~/.codex/config.toml` 的 `[hooks.state]` 下。
3. `tlive status` 会读这个文件,告诉你现在是 `hooks installed but NOT
   trusted` 还是已经 `hooks installed and trusted`。

想跳过交互式 review(需要 root):把 tlive 的 hook 条目写进
`/etc/codex/requirements.toml` 的 `[hooks]` 下,Codex 会把这里列出的 hook
当作预先信任的"managed hooks"——具体格式看 Codex 自己的文档,tlive 不会
替你写这个文件。

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
- **Codex 的 hook 超时是 fail-open,不是静默**——这是 Codex 与 Claude Code
  真正分叉的地方。Claude Code 的 `PreToolUse` hook 超时会回落到本地提示
  (安全,无默认动作)。Codex 的 hook 超时则默认让工具调用**照跑**。tlive
  的缓解:`~/.codex/hooks.json` 给 `PreToolUse` 配了 `timeout: 600`,shim
  自我限时约 590 秒——舒服地卡在这个窗口内——所以 tlive 总能在 Codex 自己
  的 fail-open 触发前给出 `allow`/`deny`/`ask` 三选一。没人应答时输出
  `ask`(Codex 原生审批提示),绝不自动放行。残余风险:如果 shim **进程本身
  崩溃**(而不只是超时),就没有谁能应答了,Codex 600 秒后依然会 fail-open——
  这个口子没法从 hook 这一层堵上。

## CLI

```
tlive setup            向导 + 注册厂商插件(幂等);--hooks-only 只重装插件
tlive start | stop     daemon 生命周期(stop 幂等)
tlive status           健康态、web 地址 + 二维码、配置路径
tlive logs [-f]        看 daemon 日志
tlive run <cmd> …      包装进程:本地终端 + web 终端
tlive url              打印 dashboard 地址 + 二维码(全屏应用盖住 run banner 时用)
tlive hook <event>     hook shim(Claude/Codex 调用,不是给你用的;
                        Codex 侧带 --codex)
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
你自己的 claude/codex ──hooks──▶ tlive hook shim ──IPC──▶ daemon
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
