# tlive v2.0 入門指南

> 本文件為社群維護的繁體中文翻譯，可能落後於英文原文；內容以 [英文原文](getting-started.md) 為準。

本指南帶你從零完成 tlive 設定。結束後，你會有一個執行中的常駐程式、
至少一個已連線的 IM 機器人、在手機上即時監看 Claude Code / Codex 工作階段——
以及（如果你開啟的話）核准也路由到手機。

**v2.0 變更說明：** tlive 不再是 SDK 驅動的 IM 橋接。它已演進為
**廠商中立、自架的 hook 監看/核准層**。常駐程式不持有任何 agent 工作階段；
你自己的 `claude` / `codex` 行程在本機執行，透過 tlive 外掛的 hooks 上報。
它的**預設模式是 `notify`**——只監看 + 通知；遠端核准（扣住工具呼叫，讓你
能從手機作答）是 opt-in，用 `tlive mode full` 開啟。

## 前置條件

- **Node.js 20+** 與 npm（建議 Node 22）。
- 本機已安裝 **Claude Code**。
- **Telegram** 或 **飛書**任一平台的帳號（可以同時啟用兩個）。

## 安裝

```bash
npm install -g tlive
tlive --version
```

## 設定 —— `tlive setup`

```bash
tlive setup
```

精靈會先用偵測到的各家自己的外掛管理器註冊 tlive 外掛（hooks、skill、
`/tlive:*` 指令）——如果 `claude` 和 `codex` 同時在 `PATH` 上，會先問要裝到
哪（`[1] Claude Code [2] Codex [3] 都裝`，預設都裝）。之後才提示填寫 IM
憑證（Telegram bot token + chat ID，或飛書 App 憑證）；這一步完全可跳過——
直接按 Enter 過掉，之後在 Claude Code 或 Codex 裡說「幫我設定 tlive」
（Claude Code 裡也可直接跑 `/tlive:setup`），AI 會互動式帶你設完（Codex
沒有斜線指令，說那句話即可）。你填的內容會寫入（或合併進）：

```text
~/.tlive/config.json
```

Codex 既不需要 hooks 也沒有信任這一步——那整套流程已經退役。它的整合走
app-server 伴隨程式：tlive 連上一個 `codex app-server`，你的 Codex TUI
也連同一個。沒有什麼要核准，也沒有什麼要逐工作階段設定——見 README 的
Codex 一節。

僅重新註冊外掛（例如升級 tlive 後）：

```bash
tlive setup --hooks-only
```

保護設定檔權限：

```bash
chmod 600 ~/.tlive/config.json
```

## 連接機器人

選擇一個平台並照詳細指南做：

- [Telegram](setup-telegram-zh-tw.md) —— 最快，約 5 分鐘
- [飛書 / Lark](setup-feishu-zh-tw.md) —— 約 15 分鐘，需要企業管理員核准

## 啟動常駐程式

```bash
tlive start
tlive status
```

`tlive start` 會印出網頁網址（本機 + 區域網路）**和一個 QR code**——手機掃
一次即可開啟儀表板。`tlive status` 顯示常駐程式執行時間、PID、已設定的
adapter、當前生效的 **`mode:`** 行（預設 `notify`），以及同樣的網址/QR；
它取代了已刪除的 `tlive doctor` 子指令。

## 包裝工作階段（可選但建議）

```bash
cd your-project
tlive run claude
```

`tlive run` 讓同一個工作階段在 hooks-only 之上多出三種能力：

- `/s/<id>` 的**即時網頁終端機**（多裝置；誰打字版面歸誰）以及儀表板上的
  即時預覽卡；
- **IM 引用回覆注入**——回覆這個工作階段的任何 IM 訊息，你的文字就會被打進
  終端機；
- **餵圖片/檔案**——在 IM 傳一張圖（或在網頁上貼上/拖曳，或用儀表板 📎）：
  它會落到 `~/.tlive/inbox`，路徑被打進這個工作階段。

想讓工作階段在你關掉終端機後仍活著？搭配 tmux：
`tmux new -s work tlive run claude`。

---

## 運作方式

你照常在終端機裡跑 `claude`（或 `codex`）；tlive 外掛的 hooks 透過本機 IPC
socket 把每個事件上報給常駐程式。接下來會發生什麼，取決於你的**模式**
（`tlive mode`）：

**`notify`（預設）** —— tlive 只監看 + 通知，絕不扣住工具呼叫：

1. 工具呼叫照常走它們**本機**的權限提示——tlive 把 `PermissionRequest` hook
   短路成透傳，所以不會扣住任何東西，也不會送出去等遠端核准。
2. 當權限提示（或 `AskUserQuestion`）在終端機等你時，tlive 通知**這台機器**：
   桌面通知 + 儀表板上一張唯讀的 *waiting-approval* 卡——因為只有坐在那裡的人
   才能處理它。IM 對這類對話保持安靜（手機觸不到終端機），每個聊天只有第一次
   例外：屆時會收到一張卡解釋原因，並帶一鍵切到 `full` 的按鈕。
3. 工作階段停止或進入閒置時，`Stop` hook 會送一則 IM 通知；回覆一則續跑訊息
   就能讓它繼續。
4. 工具/工作階段失敗會以旁路 `⚠️` 訊息推送。

**`full`**（`tlive mode full`）—— `notify` 的一切，再加上遠端核准：

1. 當 Claude 想呼叫需要核准的工具時，`PermissionRequest` hook 扣住這個決策，
   常駐程式把核准卡送到所有已設定的 IM 聊天——**與本機提示平行**（先答先得）。
2. 你在手機上點 **核准** 或 **拒絕**（或在鍵盤前作答）。
3. hook 把決策回傳給 Claude；Claude 繼續或中止。

**`all`**（`tlive mode all`）—— `full` 的一切，再加上子代理核准：

1. 子代理的工具呼叫也會被扣住、也可遠端作答，和主工作階段的核准完全一樣——
   只有一個代價：Claude Code 是在 hook 回傳**之後**才決定要不要建子代理的本機
   對話框，所以被扣住的子代理在視窗結束前**沒有**終端機提示（逾時，或手機/
   儀表板作答）。沒人守著鍵盤時才用它；`tlive mode full` 會回到把子代理提示
   直接透傳。
2. 無頭執行——`claude -p`，或建在 Agent SDK 上的程式——也會被扣住。它們根本
   沒有終端機對話框，所以在 `full` 下 tlive 交給 Claude Code（`-p` 下直接拒絕，
   或 SDK 主程式自己的權限回呼），而在 `all` 下被扣住的執行會等你作答或等視窗
   結束。

任何東西都絕不會被自動核准或一律拒絕：如果常駐程式連不上、視窗過期、或沒設定
任何聊天，hook 就回落到 `{}`，控制權回到本機終端機，就像 tlive 不存在一樣。

---

## 疑難排解基礎

- **`config not found`** → 跑 `tlive setup`。
- **`daemon unreachable`** → `tlive start`。如果它說「already running」但
  `tlive status` 說沒有，刪掉殘留的 socket：`rm ~/.tlive/daemon.sock` 再試一次。
- **Bot token 看起來沒問題但收不到訊息** → `tlive status` 會對每個平台做即時
  探測（Telegram 用 `getMe`，飛書用 `tenant_access_token`）。
- **權限卡按鈕沒反應** → 用 `tlive logs --follow` 看錯誤。通常是常駐程式重啟前
  留下的過期卡——重送觸發的那則訊息。

## 下一步

- [CLI 指令參考](commands.md)
- 平台設定指南：[Telegram](setup-telegram-zh-tw.md) · [飛書](setup-feishu-zh-tw.md)
- [解除安裝 / 清理 + 從 v0.x/v1 遷移](uninstall.md)
- 回到 [README_ZH_TW.md](../README_ZH_TW.md) 看架構總覽。
