# IM Commands Reference (v1.0)

> **v1.0 breaking changes**: `workspaces.json` schema v1 → v2 不兼容,RBAC 角色系统已删除,
> `/admin` 命令已删除。升级步骤见 [docs/upgrade-v1.0.md](upgrade-v1.0.md)。

---

## 1. 核心概念

### Workspace(项目模板)

Workspace 是项目模板,持有 `workdir`、默认 `model`/`permissionMode`、MCP 服务器配置等。
多个 chat 可以绑定同一个 Workspace(共享项目配置),但**各 chat 的运行时状态完全独立**。

### ChatInstance(每 (channel, chat) 一个实例)

ChatInstance 是 bot 与具体一个 chat 的运行时绑定,持有:
- `activeSessionId` — 该 chat 当前活跃 session 的 id
- `costRollup` — 该 chat 累积的 cost
- `settings`(可选)— 该 chat 的覆盖配置(v2 UI 待加)

每个 `(channelType, chatId)` 对应唯一一个 ChatInstance。session / cost / history 全 per-chat 独立。

### chat-trust 信任模型

bot 拉进哪个 chat,**该 chat 内所有成员均可驱动 bot**。无 admin / operator / observer 区分。
信任边界由群管理员决定(谁能加入群 = 谁能用 bot)。

- 任何 chat 内 user 都能发 `/new` `/stop` `/model` `/mode` 等所有命令
- 不存在"只读成员"概念 — 不需要的命令不发就好
- 多群场景(例如研发群 + 运营群)通过分别绑不同 Workspace 隔离项目

---

## 2. 命令一览(12 个)

### 2.1 工作区 / 历史(5)

| 命令 | 别名 | 行为 |
|---|---|---|
| `/new [prompt] [--ephemeral] [--model=…] [--effort=…] [--force]` | — | 在当前 chat 绑定的 workspace 创建新 session。若已有活跃 session,先弹 confirm 提示替换;`--force` 跳过 confirm。可选 prompt 在 session 起来后立即作为首轮输入发送。 |
| `/sessions [--all] [--page=N]` | — | 列当前 chat 的会话(8/页)。`--all` 跨 chat 全量显示。每条带 `[▶ 继续]` `[详情]` 按钮。 |
| `/workspace` | `/ws` | **3-state UX 入口**:列 / 切 / 加 / 退。状态自适应,见 §3。 |
| `/cost [--workspace] [--all]` | — | 显示成本。默认:当前 chat 累积。`--workspace`:同 ws 跨 chat 总和。`--all`:所有 ws 全 chat 总和。 |
| `/find <keyword> [--workspace] [--all]` | `/search` | 搜会话历史。默认:当前 chat。`--workspace`:同 ws 跨 chat。`--all`:全局。用法:`/find oauth refactor`。 |

### 2.2 Session 运行时(6)

| 命令 | 别名 | 行为 |
|---|---|---|
| `/stop` | — | 中断当前 turn(等价终端 Ctrl+C)。session 进程仍存活,jsonl 不动。无活跃 turn 时回复提示。 |
| `/model [<id>]` | — | 无参显示模型 picker(SDK `supportedModels` + `[✏ 自定义]`);带参直接切换。`[设为 workspace 默认]` 按钮可持久化为 ws 默认。 |
| `/mode [<mode>]` | — | 权限模式:`default` / `acceptEdits` / `bypassPermissions` / `plan`。无参显示 4-按钮 picker。 |
| `/think [<level>]` | `/thinking` | 思考可见性:`collapsed` / `expanded` / `hidden`。无参显示 picker。 |
| `/perm [list\|allow <p>\|deny <p>\|remove <id>\|clear]` | — | 当前 session 级 allow / deny 规则;无参列规则 + `[+ 添加]` `[清空]` 按钮。 |
| `/budget [<usd>\|unlimited]` | — | **session 级**预算上限(由 `BudgetGuard` 实时拦截)。无参显示状态 + `[$10] [$25] [$50] [无限] [✏ 自定义]` 快捷按钮。 |

### 2.3 Meta(1)

| 命令 | 别名 | 行为 |
|---|---|---|
| `/help` | `/h`, `/?` | 按组列 12 个命令 + inline keyboard 提示(工作区 / session / meta 三栏)。 |

### 2.4 无活跃 session 时的 fallback

session-scoped 命令(`/stop` `/model` `/mode` `/think` `/perm` `/budget`)
在无活跃 session 时回复:

```
ℹ 当前 workspace 没有活跃 session
[🆕 起会话]   [📋 列会话]
```

workspace-scoped 命令在当前 chat 未绑定 workspace 时引导用户进 `/workspace` 流程
(unbound chat 的统一入口)。

---

## 3. `/workspace` 3-state UX

`/workspace` 行为依赖当前 chat 是否已绑定 workspace,在 3 个状态间自动切换。
**任何 chat 成员**都能看到完整视图 — 无"只读 D 态"。

### 3.1 状态 A — 未绑 chat,系统已有 workspace

```
📁 此 chat 还没进入工作区

可用工作区:
[ 📁 tlive ]      [ 📁 api-server ]
[ 📁 blog ]       [ 📁 ml-pipe ]

[ ➕ 新增工作区 ]
```

点击 `[📁 X]` 即绑定该 workspace 到当前 chat(任何成员都可操作)。

### 3.2 状态 B — 未绑 chat,系统无 workspace(全新用户)

```
📁 此 chat 还没进入工作区

(系统暂无任何工作区)

[ ➕ 新增工作区 ]
```

### 3.3 状态 C — 已绑定 workspace

```
📁 当前工作区: tlive ✓
   📂 ~/Project/test/tlive
   🤖 claude-sonnet-4-6 · default
   💬 此 chat 的会话: a1b2c3d4
   👥 其他 chat 在此项目: 2 个(各自独立)

切换到:
[ 📁 api-server ]   [ 📁 blog ]

[ ➕ 新增工作区 ]   [ ⚙ 配置 ]   [ 📤 退出工作区 ]
```

所有按钮对所有 chat 成员可见、可操作。

### 3.4 切换 workspace(`claude -r` 语义)

用户点 `[📁 X]` 切到另一个 workspace:

1. 读**当前 chat** 的 `activeSessionId`;in-flight 时弹 confirm("切走会中断当前 turn")
2. 当前 session 走 `interrupt() + stop()`(`activeSessionId` 与 jsonl 保留)
3. `removeBinding(currentWs, this chat)` + `addBinding(targetWs, this chat)`
4. 读目标 ws 中**当前 chat 的** `activeSessionId`:
   - 非 null → **lazy resume**(下条 inbound 触发,见 §5)
   - null → 提示 "已切到 X,暂无活跃会话" + `[🆕 新会话] [📋 全部会话]`

切换后所有 workspace-scoped 命令视图自动跟随新 ws。

### 3.5 per-chat 隔离(ChatInstance)

> **重要**:session 归 ChatInstance 所有,不归 workspace 所有。多个 chat 可以
> 绑定同一个 workspace(共享配置),但**各自持有独立的 ChatInstance**,互不影响。
>
> - 飞书 chat 的消息只在飞书显示,不会镜像到 Telegram(即使两个 chat 都绑到同一个 workspace)
> - chat A 的对话不会泄漏给 chat B
> - chat A 的 `/cost` 只显示 chat A 的费用(用 `--workspace` / `--all` 才跨范围)
> - 改 `ws.defaults.model` 不影响正在跑的 session,新建 session 才生效

---

## 4. Inline keyboards (detail card)

每条 assistant 回复的 detail card 末尾自动展示一组按钮。这是 v1.0 的主交互路径。

### 4.1 默认布局(4 按钮)

#### turn idle:
```
[🆕 new]  [📋 list]  [⏸]  [⋯]
                      ↑ 灰(无 in-flight)
```

#### turn in-flight:
```
[🆕 new]  [📋 list]  [⏸ 中断]  [⋯]
                      ↑ 高亮
```

中断按钮的 callback data 区分两种状态:
- in-flight → `turn:stop`
- idle → `turn:stop:idle`(no-op,只用于状态指示)

### 4.2 `[⋯]` 二级菜单(12 按钮)

```
[🔄 model]   [🎚 mode]    [🧠 think]   [💰 cost]
[✨ perm]    [💸 budget]  [📁 切ws]    [🔍 find]
[🍴 fork]    [📝 rename]  [☠ kill]     [📤 export]
[↩ 关闭菜单]
```

每个二级按钮对应一个 callback,展开为对应 slash 命令的卡片(详见 §6 callback 表)。

---

## 5. `claude -r` semantics + lazy resume

### 5.1 设计原则

> jsonl 是 **source of truth**;session 进程是 **临时**。

进程随时可以死(daemon 重启 / IdleStop / 用户切走);只要 jsonl 还在,
下一条 inbound 触发自动 resume,会话续上。

### 5.2 三个触发点共用同一条 resume 路径

| 场景 | 触发 | 行为 |
|---|---|---|
| daemon 重启 | systemd / OOM | 启动时 prune 过期 snapshot,**不主动起进程**;下条 inbound 触发 resume |
| IdleStop 24h | 自动 timer | session.stop(),`activeSessionId` 保留;下条 inbound 触发 resume |
| 切 workspace | 用户点 `[📁 X]` | 同上,session.stop() + 切 binding + 下次 inbound resume |

### 5.3 `lazyResumeOrCreate` 决策树

```
ChatInstance 有 activeSessionId?
├─ deps.isLive(id)               → sendInput(id, text)         // sent_to_live
├─ deps.hasPersistedSession(id)  → resume(id) + sendInput      // resumed
└─ 兜底                          → createLocal({...})          // created
```

- `activeSessionId`:从当前 **ChatInstance**(即当前 chat)读取
- `isLive`:进程在内存且 `getStatus() === 'active'`
- `hasPersistedSession`:`persistence.hasSnapshot(id)`(查 jsonl 文件)
- `onResumeFailed` hook 在 daemon log 暴露 silent fall-through(jsonl 损坏等)

### 5.4 启动改造:lazy autoresume

`autoResumeOnStartup` 已改为 `pruneStaleSnapshotsOnStartup`:启动时只清过期
标记,**不起任何 SDK 子进程**。所有 resume 走同一条 lazy 路径。

收益:启动时间 N×500ms → 0,内存占用 N × 100MB → 0。

---

## 6. Callback data convention

CallbackRouter (`src/im/callback-router.ts`) 的 namespace 表:

| Prefix | 用途 |
|---|---|
| `workspace:bind:<id>` | 状态 A 列表点击 → bind chat 到选中 ws |
| `workspace:switch:<id>` | 状态 C 切换 → §3.4 流程 |
| `workspace:create:start` | 状态 A/B `[➕ 新增]` → 进 dialog state |
| `workspace:create:cancel` | dialog `[❌ 取消]` |
| `workspace:exit:confirm` | 状态 C `[📤 退出工作区]` |
| `workspace:config:open` | 状态 C `[⚙ 配置]` |
| `workspace:open` | unbound chat 引导 → 等价 `/workspace` |
| `session:new` | detail card `[🆕 new]` → 等价 `/new` |
| `session:list` | `[📋 list]` → 等价 `/sessions` |
| `session:fork` | `[⋯]` → `[🍴 fork]` |
| `session:rename` | `[⋯]` → `[📝 rename]`(进 dialog state) |
| `session:kill` | `[⋯]` → `[☠ kill]`(confirm 后 stop) |
| `session:export` | `[⋯]` → `[📤 export]` |
| `session:resume:<alias>` | `/sessions` 列表 `[▶ 继续]` |
| `session:details:<alias>` | `/sessions` 列表 `[详情]` |
| `runtime:model:open` | `[⋯]` → `[🔄 model]` 进 picker |
| `runtime:model:set:<id>` | picker 选择某模型 |
| `runtime:mode:open` / `runtime:mode:set:<v>` | mode picker |
| `runtime:think:open` / `runtime:think:set:<v>` | think picker |
| `runtime:perm:open` | perm 编辑入口 |
| `runtime:budget:open` / `runtime:budget:set:<usd>` | budget 设置 |
| `turn:stop` / `turn:stop:idle` | 中断当前 turn(idle 是 no-op) |
| `menu:expand` / `menu:collapse` | detail card `[⋯]` 展开 / 收起 |
| `cost:open` | `[⋯]` → `[💰 cost]` 等价 `/cost` |
| `find:prompt` | `[⋯]` → `[🔍 find]` 提示用户输入 `/find <kw>` |

---

## 7. CLI workspace subcommands

桌面侧通过 `tlive workspace` 直接管理工作区,无需 SSH 改 config + 重启。

```bash
tlive workspace add [<path>] [--name N]
  # path 默认 cwd;name 默认 basename(path)
  # 注意:v1.0 已删除 --admin flag

tlive workspace list
  # NAME       WORKDIR                   BINDINGS
  # tlive      ~/Project/test/tlive      2 chats
  # api        ~/Project/api             0 chats

tlive workspace remove <id|name> [--force] [-y]
  # 默认拒绝删除有绑定的 workspace(提示先 /workspace 退出)
  # --force:强制解绑所有 chat + 删元数据,不删 jsonl;弹 confirm 除非 -y
```

**Wiring**:CLI 通过 IPC socket(`src/ipc/dispatcher.ts`)发命令到运行中的
daemon,即时生效。CLI 是桌面入口;IM 用户通过 `/workspace` `[➕ 新增]` 走
dialog state 完成同样动作。

---

## 8. Onboarding(zero-config first run)

全新用户从空配置到 bound workspace 的完整路径(e2e 覆盖):

| 步 | 操作 | 状态 |
|---|---|---|
| T0 | `npm i -g tlive` | — |
| T1 | `tlive start`(任意目录) | daemon 起 |
| T2 | Telegram 加 bot,发任意消息 | bot 检测 unbound |
| T3 | bot reply: "未绑定工作区,发 /workspace" + `[📁 选工作区]` | unbound 引导 |
| T4 | 用户点 `[📁 选工作区]` 或发 `/workspace` | 进入状态 B |
| T5 | bot 显示 "(系统暂无任何工作区)" + `[➕ 新增工作区]` | — |
| T6 | 用户点 `[➕ 新增工作区]` | 进 dialog state |
| T7 | bot:"请发送项目根目录绝对路径" | `WorkspaceCreateBroker.start()` |
| T8 | 用户发 plain text `/home/y/Project/foo` | inbound dialog 路由捕获 |
| T9 | daemon 验证 path → `createFromIM` 原子动作 | create + bind chat |
| T10 | bot:"✅ 工作区 foo 已创建并关联此 chat" + `[🆕 起会话]` | onboarding done |
| T11 | 用户发 `/new` 或任意 prompt | 正常 session lifecycle |

**整个流程不需要 SSH,不需要改 config**。手机端可独立完成。

---

## 9. v1.0 中删除的功能(35 命令)

47 → 12 收敛清单(spec 草案命令 → v1.0 发布命令)。功能没消失,只是搬家了:

### → 移到 detail card inline keyboard 按钮

`/fork` `/rename` `/kill` `/resume` `/status` `/whoami` `/export` `/bind`
`/archive` `/takeback` `/rewind` `/time-travel`

### → CLI / config / SDK supportedCommands

`/agent` `/skill` `/pipeline` `/schedule` `/handoff` `/handoff-to-me`
`/companion` `/mcp` `/plugins` `/agents` `/models`

### → 多用户管理(parked for v2.0)

`/grant` `/revoke`(legacy multi-user 版;session 级 `/perm` 保留)

### → IM 不暴露(CLI / 高级)

`/attach-last` `/mirror` `/pairings` `/cancel-queued` `/stop-task`
`/prewarm` `/verbose` `/effort`(`/effort` 合进 `/model` 详情)

### → 已删除,不在 v2 roadmap

`/admin` — chat-trust 模型下无需独立 admin 命令

---

## 10. Operator notes

### 10.1 Daemon 单实例锁

v1.0 强制单实例:daemon 启动时在 `~/.tlive/daemon.lock` 上获取排他文件锁
(`tryAcquireDaemonLock`)。若锁已被占用,新进程立即退出并打印 `DAEMON_ALREADY_RUNNING` 错误。

**影响**:
- `tlive start` 在 daemon 已运行时直接幂等(不会起第二个进程)
- `tlive stop` 先发 SIGTERM → 等待 drain → 释放锁;之后可正常 re-start
- lock 文件路径:`~/.tlive/daemon.lock`(相同 `TLIVE_HOME` 配置下共享)

**运维提示**:若进程异常退出留下孤立 lock 文件,`tlive start` 会检测旧 pid
不存活后自动清理并获取锁(stale-lock detection)。

### 10.2 Per-chat session 隔离

每个 IM chat 拥有独立的 `ChatInstance`,各 chat 互不影响。多个 chat 绑定同
一个 workspace 时:

- 各 chat 维护独立 session 生命周期(各自的 `activeSessionId`)
- workspace 默认配置(`model`/`mode` 等)仅在 **新建 session** 时读取,正在运行的
  session 不受 workspace 配置修改的影响
- `lazyResumeOrCreate` 的查询粒度是 ChatInstance,不是 workspace

---

## 11. Per-platform notes

- **Telegram** — autocomplete via `setMyCommands`;forum-group topics 支持
  per-session topic;detail card 用 InlineKeyboardMarkup
- **Feishu** — 无 slash-command menu API;用 `@bot /<cmd>`;detail card 用
  interactive card 的 actions block(同样 4 + 12 按钮布局)
- **Discord** — slash commands 注册在 `applications.{id}.commands.put`;
  thread per session

---

## 12. Reference

- Spec: `docs/superpowers/specs/2026-05-08-chat-instance-design.md`
- Registry: `src/im/commands/index.ts` (`ALL_COMMANDS`)
- Parser: `src/im/command-parser.ts`
- Bot autocomplete: `src/im/bot-commands-registrar.ts`
- Callback router: `src/im/callback-router.ts`
- Lazy resume: `src/workspace/manager.ts` (`lazyResumeOrCreate`) +
  `src/persistence/session.ts` (`hasSnapshot`)
- Workspace dialog: `src/im/workspace-create-broker.ts`
- CLI subcommands: `scripts/cli.js` (workspace add/list/remove)
- Upgrade guide: `docs/upgrade-v1.0.md`

See also [getting-started.md](getting-started.md) for the install + bot
setup walkthrough.
