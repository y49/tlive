# 升级到 tlive v1.0

v1.0 是从 v0.x / v1.0-rc 系列的一次大重构,**breaking change**。
schema / 命令 / 模型都不向前兼容,但升级步骤就一条命令清掉旧 state。

## 升级步骤

```bash
# 1. 停所有旧 daemon
pkill -9 -f tlive-daemon.mjs

# 2. 清旧 state(workspaces.json schema v1 → v2 不兼容,
#    daemon.lock/pid/sock 是 runtime 残留)
rm -f ~/.tlive/{workspaces.json,daemon.lock,daemon.pid,daemon.sock,cost-rollups.jsonl}
rm -rf ~/.tlive/sessions

# 3. pull + build + start
cd /path/to/tlive
git pull origin main
npm install
npm run build
tlive start

# 4. 重新注册 workspace
tlive workspace add /path/to/your/project

# 5. 在每个 IM 平台发 /workspace 重新绑定
#    (chat-trust 模型 — 任何 chat 内 user 都能 bind,无 admin 概念)
```

## 主要 breaking change

### 1. ChatInstance 概念

`workspaces.json` 顶层从只有 `workspaces` 字段改为 `workspaces` + `chatInstances`。
每个 `(channelType, chatId)` 对应一个 ChatInstance,持有:
- `activeSessionId` — 该 chat 当前活跃 session 的 id
- `costRollup` — 该 chat 累积成本(`totalUsd` + `sessionCount`)
- `settings`(可选)— 该 chat 的覆盖配置(v2 UI 待加)

**session / cost / history 全 per-chat 独立**。多个 chat 可以绑定同一个
workspace(共享项目配置),但各自持有独立的 ChatInstance,互不影响。

### 2. 移除 RBAC

以下内容**全部删除**,v1.0 不支持,也不在 v2 roadmap:

- admin / operator / observer 三档 role
- `/admin` 命令(本来要加,直接砍)
- 命令定义里的 `role: [...]` 字段(已删)
- `workspaces.json` 中的 `roles` / `defaultRole` / `adminUserId` / `bindings` 嵌套字段
- `binding.role` 字段

**新模型**:bot 拉进哪个 chat,即信任那个 chat 的全部成员。由群管理员决定谁能加入群。

如有团队协作 / 混合可信成员场景,v2 backlog 加 chat 内白名单 + token 验证。

### 3. /cost 范围 flag

| flag | v1.0-rc 行为 | v1.0 行为 |
|---|---|---|
| 无 flag | workspace 累积 | **当前 chat 累积** |
| `--workspace` | 无此 flag | 同 ws 跨 chat 总和(逐 chat 列出) |
| `--all` | 全 ws 汇总 | 所有 ws 全 chat 总和 |

如果你依赖 `/cost` 看 workspace 总费用,改为 `/cost --workspace`。

### 4. /find 范围 flag

| flag | v1.0-rc 行为 | v1.0 行为 |
|---|---|---|
| `/find <kw>` | 搜当前 workspace 历史 | **搜当前 chat 历史** |
| `--workspace` | 无此 flag | 搜同 ws 跨 chat 历史 |
| `--all` | 无此 flag | 搜全局历史 |

### 5. /workspace 3-state(删除 D 态)

v1.0-rc 有 4 个状态:A(未绑+有ws)/ B(未绑+无ws)/ C(已绑+admin)/ D(已绑+非admin)。

v1.0 **删除 D 态**。所有已绑 chat 都看到 C 态(完整管理视图)。chat-trust 下所有成员等价。

### 6. CLI 变化

| 命令 | v1.0-rc | v1.0 |
|---|---|---|
| `tlive workspace add` | 支持 `--admin <userId>` | **删除 `--admin` flag** |
| `tlive workspace remove` | 任何时候都可删 | 有绑定时默认拒绝;加 `--force` 强制 |

## 不再支持

- v1 schema 的 `~/.tlive/workspaces.json` — daemon 启动时 throw + 提示用户 rm
- 同一物理人多 IM 平台 user_id 关联 — 各平台分别 bind(v2 backlog)
- 跨 chat session 迁移 — v2 backlog
- chat 级 settings UI — schema 字段保留,v1 不暴露 UI
- `/admin` 命令 — 已删,无替代

## 遇到问题

请提 issue 至项目 repo,或查看 `tlive daemon-logs -f` + `tlive doctor` 输出。
