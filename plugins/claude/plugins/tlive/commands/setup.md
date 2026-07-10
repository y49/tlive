---
description: AI 引导完成 tlive 配置(IM 通道、启动、验证、Codex 信任)
---

你来引导用户完成 tlive 配置。按顺序执行,每步给用户看结果:

1. 跑 `tlive status`。若命令不存在 → 告诉用户先安装引擎:`npm i -g tlive`,装完重跑本命令。
2. 看输出:daemon 没跑不用管(会话会自动拉起);重点看 channels 是否 `(none)`。
3. 若无通道:问用户要用 Telegram 还是飞书(或都要),按平台收集凭据:
   - Telegram:bot token(@BotFather 创建)+ chat id(给 bot 发消息后从 getUpdates 拿,或用户已知)
   - 飞书:appId + appSecret(开放平台自建应用,开通 im 消息权限)
4. 读取 `~/.tlive/config.json`(可能不存在或已有部分内容),**合并**写入(保留已有字段):
   ```json
   { "allowedSenders": [], "adapters": {
       "telegram": { "token": "<token>", "chatIdAllowList": ["<chatId>"] },
       "feishu": { "appId": "<appId>", "appSecret": "<secret>" } } }
   ```
   (只写用户选的平台;检查 JSON 合法。)
5. `tlive stop`(若在跑)再 `tlive start`,然后 `tlive status` 确认 channels 里出现所配平台。
6. 让用户在 IM 里给 bot 发条消息试试;dashboard 地址用 `tlive url` 给出。
7. 若 status 显示 Codex hooks NOT trusted:先重跑 `tlive setup --hooks-only`(会自动信任);仍不行则让用户在 codex 里输入 `/hooks` approve tlive。
