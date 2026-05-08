# 升级到 v1.0-rc

v1.0-rc 是大重构(IM 命令重设计 + per-chat 会话隔离 + daemon 互斥锁)。
旧 `~/.tlive/workspaces.json` schema 与 v1.0-rc 不兼容,**升级前必须清理**。

## 升级步骤

### 1. 停掉所有旧 daemon 进程

```bash
# Linux / macOS
pkill -9 -f tlive-daemon.mjs

# Windows(PowerShell):
Get-Process node | Where-Object { $_.CommandLine -match 'tlive-daemon' } | Stop-Process -Force
```

### 2. 清掉旧状态

```bash
rm ~/.tlive/daemon.lock 2>/dev/null
rm ~/.tlive/daemon.pid  2>/dev/null
rm ~/.tlive/daemon.sock 2>/dev/null
rm ~/.tlive/workspaces.json
rm -rf ~/.tlive/sessions
```

### 3. 重新安装 + 启动

```bash
npm install -g tlive@latest
tlive start
tlive workspace add /path/to/your/project
```

### 4. 重新绑定 IM chat

在 IM 里发 `/workspace`,选择刚才 add 的 workspace。

## 主要变化

- **per-chat 会话隔离**:不同 chat 的会话完全独立,飞书的回复不再发到 Telegram。
- **12 个 IM 命令**(原 47 个收敛):`/new /sessions /workspace /cost /find /stop /model /mode /think /perm /budget /help`。
- **daemon 单实例锁**:`tlive start` 第二次会报 "daemon already running",根本起不来第二个进程。
- **飞书原生 reaction**:phase 状态 ✅ done 直接贴在用户消息上,不再发独立"👌"卡片。
- **`binding.role` 字段移除**:权限统一从 `workspace.roles[userId]` 读取,callback 必须携带 userId。
