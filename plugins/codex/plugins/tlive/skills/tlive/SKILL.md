---
name: tlive
description: tlive — IM(Telegram/飞书)审批 + web 终端 + 会话监看,给 Claude Code / Codex 用。
  用于:配置/诊断 tlive、连接 IM 平台、查看会话链接、解释审批/信任行为。
  触发词:"tlive"、"IM 桥"、"手机审批"、"远程终端"、"飞书/Telegram 通知"。
---

# tlive 使用指引

tlive 是自托管的 hook 审批/监看层:你的 claude/codex 会话经全局 hooks 把审批、完成、失败等事件送到 IM(Telegram/飞书)与 web dashboard;IM/网页上可批准/拒绝/回复续跑。daemon 随新会话自动拉起(`daemon.autoStart:false` 关闭)。

## 常用命令
- `tlive setup` — 配置 IM token + 注册 Claude/Codex 插件(hooks 随插件挂载)。`--hooks-only` 只重注册插件。
- `tlive status` — daemon/通道/Codex 信任状态。
- `tlive run <cmd>` — 包装一个进程:本地终端 + web 实时终端(扫码可开)。
- `tlive url` — 打印 dashboard 链接 + 二维码。
- `tlive logs -f` — 跟 daemon 日志。
- `tlive start` / `tlive stop` — 显式起停(通常不需要 start,会话会自动拉起;stop 后新会话会再拉起,除非 autoStart:false)。

## 诊断路径
1. IM 没收到消息:`tlive status` 看通道是否配置;`tlive logs -f` 看发送错误;确认发起会话后 daemon 在跑。
2. Codex hooks 不生效:Codex 对未信任 hook **静默跳过** —— 运行一次交互式 `codex`,在 hooks review 里 approve tlive;`tlive status` 会显示信任态。
3. 审批卡超时:响应窗 600s;超时回落本地终端提示(IM 会收到 ⏳ 提醒),回终端处理即可。
4. web 打不开:`tlive url` 拿当前链接(token 在 URL 里);手机访问需同网段或配置 `web.publicUrl`。

## 安全模型速记
- 绝不自动放行:无人应答 → Claude 回落本地 TUI / Codex 弹原生提示。
- 只读工具(Read/Glob/Grep)默认放行;`/trust on` 临时全放(高危,建议配 allowedSenders)。
- deny 恒赢:用户在 vendor 侧配置的 permissions.deny tlive 不会越过。
