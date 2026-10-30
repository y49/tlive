# Telegram 設定指南

> 本文件為社群維護的繁體中文翻譯，可能落後於英文原文；內容以 [英文原文](setup-telegram.md) 為準。

[返回入門指南](getting-started-zh-tw.md)

本指南帶你建立一個 Telegram 機器人並接進 tlive。完成後你會有一個可以私訊
（或加進群組）的機器人，用來送狀態通知——以及，在你開啟遠端核准
（`tlive mode full`）之後、可以在聊天裡作答的核准卡。

**v2.0：** 設定檔是 `~/.tlive/config.json`。`tlive setup` 精靈會替你寫入，
並註冊 tlive 外掛（hooks + skill + 指令）。

## 你需要準備

- 一個 Telegram 帳號。
- 約 5 分鐘。
- （可選，想要「每個工作階段一個主題」的體驗）一個**論壇群組**，且你的機器人
  是管理員。

## 步驟 1 —— 用 @BotFather 建立機器人

1. 開啟 Telegram，搜尋 **@BotFather**，送出 `/newbot`。
2. 選一個**顯示名稱**（例如「My tlive bot」）。
3. 選一個**使用者名稱**——必須以 `bot` 結尾（例如 `my_tlive_bot`）。
4. BotFather 會回一組 **bot token**，長得像
   `7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。
5. 複製整組 token。請保密。

建議的 BotFather 設定：

| `/setprivacy` | Disable | 讓機器人能讀群組訊息（群組/論壇用法需要）。 |

> 指令選單的註冊由 tlive 在啟動時透過 `setMyCommands` 自動處理。

## 步驟 2 —— 取得你的 chat ID

tlive 需要知道要綁定哪個聊天。

1. 在 Telegram 裡和你的機器人開始對話，按 **Start**。
2. 送任何一則訊息（例如 `hello`）。
3. 在瀏覽器開啟（把 `YOUR_TOKEN` 換掉）：
   ```text
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
4. 在 JSON 裡找 `"chat":{"id":123456789,...}`——那就是你的 chat ID。
5. **群組/論壇聊天**的 ID 是負數，像 `-1001234567890`。

## 步驟 3 ——（可選）允許的傳送者

預設情況下，tlive 信任任何從允許清單中的聊天傳訊息來的人。想再按*使用者*收緊
（群組聊天時有用），先收集使用者 ID：

1. 搜尋 **@userinfobot** 並送它任何訊息。
2. 它會回你的 Telegram 數字使用者 ID。
3. 在 `allowedSenders` 為每位使用者各加一筆（見步驟 4）。

> 建議：`chatIdAllowList`（哪些聊天）或 `allowedSenders`（哪些使用者）至少
> 設定一個。

## 步驟 4 —— 執行 `tlive setup`

```bash
tlive setup
```

提示選擇 channel 時，選 **Telegram** 並貼上：

- Bot token。
- Chat ID（機器人要送去的目標）。

精靈會把像這樣的區塊寫進 `~/.tlive/config.json`：

```json
{
  "adapters": {
    "telegram": {
      "token": "7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "chatIdAllowList": ["123456789"]
    }
  },
  "allowedSenders": [{ "channel": "telegram", "userId": "123456789" }]
}
```

之後也可以手動編輯這個檔案。

| 欄位 | 型別 | 用途 |
|---|---|---|
| `adapters.telegram.token` | string | 來自 BotFather 的 bot token。 |
| `adapters.telegram.chatIdAllowList` | string[] | 機器人送出、以及接受輸入的 chat ID；其他聊天的入站一律丟棄（fail-closed）。負數 ID = 群組/論壇。 |
| `allowedSenders` | `{channel, userId}[]` | 可選的按使用者加固（步驟 3）。空 ⇒ 信任允許清單中聊天裡的任何人。 |

保護設定檔權限：

```bash
chmod 600 ~/.tlive/config.json
```

## 步驟 5 —— 啟動 + 驗證

```bash
tlive start
tlive status
```

在 `tlive status` 的輸出裡，Telegram 探測會呼叫 `getMe`——那裡出現 ✅ 表示
token 有效、tlive 連得到 API。`mode:` 行顯示你的模式（預設 `notify`）。

接著從已設定的 Telegram 聊天確認來回：私訊機器人 `/help`，看它有沒有回。
想驗證**核准卡**，先開啟遠端核准（`tlive mode full`），再觸發一次 Claude 工具
呼叫——預設的 `notify` 模式不會發卡（工具提示留在本機）。

---

## v2.0 平台說明

- **傳輸。** 長輪詢（不需要公網網址、webhook 或 TLS 設定——常駐程式主動向外
  連 Telegram）。
- **行內鍵盤。** 用於核准卡按鈕（核准 / 拒絕）。
- **入站過濾。** adapter 只接受來自 `chatIdAllowList` 中聊天的訊息與按鈕回呼。
  其他聊天一律靜默丟棄（fail-closed）。

---

## 疑難排解

- **機器人私訊會回、群組不回。** 用 BotFather 關掉隱私模式
  （`/setprivacy` → 你的機器人 → Disable），並確認群組 ID 在
  `chatIdAllowList` 裡。
- **啟動時「Unauthorized」。** token 被重新產生了——複製目前的那一組。
- **`getUpdates` 回應是空的。** 先送一則訊息給機器人，再重新整理。
- **權限卡按鈕點了沒反應。** 遠端核准是 opt-in，預設的 `notify` 模式從不扣住
  核准——所以根本沒有卡可以答。用 `tlive mode full` 切換。如果卡有出現但按鈕
  沒落地，用 `tlive status` 確認常駐程式活著，再看 `tlive logs`。

返回 [入門指南](getting-started-zh-tw.md) · [CLI 指令參考](commands.md)。
