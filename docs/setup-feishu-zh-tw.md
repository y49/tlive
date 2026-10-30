# 飛書 / Lark 設定指南

> 本文件為社群維護的繁體中文翻譯，可能落後於英文原文；內容以 [英文原文](setup-feishu.md) 為準。

[返回入門指南](getting-started-zh-tw.md)

本指南帶你建立飛書（或 Lark）自建應用並接進 tlive。飛書的設定步驟比其他平台
多一些——要建立應用、加權限、訂閱事件、發布版本，還要通過企業管理員核准。
完成後，機器人會送狀態通知——以及，在你開啟遠端核准（`tlive mode full`）
之後、可以在聊天裡作答的核准卡。

**v2.0：** 設定檔是 `~/.tlive/config.json`（JSON）。建議用 `tlive setup`
填入 `adapters.feishu` 區塊並註冊 tlive 外掛。

## 你需要準備

- 一個飛書帳號（國際版用 Lark）。
- 有建立 / 核准自建應用的管理員權限（或找管理員幫忙核准）。
- 約 15 分鐘。

## 步驟 1 —— 建立自建應用

1. 開啟開發者後台：
   - **飛書（中國）：** https://open.feishu.cn/app
   - **Lark（國際）：** https://open.larksuite.com/app
2. 登入。
3. 點 **建立自建應用**。
4. 填寫：
   - **應用名稱** —— 例如「tlive」。
   - **描述** —— 例如「tlive 常駐程式橋接」。
5. 點 **建立**。

## 步驟 2 —— 取得憑證

1. 進入應用的 **憑證與基礎資訊** 頁面。
2. 記下：
   - **App ID** —— 形如 `cli_…`。
   - **App Secret** —— 較長的一串英數字。

App Secret 請妥善保管。

## 步驟 3 —— 批次開通權限

進入 **權限管理**，點 **批次開通**，貼上：

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "im:chat:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ]
  }
}
```

### 權限用途

| 權限範圍 | 作用 |
|---|---|
| `im:message`、`im:message:send_as_bot` | 機器人送出訊息。 |
| `im:message:readonly`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly` | 讀取私聊 / 群聊 @機器人 的訊息。 |
| `im:chat:readonly` | 查詢聊天基礎資訊，用於工作階段綁定。 |
| `cardkit:card:read`、`cardkit:card:write` | 互動式卡片（權限卡、工作階段標頭、活動 sticky、表單卡）。 |
| `im:resource` | 上傳 / 下載附件（使用者上傳的圖片、Claude 產出的檔案）。 |

完整體驗以上全部必需。缺 `cardkit:card:write` 會停用 sticky 的就地編輯，
降級為附加式呈現。

## 步驟 4 —— 設定事件（WebSocket）

在 **事件與回呼**：

1. **事件訂閱** 下點 **新增事件**，加入：
   - `im.message.receive_v1` —— 接收訊息。
   - `card.action.trigger` —— 卡片按鈕點擊。
2. **回呼模式** 選擇 **長連線（WebSocket）**。
   **不要**選 HTTP 回呼；tlive 只用 WebSocket，你不需要公網網址。

> 只支援長連線（WebSocket）：常駐程式從你本機反向連飛書，不需要開防火牆
> 或設 TLS。

## 步驟 5 —— 發布並核准

1. 左側 **版本管理與發布**。
2. **建立版本**：
   - **版本**：`1.0.0`。
   - **更新說明**：簡短即可。
   - **可用範圍**：選指定部門或「全部成員」。
3. 點 **提交審核**。
4. 企業管理員核准：
   - 飛書：https://feishu.cn/admin
   - Lark：https://larksuite.com/admin
   - 在 **應用審核** / **企業應用** 裡找到你的應用，點 **通過**。

如果你自己就是管理員，提交後直接在管理後台自審通過即可。

## 步驟 6 —— 執行 `tlive setup`

```bash
tlive setup
```

提示選擇 channel 時選 **飛書**，依序貼上：

- App ID。
- App Secret。
- Chat ID —— 機器人要送去的目標聊天的 `open_chat_id`（`oc_…`）。

精靈會寫入 `~/.tlive/config.json`：

```json
{
  "adapters": {
    "feishu": {
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "…",
      "chatId": "oc_xxxxxxxxxxxxxxxx"
    }
  },
  "allowedSenders": [{ "channel": "feishu", "userId": "ou_xxxxxxxxxxxxxxxx" }]
}
```

| 欄位 | 型別 | 用途 |
|---|---|---|
| `adapters.feishu.appId` | string | 開發者後台的 App ID。 |
| `adapters.feishu.appSecret` | string | 開發者後台的 App Secret。 |
| `adapters.feishu.chatId` | string | 機器人要送去的目標聊天——它的 `open_chat_id`（以 `oc_` 開頭）。**送出必需。** |
| `allowedSenders` | `{channel, userId}[]` | 可選的按使用者加固 —— Open ID（`ou_…`）。空 ⇒ 信任已設定的聊天。 |

`chatId` **送出必需**，而且來自其他聊天的訊息與按鈕點擊一律被丟棄。取得方式：

- **飛書客戶端 7.60+：** 開啟群組（或你與機器人的私聊）→ 右上角選單 →
  **設定**，裡面就會顯示群組 ID。
- **API 偵錯台：** 任選一個需要群組 ID 的介面，在路徑參數頁點 **選擇群組**，
  選取目標群組，再點 **複製群組 ID**。

tlive 自己沒辦法告訴你這個值：`chatId` 不匹配的訊息在讀取前就被丟棄了。
還沒拿到的話，這一問先留空，拿到後重跑 `tlive setup`（或直接改檔案）填上。

保護設定檔權限：

```bash
chmod 600 ~/.tlive/config.json
```

## 步驟 7 —— 啟動 + 驗證

```bash
tlive start
tlive status
```

飛書探測會呼叫 `auth/v3/tenant_access_token/internal`。回傳 `code: 0` 即憑證
有效。`mode:` 行顯示你的模式（預設 `notify`）。

開啟飛書，搜尋應用名稱——機器人應該出現在 **機器人** / **應用** 分類下。
先私訊它 `/help`，確認能收到回覆。想驗證**核准卡**，先開啟遠端核准
（`tlive mode full`），再觸發一次 Claude 工具呼叫——預設的 `notify` 模式下
不會發卡（工具提示留在本機）。

---

## v2.0 平台說明

- **事件傳輸。** 僅長連線（WebSocket）。不需要公網網址——常駐程式主動向外
  連線飛書。
- **互動卡片結構。** 核准卡使用飛書卡片 schema v2 的 callback 按鈕行為。
- **入站過濾。** adapter 只接受來自已設定 `chatId` 的訊息與卡片按鈕回呼，
  其他聊天一律靜默丟棄（fail-closed）。

## Lark（國際版）

開發者 / 管理後台不同：

- 開發者後台：https://open.larksuite.com/app
- 管理後台：https://larksuite.com/admin

權限範圍、事件名稱、API 形狀，以及 tlive 設定（`appId` / `appSecret` /
`chatId`）完全相同。注意 tlive 目前**不**提供飛書/Lark 端點切換（沒有
`lark`/`domain` 設定欄位）——用的是 `@larksuiteoapi/node-sdk` 的預設值。
若你在 Lark 國際版且連不上，請提 issue。

---

## 疑難排解

- **「應用未審核」/ 飛書裡找不到機器人。** 沒發布版本，或管理員還沒核准。
- **收不到事件。** 你選了 HTTP 回呼，請改回長連線。
- **權限不足。** 某個 scope 是在上次發布之後才加的——建立新版本再核准。
- **「Invalid App ID」/「Invalid App Secret」。** 打錯，或複製到別的應用的
  憑證。
- **飛書裡機器人有回覆但 tlive 日誌什麼也沒有。** `config.json` 漏了
  `adapters.feishu`，或改完設定沒有重新 `tlive start`。

返回 [入門指南](getting-started-zh-tw.md) · [CLI 指令參考](commands.md)。
