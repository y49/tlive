# IM Commands Reference (v3.3)

**Spec**: `docs/superpowers/specs/2026-04-30-im-commands-redesign-design.md` (§3-§10)

---

## 1. Overview

tlive v3.3 ships **12 IM slash commands** — a deliberate reduction from the 45
commands in v1.0. The other 35 either moved into inline keyboard buttons,
collapsed into one of the 12, or were parked for v2.0 / CLI-only.

Two mental categories drive the catalog:

- **Workspace-scoped** — touches history / lists resources / picks a workspace.
  Operates on the workspace currently bound to this chat.
- **Session-scoped** — touches the live agent turn (interrupt, model swap,
  permission policy). Requires an active session in the bound workspace.

Inline keyboards are the **primary** interaction path. Slash commands are
entry points; once a card lands in the chat, every follow-up action is one
button tap. This is the design principle: phones don't type.

**Routing & registration**:
- All command handlers live in `src/im/commands/<name>.ts`
- Dispatch by `src/im/command-parser.ts` with role gating
- All 12 commands register for autocomplete via Telegram `setMyCommands`
  (see `src/im/bot-commands-registrar.ts`)
- `ALL_COMMANDS` in `src/im/commands/index.ts` is the canonical list

---

## 2. Command catalog (the 12)

### 2.1 Workspace-scoped (5)

| 命令 | 别名 | 角色 | 行为 |
|---|---|---|---|
| `/new [prompt] [--ephemeral] [--model=…] [--effort=…] [--force]` | — | admin / operator | 在当前 workspace 创建新 session。若已有活跃 session,先弹 confirm 提示替换;`--force` 跳过 confirm。可选 prompt 在 session 起来后立即作为首轮输入发送。 |
| `/sessions [--all] [--page=N]` | — | all | 列当前 ws 的会话(8/页)。`--all` 跨工作区。每条带 `[继续]` `[详情]` 按钮。 |
| `/workspace` | `/ws` | all | **4-state UX 入口**:列 / 切 / 加 / 退。状态自适应,见 §3。 |
| `/cost [today\|week\|month\|total] [--all]` | — | all | 当前 workspace 累计成本(基于 `turn_end` usage)。`--all` 跨工作区汇总。 |
| `/find <keyword>` | `/search` | all | 全文搜索当前 ws 的 jsonl 历史。usage:`/find oauth refactor`。 |

### 2.2 Session-scoped (6)

| 命令 | 别名 | 角色 | 行为 |
|---|---|---|---|
| `/stop` | — | admin / operator | 中断当前 turn(等价终端 Ctrl+C)。session 进程仍存活,jsonl 不动。 |
| `/model [<id>]` | — | admin / operator | 无参显示 picker(SDK `supportedModels` + `[✏ 自定义]`);带参直接切换。`[设为 workspace 默认]` 按钮可持久化为 ws 默认。 |
| `/mode [<mode>]` | — | admin / operator | 权限模式:`default` / `acceptEdits` / `bypassPermissions` / `plan`。无参显示 4-按钮 picker。 |
| `/think [<level>]` | `/thinking` | admin / operator | 思考可见性:`collapsed` / `expanded` / `hidden`。无参显示 picker。 |
| `/perm [list\|allow <p>\|deny <p>\|remove <id>\|clear]` | — | admin / operator | 当前 session 级 allow / deny 规则;无参列规则 + `[+ 添加]` `[清空]` 按钮。 |
| `/budget [<usd>\|unlimited]` | — | admin / operator | **session 级**预算上限(由 `BudgetGuard` 实时拦截)。无参显示状态 + `[$10] [$25] [$50] [无限] [✏ 自定义]` 快捷按钮。 |

### 2.3 Meta (1)

| 命令 | 别名 | 角色 | 行为 |
|---|---|---|---|
| `/help` | `/h`, `/?` | all | 按组列 12 个命令 + inline keyboard 提示(workspace / session / meta 三栏)。 |

### 2.4 Fallback (no active session)

session-scoped 命令(`/stop` `/model` `/mode` `/think` `/perm` `/budget`)
在无活跃 session 时回复:

```
ℹ 当前 workspace 没有活跃 session
[🆕 起会话]   [📋 列会话]
```

workspace-scoped 命令在无 binding 时引导用户进 `/workspace` 流程
(unbound chat 的统一入口)。

---

## 3. `/workspace` 4-state UX

`/workspace` 行为依赖 chat 当前 binding 状态 + user 角色,在 4 个状态间自动切换。

### 3.1 状态 A — 未绑 chat,系统已有 workspace

```
📁 此 chat 还没进入工作区

可用工作区:
[ 📁 tlive ]      [ 📁 api-server ]
[ 📁 blog ]       [ 📁 ml-pipe ]

[ ➕ 新增工作区 ]   [ ⚙ config 教程 ]
```

### 3.2 状态 B — 未绑 chat,系统无 workspace(全新用户)

```
📁 此 chat 还没进入工作区

(系统暂无任何工作区)

[ ➕ 新增工作区 ]   [ ⚙ config 教程 ]
```

### 3.3 状态 C — 已绑 + admin

```
📁 当前工作区: tlive ✓
   📂 ~/Project/test/tlive
   🤖 claude-sonnet-4-6 · default · feat/v1.0-architecture
   📊 6 会话 · 💰 $12.43 累计

切换到:
[ 📁 api-server ]   [ 📁 blog ]   [ 📁 ml-pipe ]

[ ➕ 新增工作区 ]   [ ⚙ 配置 ]   [ 📤 退出工作区 ]
```

### 3.4 状态 D — 已绑 + 非 admin

```
📁 工作区: tlive (只读)
   📂 ~/Project/test/tlive
   你不是该工作区的管理员,无法切换或配置
```

### 3.5 切换工作区(`claude -r` 语义)

用户点 `[📁 X]` 切到另一个 workspace:

1. 读**当前 chat 的** binding.activeSessionId;in-flight 时弹 confirm("切走会中断当前 turn")
2. 当前 session 走 `interrupt() + stop()`(`activeSessionId` 与 jsonl 保留)
3. `removeBinding(currentWs, this chat)` + `addBinding(targetWs, this chat)`
4. 读目标 ws 中**当前 chat 的** binding.activeSessionId:
   - 非 null → **lazy resume**(下条 inbound 触发,见 §5)
   - null → 提示 "已切到 X,暂无活跃会话" + `[🆕 新会话] [📋 全部会话]`

切换后所有 workspace-scoped 命令视图自动跟随新 ws。

### 3.6 每 chat 独立 session(2026-05-07 改)

> **重要**:session 归 chat 所有,不归 workspace 所有。多个 chat 可以
> 绑定同一个 workspace(共享配置),但**各自有独立的 session**,互不
> fan-out。
>
> - 飞书发的消息只在飞书显示,不会镜像到 Telegram(即使两个 chat 都绑
>   到同一个 workspace)
> - chat A 的对话不会泄漏给 chat B
> - 改 `ws.defaults.model` 不影响正在跑的 session,新建 session 才生效
>
> 详见 spec `2026-05-07-isolated-chat-sessions-design.md`。

---

## 4. Inline keyboards (detail card)

每条 assistant 回复的 detail card 末尾自动展示一组按钮。这是 v3.3 的主交互路径。

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

每个二级按钮对应一个 callback,展开为对应 slash 命令的卡片
(详见 §6 callback 表)。

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
有 ws.activeSessionId?
├─ deps.isLive(id)               → sendInput(id, text)         // sent_to_live
├─ deps.hasPersistedSession(id)  → resume(id) + sendInput      // resumed
└─ 兜底                          → createLocal({...})          // created
```

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
| `workspace:switch:<id>` | 状态 C 切换 → §3.5 流程 |
| `workspace:create` | 状态 A/B `[➕ 新增]` → 进 dialog state |
| `workspace:create:cancel` | dialog `[❌ 取消]` |
| `workspace:exit` | 状态 C `[📤 退出工作区]` |
| `workspace:config:open` | 状态 C `[⚙ 配置]` |
| `workspace:open` | unbound chat 引导 → 等价 `/workspace` |
| `session:new` | detail card `[🆕 new]` → 等价 `/new` |
| `session:list` | `[📋 list]` → 等价 `/sessions` |
| `session:fork` | `[⋯]` → `[🍴 fork]` |
| `session:rename` | `[⋯]` → `[📝 rename]`(进 dialog state) |
| `session:kill` | `[⋯]` → `[☠ kill]`(confirm 后 stop) |
| `session:export` | `[⋯]` → `[📤 export]` |
| `session:resume:<id>` | `/sessions` 列表 `[继续]` |
| `session:details:<id>` | `/sessions` 列表 `[详情]` |
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
tlive workspace add [<path>] [--name N] [--admin <userId>]
  # path 默认 cwd;name 默认 basename(path);admin 可在 IM 端 claim

tlive workspace list
  # NAME       WORKDIR                   ADMIN          BINDINGS
  # tlive      ~/Project/test/tlive      y49 (1416..)   tg:1416...
  # api        ~/Project/api             (unclaimed)    0

tlive workspace remove <id|name> [-y]
  # 解绑所有 chat + 删元数据,不删 jsonl;弹 confirm 除非 -y
```

**Wiring**:CLI 通过 IPC socket(`src/ipc/dispatcher.ts`)发命令到运行中的
daemon,即时生效。CLI 是桌面入口;IM 用户通过 `/workspace` `[➕ 新增]` 走
dialog state 完成同样动作。

---

## 8. Onboarding (zero-config first run)

全新用户从空配置到 bound workspace 的完整路径(spec §7,e2e 覆盖):

| 步 | 操作 | 状态 |
|---|---|---|
| T0 | `npm i` / `pip install tlive` | — |
| T1 | `tlive start`(任意目录) | daemon 起 |
| T2 | Telegram 加 bot,发任意消息 | bot 检测 unbound |
| T3 | bot reply: "未绑定工作区,发 /workspace" + `[📁 选工作区]` | unbound 引导 |
| T4 | 用户点 `[📁 选工作区]` 或发 `/workspace` | 进入状态 B |
| T5 | bot 显示 "(系统暂无任何工作区)" + `[➕ 新增工作区]` | — |
| T6 | 用户点 `[➕ 新增工作区]` | 进 dialog state |
| T7 | bot:"请发送项目根目录绝对路径" | `WorkspaceCreateBroker.start()` |
| T8 | 用户发 plain text `/home/y/Project/foo` | inbound dialog 路由捕获 |
| T9 | daemon 验证 path → `createFromIM` 原子动作 | create + claim admin + bind chat |
| T10 | bot:"✅ 工作区 foo 已创建并关联此 chat" + `[🆕 起会话]` | onboarding done |
| T11 | 用户发 `/new` 或任意 prompt | 正常 session lifecycle |

**整个流程不需要 SSH,不需要改 config**。手机端可独立完成。

---

## 9. Removed in v3.3 (35 commands)

47 → 12 收敛清单。功能没消失,只是搬家了:

### → 移到 detail card inline keyboard 按钮

`/fork` `/rename` `/kill` `/resume` `/status` `/whoami` `/export` `/bind`
`/archive` `/takeback` `/rewind` `/time-travel`

### → CLI / config / SDK supportedCommands

`/agent` `/skill` `/pipeline` `/schedule` `/handoff` `/handoff-to-me`
`/companion` `/mcp` `/plugins` `/agents` `/models`

### → 多用户管理(parked for v2.0)

`/grant` `/revoke` `/perm`(legacy multi-user 版,session 级 `/perm` 保留)

### → IM 不暴露(CLI / 高级)

`/attach-last` `/mirror` `/pairings` `/cancel-queued` `/stop-task`
`/prewarm` `/verbose` `/effort`(`/effort` 合进 `/model` 详情)

`/effort` 仅 Codex provider 有意义;并入 `/model` 设置面板。其余动作要么
用桌面 CLI 完成,要么直接走 SDK 默认行为。

---

## 10. Per-platform notes

- **Telegram** — autocomplete via `setMyCommands`;forum-group topics 支持
  per-session topic;detail card 用 InlineKeyboardMarkup
- **Feishu** — 无 slash-command menu API;用 `@bot /<cmd>`;detail card 用
  interactive card 的 actions block(同样 4 + 12 按钮布局)
- **Discord** — slash commands 注册在 `applications.{id}.commands.put`;
  thread per session

---

## 11. Reference

- Spec: `docs/superpowers/specs/2026-04-30-im-commands-redesign-design.md`
- Registry: `src/im/commands/index.ts` (`ALL_COMMANDS`)
- Parser: `src/im/command-parser.ts`
- Bot autocomplete: `src/im/bot-commands-registrar.ts`
- Callback router: `src/im/callback-router.ts`
- Lazy resume: `src/workspace/manager.ts` (`lazyResumeOrCreate`) +
  `src/persistence/session.ts` (`hasSnapshot`)
- Workspace dialog: `src/im/workspace-create-broker.ts`
- CLI subcommands: `scripts/cli.js` (workspace add/list/remove)

See also [getting-started.md](getting-started.md) for the install + bot
setup walkthrough.
