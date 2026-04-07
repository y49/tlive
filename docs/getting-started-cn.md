# tlive 入门指南

本指南将带你从零开始配置 tlive。完成后，你可以在手机上监控终端会话、通过 IM 与 Claude Code 对话，以及远程审批权限请求。

## 前置条件

- **Node.js 18+** 和 npm
- 以下 IM 平台至少其一：**Telegram**、**Discord** 或**飞书**（IM Bridge 和 Hook 审批功能需要）
- 已安装 **Claude Code** 或 **Codex**（IM Bridge 和 Hook 审批功能需要）
- **Web Terminal（网页终端）** 功能可独立使用，不需要 IM 平台

## 安装

```bash
npm install -g tlive
```

验证安装：

```bash
tlive --help
```

**安装过程说明：** npm 会自动下载适合你系统的 Go Core 二进制文件（macOS/Linux，arm64/amd64），并将 hook 脚本复制到 `~/.tlive/bin/`。如果安装时遇到 Go Core 相关错误，请重新运行 `npm install -g tlive`。

## 选择 IM 平台

你可以同时启用多个平台。以下是各平台的快速对比：

| 平台 | 适合场景 | 配置耗时 |
|------|---------|---------|
| **Telegram** | 个人开发者首选，通过 @BotFather 两分钟就能创建机器人 | 约 2 分钟 |
| **Discord** | 团队已经在用 Discord 的场景，需要你有服务器管理权限 | 约 5 分钟 |
| **飞书** | 国内团队首选，配置步骤稍多（需要管理员审批） | 约 15 分钟 |

各平台详细配置指南：

- [Telegram 配置](setup-telegram-cn.md)
- [Discord 配置](setup-discord-cn.md)
- [飞书配置](setup-feishu-cn.md)

## 配置

选择你喜欢的方式。

### 方案 A：AI 引导配置（推荐）

在 Claude Code 中运行：

```
/tlive setup
```

AI 会一步步引导你完成配置——解释每个参数的含义、帮你创建机器人 token，并验证配置是否正确。

### 方案 B：命令行引导

```bash
tlive setup
```

通过交互式命令行引导你选择平台并填写凭证。如果你已经准备好了 bot token，这种方式最快。

### 方案 C：手动配置

直接编辑 `~/.tlive/config.env`。参考 [config.env.example](../config.env.example) 查看所有可用选项。

关键配置项：

```env
# 启用的平台（逗号分隔）
TL_ENABLED_CHANNELS=telegram

# Telegram 示例
TL_TG_BOT_TOKEN=7823456789:AAF-xxxxx
TL_TG_CHAT_ID=123456789

# Web 终端端口和访问令牌
TL_PORT=4590
TL_TOKEN=your-secret-token
```

记得保护配置文件的权限：

```bash
chmod 600 ~/.tlive/config.env
```

### Claude Code 配置加载

`TL_CLAUDE_SETTINGS` 控制加载哪些 Claude Code 配置文件，默认值为 `user`。

| 值 | 加载内容 | 用途 |
|----|---------|------|
| `user` | `~/.claude/settings.json` | 认证、模型、环境变量（如 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`） |
| `project` | `.claude/settings.json` + `CLAUDE.md` | 项目规则、MCP、skills |
| `local` | `.claude/settings.local.json` | 开发者覆盖 |

```env
TL_CLAUDE_SETTINGS=user            # 默认 — 只加载用户配置
TL_CLAUDE_SETTINGS=user,project    # 用户 + 项目配置
TL_CLAUDE_SETTINGS=                # 完全隔离
```

> **提示：** 如果你使用 **ccswitch** 等工具在 `~/.claude/settings.json` 中配置了 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`，默认的 `user` 设置已经会读取，无需额外配置。

## 安装 Claude Code 集成

```bash
tlive install skills
```

这个命令会注册：

- Claude Code 的 `/tlive` 技能
- 权限审批 hook 脚本（`PreToolUse`、`Notification`）
- 任务完成通知处理器

## 试一试

### 功能一：Web 终端

用 `tlive` 包装任意命令，即可获得网页终端：

```bash
tlive echo "Hello from tlive!"
```

打开输出中显示的 URL，你会看到一个实时网页终端。试试实际的工作场景：

```bash
tlive claude --model opus
```

你会得到一个本地 URL 和一个局域网 URL。在手机上打开局域网 URL 就能远程监控会话。

### 功能二：IM Bridge

在 Claude Code 中启动 Bridge：

```
/tlive
```

然后在手机上打开你的 IM 应用，给机器人发一条消息。Claude Code 会接收消息、处理任务，并将响应实时回传到你的手机上——包括工具调用和进度更新。

使用 `/verbose 0|1` 控制消息的详细程度：
- `0` — 仅显示最终结果
- `1` — 终端卡片，显示工具调用 + 结果（默认）

其他常用命令：`/runtime claude|codex`（切换引擎）、`/perm on|off`（权限提示）、`/effort low|high|max`（思考深度）、`/stop`（中断执行）。

### 功能三：Hook 审批

这个功能不需要额外操作——正常使用 Claude Code 就行。当 Claude 需要权限执行某个工具（比如运行 bash 命令）时，你的手机会收到一条通知，带有**允许**和**拒绝**按钮。点击即可响应，Claude 继续工作。

超时未响应时默认操作是**拒绝**，安全第一。

## 故障排除

**运行自动诊断：**

```bash
tlive doctor
```

**查看日志：**

```bash
tlive logs 50
```

**常见问题：**

- **"Go Core not found"** — 二进制文件下载不完整，重新运行 `npm install -g tlive` 即可。
- **"Bridge not starting"** — 检查 `~/.tlive/config.env` 是否存在且凭证有效。运行 `tlive doctor` 查看详情。
- **"No IM messages"** — 确认 bot token 正确，且机器人已加入正确的对话。参考上方各平台的配置指南进行排查。
- **Hook 没有触发** — 确保已运行 `tlive install skills`。用 `tlive hooks` 查看当前 hook 状态。

## 下一步

- **调整详细程度：** `/verbose 1` 显示终端卡片，包含工具调用和结果
- **在电脑前时暂停 hook：** `tlive hooks pause` 自动放行所有请求，不再打扰。`tlive hooks resume` 恢复 IM 审批。
- **手机访问 Web 终端：** 扫描二维码或使用启动会话时打印的局域网 URL
- **多会话支持：** 同时运行多个 `tlive <cmd>`，所有会话集中在一个面板中
- 阅读完整的 [中文文档](../README_CN.md) 了解所有命令和架构详情
