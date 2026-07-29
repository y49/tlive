# tlive v2.0 入门指南

本指南将带你从零完成 tlive 配置。结束后，你会拥有一个运行中的守护进程、
至少一个已连接的 IM 机器人、在手机上实时监看 Claude Code / Codex 会话——
以及(如果你开启的话)审批也路由到手机。

**v2.0 变更说明：** tlive 不再是 SDK 驱动的 IM 桥接。它已经演进为
**厂商中立、自托管的 hook 监看/审批层**。守护进程不持有任何 agent 会话；
你自己的 `claude` / `codex` 进程在本地运行，通过 tlive 插件的 hooks 上报。
它的**默认姿态是 `notify`**——只监看 + 通知;远程审批(hold 住工具调用、
让你在手机上作答)是 opt-in,用 `tlive mode full` 开启。

## 前置条件

- **Node.js 20+** 和 npm（推荐 Node 22）。
- 本地已安装 **Claude Code**。
- **Telegram** 或 **飞书**任一平台的账号（可以同时启用两个）。

## 安装

```bash
npm install -g tlive
tlive --version
```

## 配置 —— `tlive setup`

```bash
tlive setup
```

向导会先用检测到的各家自己的插件管理器注册 tlive 插件（hooks/skill/
`/tlive:*` 命令）——如果 `claude` 和 `codex` 同时在 `PATH` 上，会先问装到哪
（`[1] Claude Code [2] Codex [3] 都装`，默认都装）。之后才提示填写 IM 凭证
（Telegram bot token + chat ID，或飞书 App 凭证）；这一步完全可跳过——直接
回车过掉，之后在 Claude Code 或 Codex 里说"帮我配置 tlive"（Claude Code 里也可直接
跑 `/tlive:setup`；Codex 无斜杠命令，说那句话即可），AI 会交互式带你配完。你填的内容会写入（或合并进）：

```text
~/.tlive/config.json
```

装了 Codex 插件时，setup 还会**自动信任 tlive 的 hooks**（经
`codex app-server` 的 `hooks/list` RPC 完成,失败会自检回滚)——具体机制见
README 的 Codex 一节，没成功时的手动 `/hooks` 兜底也在那里。

仅重新注册插件（例如升级 tlive 后）：

```bash
tlive setup --hooks-only
```

保护配置文件权限：

```bash
chmod 600 ~/.tlive/config.json
```

## 连接机器人

选择一个平台并按指南配置：

- [Telegram](setup-telegram-cn.md) —— 最快，约 5 分钟
- [飞书 / Lark](setup-feishu-cn.md) —— 约 15 分钟，需要企业管理员审批

## 启动守护进程

```bash
tlive start
tlive status
```

`tlive start` 会打印 web 地址(本机 + 局域网)**和一个二维码**——手机扫一次
即可打开 dashboard。`tlive status` 显示守护进程运行时间、PID、已配置的适配器、
当前生效的 **`mode:`** 行(默认 `notify`),以及同样的地址/二维码;它取代了
已删除的 `tlive doctor` 子命令。

## 包装会话(可选但推荐)

```bash
cd your-project
tlive run claude
```

`tlive run` 在只装 hooks 的基础上给**同一个会话**三项额外能力:

- `/s/<id>` 的**实时 web 终端**(多设备;谁打字布局归谁)+ dashboard 实时预览卡;
- **IM 引用注入** —— 引用该会话的任意 IM 消息回复文本,直接打进终端;
- **喂图片/文件** —— IM 里发图(或 web 页粘贴/拖拽、dashboard 📎):落到
  `~/.tlive/inbox`,路径自动打进会话。

想让会话在关掉终端后活着?配合 tmux:`tmux new -s work tlive run claude`。

---

## 工作原理

你在终端里像平常一样运行 `claude`（或 `codex`）；tlive 插件的 hooks 把每个
事件通过本地 IPC socket 上报给守护进程。接下来发生什么取决于你的**姿态**
（`tlive mode`）：

**`notify`（默认）**——只监看 + 通知，绝不 hold 住工具调用：

1. 工具调用照常走它**本地**的权限提示——tlive 把 `PermissionRequest` hook
   短路成透传，什么都不 hold、也不发出去等远程审批。
2. 权限提示（或 `AskUserQuestion`）在终端等你时，tlive 仍会提醒：桌面通知、
   dashboard 上一张只读的 *waiting-approval* 卡片、以及 grace 窗口内没答时的
   一条 IM 文本——都只是指回终端的路标，绝不代答。
3. 会话停止或空闲时，`Stop` hook 发一条 IM 通知；回复一条续跑消息即可继续。
4. 工具/会话失败会作为旁路 `⚠️` 消息推送。

**`full`**（`tlive mode full`）——`notify` 的一切，外加远程审批：

1. Claude 准备调用需要审批的工具时，`PermissionRequest` hook 会 hold 住这个
   决定，守护进程向所有已配置的 IM 聊天发送审批卡片——与本地提示**并行**
   （先答先得）。
2. 你在手机上点 **Allow** 或 **Deny**（或在键盘前答）。
3. hook 把决定返回给 Claude，Claude 继续或中止。

**`all`**（`tlive mode all`）——`full` 的一切,外加子代理审批:

1. 子代理的工具调用也会被 hold 住、变得可远程作答,和主会话审批一样——但有
   一个代价:Claude Code 要等 hook 返回之后才决定要不要建子代理的本地框,
   所以一个被 hold 的子代理在窗口结束前（超时,或手机/dashboard 作答落地）
   **没有**终端提示。只在没人在键盘前时用它;`tlive mode full` 改回让子代理
   提示直接透传。

绝不自动放行、也绝不全拒:守护进程不可达、窗口超时、或没配 chat 时,hook
回落 `{}`,控制权退回本地终端,就像 tlive 不存在。

---

## 故障排除入门

- **`config not found`** → 运行 `tlive setup`。
- **`daemon unreachable`** → `tlive start`。如果提示"已在运行"但
  `tlive status` 无响应，可能是僵尸 socket：
  `rm ~/.tlive/daemon.sock` 后重试。
- **Token 看起来没问题但没收到消息** → `tlive status` 会做在线探测
  （Telegram 的 `getMe`、飞书的 `tenant_access_token`）。
- **权限卡按钮点了没反应** → `tlive logs --follow` 查看错误。常见原因：
  daemon 重启后旧卡失效——重新发一次触发消息即可。

## 下一步

- [CLI 命令参考](commands.md)
- 平台配置指南：[Telegram](setup-telegram-cn.md) ·
  [飞书](setup-feishu-cn.md)
- [卸载 / 清理 + 从 v0.x/v1 迁移](uninstall.md)
- 返回 [README.md](../README.md) 查看架构概览。
