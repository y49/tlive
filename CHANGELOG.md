# Changelog

All notable changes to this project will be documented in this file.

## [0.7.1](https://github.com/y49/tlive/compare/v0.7.0...v0.7.1) (2026-04-03)


### Bug Fixes

* sync Go core binary version with npm package version ([3878538](https://github.com/y49/tlive/commit/38785381d106fe9ae5b45699bbc5f2392744f3a0))

## [0.7.0](https://github.com/y49/tlive/compare/v0.6.3...v0.7.0) (2026-04-03)


### Features

* **bridge:** AskUserQuestion multi-select, PTY injection & stability fixes ([#19](https://github.com/y49/tlive/issues/19)) ([4f00813](https://github.com/y49/tlive/commit/4f008137c816d565b6763aa07b0d3715bb5eda31))

## [0.6.3](https://github.com/y49/tlive/compare/v0.6.2...v0.6.3) (2026-04-03)


### Bug Fixes

* **bridge:** fix AskUserQuestion handling and add context labels ([725fc4f](https://github.com/y49/tlive/commit/725fc4f4fdbedb9c0a7f7bc704c2695eafc65b86))

## [0.6.2](https://github.com/y49/tlive/compare/v0.6.1...v0.6.2) (2026-04-02)


### Bug Fixes

* **bridge:** auto-allow tool after AskUserQuestion approval ([#15](https://github.com/y49/tlive/issues/15)) ([98e9c6e](https://github.com/y49/tlive/commit/98e9c6e6690b4b921d2fab6495ac890c8c31f045))

## [0.6.1](https://github.com/y49/tlive/compare/v0.6.0...v0.6.1) (2026-04-02)


### Bug Fixes

* **bridge:** keep proxy agents as externals, add to root dependencies ([4463168](https://github.com/y49/tlive/commit/4463168095579abeabf681142b5847e30a98a791))

## [0.6.0](https://github.com/y49/tlive/compare/v0.5.2...v0.6.0) (2026-04-02)


### Features

* add --runtime flag to tlive start, update CLI help with all IM commands ([83341e7](https://github.com/y49/tlive/commit/83341e79d558cce3556e86d1aecc485e4ee1ea26))
* add /model, /settings commands and upgrade Codex provider to SDK types ([223e12b](https://github.com/y49/tlive/commit/223e12bff83a2221e3277b6b2da2c9cae49dc341))
* add /runtime command for per-chat provider switching (claude|codex) ([29c5329](https://github.com/y49/tlive/commit/29c53297f2e98ebfd9872276a002eb811b0df302))
* add /ws/status WebSocket for real-time status updates ([94b8fbe](https://github.com/y49/tlive/commit/94b8fbe4bf10c3489801557191061834ff591196))
* add 250ms conditional tool delay buffer to TerminalCardRenderer ([b85101b](https://github.com/y49/tlive/commit/b85101bb64237f8888eba6e937fdfe4aca99ae85))
* add 60s permission timeout fallback reminder ([4d753fc](https://github.com/y49/tlive/commit/4d753fc70e892f21819cd6f7bb07f70b97d6f832))
* add ANSI stripping utility for terminal output processing ([72f36f5](https://github.com/y49/tlive/commit/72f36f5152028ded47a8b2da39439f633ca0adc0))
* add base channel adapter with self-registration pattern ([6f7c46a](https://github.com/y49/tlive/commit/6f7c46a0fc2ee02a4e45c6f5ce26bc9de1ea576e))
* add Bridge config loader with env file and env var support ([6b5074a](https://github.com/y49/tlive/commit/6b5074a9482a8ca641bbd2112a3bee099ddbd19d))
* add Bridge DI container (BridgeContext) ([840f6ec](https://github.com/y49/tlive/commit/840f6ece8f480036786486bdf2c449f2423a30c3))
* add Bridge logger with secret redaction ([24471fe](https://github.com/y49/tlive/commit/24471fe50532ead7a6727fa7da87e30bb8f38edb))
* add Bridge Manager orchestrator with adapter routing ([1dec890](https://github.com/y49/tlive/commit/1dec890a0c82fb4bf038e384f9e309dbf088120f))
* add bridge registration and heartbeat API endpoints ([67c1b5f](https://github.com/y49/tlive/commit/67c1b5f53b28b4b55f3702f4ea3cc04cf46feaed))
* add Claude Code SKILL.md with setup wizard and subcommands ([ca05eb6](https://github.com/y49/tlive/commit/ca05eb609159950c94d7bf20bbfb78e30ab0b439))
* add Claude SDK provider with CLI fallback ([a4b871a](https://github.com/y49/tlive/commit/a4b871a1d26c42ac597c389b576b0a586290d08d))
* add ClaudeAdapter — SDKMessage to CanonicalEvent mapping with thinking/hidden/subagent support ([1178994](https://github.com/y49/tlive/commit/117899497554b3ac8620c36cf2221e90f3fd9fa8))
* add CLI run command with PTY, WebSocket, and notification wiring ([af43592](https://github.com/y49/tlive/commit/af43592ee82f03c6453459956a9f92358a58d10a))
* add CLI validation, auth errors, env isolation, stderr capture, status file, cleanup debug logs ([37a3c4b](https://github.com/y49/tlive/commit/37a3c4bf5f9a7b9cf5c2aacc369444c1e4911d9e))
* add Codex provider — multi-runtime support via CanonicalEvent adapter ([62a89d6](https://github.com/y49/tlive/commit/62a89d61a35e11ada4d11130f5a5c190643e5f68))
* add Confidence field to NotifyMessage and vary notifier formatting ([652745b](https://github.com/y49/tlive/commit/652745b0ebf2d5e1a209718b60f4442e8f4b6942))
* add config module with TOML loading and defaults ([836fc78](https://github.com/y49/tlive/commit/836fc786651c771972b5a5256102c9c02016723c))
* add conversation engine and channel router ([5be1e5f](https://github.com/y49/tlive/commit/5be1e5ff443f80cab4f2eadca9c04e1fa7ab7a03))
* add CoreClient for Bridge-to-Core HTTP/WS communication ([820afeb](https://github.com/y49/tlive/commit/820afebd7243543c02955428ef3fb4dc9a396171))
* add cross-platform Node.js hook scripts (.mjs) ([5e2bc70](https://github.com/y49/tlive/commit/5e2bc7057f8585373fa4dac68915b01e54e24ec2))
* add delivery layer with chunking, retry, and rate limiting ([ef5d920](https://github.com/y49/tlive/commit/ef5d9203b1f49b81159d09617c163a797c4118eb))
* add Discord channel adapter ([648941f](https://github.com/y49/tlive/commit/648941f5322f15935513b2bd0e5e16a02931a651))
* add Discord embed support and fix interaction acknowledgment ([0bdc33c](https://github.com/y49/tlive/commit/0bdc33c376168df570f033f8714d9cacbbfbdd87))
* add Docker deployment files ([c7f90e2](https://github.com/y49/tlive/commit/c7f90e2fbfe90c1af95b4be8889f232d58e73d45))
* add download progress bar to postinstall binary download ([ab32384](https://github.com/y49/tlive/commit/ab32384b7474626ebd806fc228be3886d7cb7ae7))
* add dual timeout config and custom pattern support ([8b7d24a](https://github.com/y49/tlive/commit/8b7d24ac589b87ad9dcd6dae4ed230c46280adf5))
* add dynamic session whitelist to PermissionCoordinator ([87b4e81](https://github.com/y49/tlive/commit/87b4e8144f7e95ecaeeb3020d5d9f5846c293796))
* add Feishu CardKit native streaming for smoother real-time rendering ([bda623f](https://github.com/y49/tlive/commit/bda623f184e89daf71844fccbdebafc661c2264b))
* add Feishu channel adapter with interactive cards ([e341fdc](https://github.com/y49/tlive/commit/e341fdcdfb088fc6b26bc6470bb95dc35d9b525d))
* add Feishu webhook notifier with interactive card ([3fb96ae](https://github.com/y49/tlive/commit/3fb96aeebb30ac51816322aec562ccaeacc72729))
* add generator framework with Claude Code adapter ([54d3fb8](https://github.com/y49/tlive/commit/54d3fb8fe9a55919c6d102323096056234632a57))
* add git status API endpoint ([b0c09b7](https://github.com/y49/tlive/commit/b0c09b7ea304f1e39e24f57b6ecd01de395e0fc1))
* add hook pause/resume — toggle via CLI (tlive hooks pause/resume) or IM (/hooks pause/resume) ([2c60bc2](https://github.com/y49/tlive/commit/2c60bc21196073a0c80f6e0bf3cbc08c4dd1d478))
* add hooks permission system — local Claude Code → Go Core → IM approval ([5abd06f](https://github.com/y49/tlive/commit/5abd06f17ec6d5f03da339c3ae2053b0b2881b8b))
* add HTTP server with session API and WebSocket handler ([a7efba5](https://github.com/y49/tlive/commit/a7efba59218498cc2c2d255425e60850a2a8a31a))
* add Hub broadcast center with register/unregister/input ([5301c2d](https://github.com/y49/tlive/commit/5301c2d7ea19a88ad87c287c12ad9f8d505a412c))
* add IM permission system, command passthrough, and SDK optimizations ([5645e3f](https://github.com/y49/tlive/commit/5645e3f7a63d09b1d1d250995f7db2e8348f6329))
* add image/media sending support for all platforms ([cb81eb5](https://github.com/y49/tlive/commit/cb81eb557dfe6d5c2e0b7d0a2aba0249961c5183))
* add JSON file store with atomic writes and memory cache ([d789149](https://github.com/y49/tlive/commit/d789149783008fa8d3454aec84002e83fb3dc1ff))
* add JSON-RPC protocol types for daemon IPC ([32c74ba](https://github.com/y49/tlive/commit/32c74ba1efd05f54fdbc9fdb743911bc182af920))
* add LLM provider interface and SSE utilities ([83e6137](https://github.com/y49/tlive/commit/83e613776202417bd7156b38b8d4bc9c7108b316))
* add lock file utilities for shared daemon discovery ([711379a](https://github.com/y49/tlive/commit/711379a0ab8f801a640e877e2397c93118be0c55))
* add Markdown IR rendering for Telegram, Discord, and Feishu ([d5122b5](https://github.com/y49/tlive/commit/d5122b5b5088ad83d85e353f55ed069c2fec3a72))
* add MessageRenderer with compact status line display ([3f7dff2](https://github.com/y49/tlive/commit/3f7dff2dbf10f1263248dc6e84aac45724976b39))
* add NotificationStore for capped notification history ([3bfe9bf](https://github.com/y49/tlive/commit/3bfe9bf9ff5cc018cb62593a36d161969f104d73))
* add notifier interface and WeChat webhook implementation ([f6137c4](https://github.com/y49/tlive/commit/f6137c4680bbf12877f5712d8fd26a012757d70e))
* add npm package config, CLI entry point, and postinstall binary download ([caf88f0](https://github.com/y49/tlive/commit/caf88f0ce754b1258e5a67791b00d03bebaa3991))
* add output classifier for terminal line categorization ([fb9cd6d](https://github.com/y49/tlive/commit/fb9cd6d2410bc1c86bab70658bbec9450853dadd))
* add per-platform styling for stream responses and command output ([f6b5a42](https://github.com/y49/tlive/commit/f6b5a42c93393b95479e1990a802de1069d0627a))
* add permission broker for IM approval cards ([a728895](https://github.com/y49/tlive/commit/a728895690a164101c1a7247610746da4645f4b5))
* add permission gateway with timeout and deny-all ([a0632d8](https://github.com/y49/tlive/commit/a0632d89f520585c0be15bf64e9aba42d2053ce5))
* add platform-aware notification formatter ([71ff608](https://github.com/y49/tlive/commit/71ff608f48bb71aec541c011857bf508da4b11d6))
* add platform-aware permission card formatter ([8aa1105](https://github.com/y49/tlive/commit/8aa1105202511c5c2e24c0ca55ff8ebda2e024e6))
* add preuninstall cleanup, fix postinstall version hoisting bug ([1c9aa34](https://github.com/y49/tlive/commit/1c9aa3437ec7052db4835fa35a1be7ff44b84fff))
* add process management and diagnostics scripts ([e10a866](https://github.com/y49/tlive/commit/e10a8660457e258182bf347ab1857d5beae05c31))
* add proxy support for Telegram and Discord ([8cd7508](https://github.com/y49/tlive/commit/8cd750829939618ffd22482d566f2361d1a4d1a7))
* add proxy utility module with Node and undici agent factories ([93feafd](https://github.com/y49/tlive/commit/93feafd4d6a56e11f13ee120e0661f209324316b))
* add PTY manager with Unix backend and Windows stub ([8acf7ed](https://github.com/y49/tlive/commit/8acf7ed0c64a4f4b8049fb63004a0eb64272d110))
* add reaction-based status indicators (processing/done/error) ([4c1289b](https://github.com/y49/tlive/commit/4c1289b116be9e55cdb4e55f47ada49d71d5021c))
* add real-time status bar to Web UI dashboard ([9295757](https://github.com/y49/tlive/commit/92957571c43b46e85af38291e23f97e1323b1658))
* add scoped token API for secure IM web links ([3625c47](https://github.com/y49/tlive/commit/3625c4743cb9e3de191c5f7ca185c772326ca1db))
* add sensitive content redaction filter — API keys, tokens, passwords, private keys ([e7e347d](https://github.com/y49/tlive/commit/e7e347df5998522c4a4176c5d5ac9b7537e3007c))
* add session create/delete API endpoints on daemon ([eefe396](https://github.com/y49/tlive/commit/eefe3962bb29bccefdbebbeca6de13d9093e53be))
* add session ID to hook scripts, create stop-handler.sh ([47efb70](https://github.com/y49/tlive/commit/47efb706da67685344b29256aaf081d3094ec708))
* add session management with thread-safe store and output buffer ([6d159bd](https://github.com/y49/tlive/commit/6d159bd5d4a6a66d22a05575f9709d1ff7adb607))
* add SessionManager for daemon session lifecycle ([ce2cf50](https://github.com/y49/tlive/commit/ce2cf50442007aef18911b4c268ea81a1c640cd8))
* add SessionMode, ProviderBackend types, and messages module index ([edf2d8a](https://github.com/y49/tlive/commit/edf2d8ae25696c57ebf6ab4503a33fdb4a5dd318))
* add stats API for Bridge token usage reporting ([3487e05](https://github.com/y49/tlive/commit/3487e05854a3c823e36bad2e0247707a921a51eb))
* add status line script, install script, and setup wizard ([c9ba0b9](https://github.com/y49/tlive/commit/c9ba0b9bad537aa6e4a47068d26e035362c2fac7))
* add Telegram channel adapter ([95b18c3](https://github.com/y49/tlive/commit/95b18c3595d193060c5b3a091e4771b32b793fd5))
* add terminal page with xterm.js and WebSocket client ([cc6ac50](https://github.com/y49/tlive/commit/cc6ac5008d2cbc3b72bc696c27e9a31283c4f59e))
* add terminal resize handling via WebSocket control messages ([aed6a07](https://github.com/y49/tlive/commit/aed6a07894cc47976dcdcaa1220a8d60beda34db))
* add TerminalCardRenderer with rolling window and terminal-style rendering ([037e890](https://github.com/y49/tlive/commit/037e890683a5584922ea96f115fe61211c1356c6))
* add token-based authentication for Web UI ([1d10d4b](https://github.com/y49/tlive/commit/1d10d4b8ef34a1478564dfe04095a070ea9898ff))
* add tool registry for terminal card display config ([2afb569](https://github.com/y49/tlive/commit/2afb569d9d97eae7ba192112fd133e5182a51491))
* add typo detection for CLI commands with did-you-mean suggestion ([b0fadf2](https://github.com/y49/tlive/commit/b0fadf2fd442b4f36ff891947f9abf8bd6bb686f))
* add version and update commands ([6e46631](https://github.com/y49/tlive/commit/6e4663155505e2459adec985d1a4ff0c620bf728))
* add Web UI session list page with auto-refresh ([630ac2d](https://github.com/y49/tlive/commit/630ac2da9fa85b5694ac3cd166dabdb7a90eadc0))
* add Windows ConPTY implementation replacing stub ([0e9d84a](https://github.com/y49/tlive/commit/0e9d84a5f193b5d3a6ed13b426c6fa3e2db6fdf1))
* add Zod canonical event schemas with passthrough forward compatibility ([0e80291](https://github.com/y49/tlive/commit/0e802917cef0c77e9c8478120c569f04cd5ad8ac))
* agent tree nesting — subagent tools indented under parent with │├└ connectors ([eb72fcc](https://github.com/y49/tlive/commit/eb72fcc3b4034164ac8f3ea71904e907fb2df8a6))
* AskUserQuestion interactive support in IM ([2f7d15b](https://github.com/y49/tlive/commit/2f7d15bf434d6fe0daa7821221d53b487b940eb5))
* auto-configure hooks in ~/.claude/settings.json on install skills ([b7a1796](https://github.com/y49/tlive/commit/b7a1796eb029504853abec48ee938f47332b6dc1))
* beautiful HTML unauthorized page with token input ([02fab9e](https://github.com/y49/tlive/commit/02fab9ec2a68288126f90ff0f35037d8d12d76ad))
* beautify dashboard with modern dark theme and animations ([03bd7eb](https://github.com/y49/tlive/commit/03bd7ebe39181a9df6149a6cd3c8f71f7ce7a292))
* beautify terminal page with status badges and disconnect overlay ([5beecd4](https://github.com/y49/tlive/commit/5beecd481fdbf47ab63c27b73b462dcc1c9012f3))
* Bridge main entry with config, core client, and graceful shutdown ([6a974cf](https://github.com/y49/tlive/commit/6a974cf221e8cba87b1327c92baca1b08a505da2))
* **bridge:** add CostTracker for usage stats display ([47a26f5](https://github.com/y49/tlive/commit/47a26f52292b807c826af918675b54086f2b2703))
* **bridge:** add Feishu support with WebSocket long connection ([d18d663](https://github.com/y49/tlive/commit/d18d6639f621e53d7ed56cb5b5fc31e8db856cbc))
* **bridge:** add hook reply routing, [Local] prefix, sendHookNotification ([aa432c1](https://github.com/y49/tlive/commit/aa432c18dea72fc5fde42120001081781965b420))
* **bridge:** add sendTyping to adapters, implement Feishu editMessage, add TG error guard ([9312d0a](https://github.com/y49/tlive/commit/9312d0af9f6d78535806f892bfdd9d4b2f43a2ab))
* **bridge:** add StreamController for streaming edit + tool visibility ([7a53ea6](https://github.com/y49/tlive/commit/7a53ea6b4a25cab9bac583225a1e688ca1eda5c4))
* **bridge:** add typed error hierarchy for channel adapters ([81d32ff](https://github.com/y49/tlive/commit/81d32ffc9e99fd2ad3aa7cc8c1fd02ae0c6efa58))
* **bridge:** complete Feishu adapter — webhook events, card callbacks, reply threading ([7427484](https://github.com/y49/tlive/commit/7427484327e0b680a37a95513878ff58a09c2bdc))
* **bridge:** consistent source labels — 🔐 [Local] for hook permissions, 🖥 [Local] for notifications, no prefix for LLM ([2c904c3](https://github.com/y49/tlive/commit/2c904c352f1ddebbefe1c96290c98eb0863e93ef))
* **bridge:** DeliveryLayer uses typed errors for smart retry decisions ([154c9f0](https://github.com/y49/tlive/commit/154c9f00ad931a0fff95e74a5a246071fa418d5a))
* **bridge:** Discord chunked send, reply support, typed errors ([6b82091](https://github.com/y49/tlive/commit/6b82091bbf4d5741f0f2fe7d7071a5940c5172b0))
* **bridge:** fence-aware markdown chunking in delivery layer ([9605b3e](https://github.com/y49/tlive/commit/9605b3e612efaf859f0c24da03ea4b17c30211db))
* **bridge:** file upload support — images (vision) and text files from Telegram + Discord ([508e4b0](https://github.com/y49/tlive/commit/508e4b0b5a1e04851fc1403eaf7b200ea2d28e19))
* **bridge:** implement AskUserQuestion handler for SDK mode ([e6fe683](https://github.com/y49/tlive/commit/e6fe683011bff0be3c12ad339e9e61be55032160))
* **bridge:** improve Telegram HTML rendering + code block truncation ([56c3dbf](https://github.com/y49/tlive/commit/56c3dbf080b337ad41ec42a11d24b9547a20ac1a))
* **bridge:** permission timeout callback for IM feedback ([ad4dad4](https://github.com/y49/tlive/commit/ad4dad4011113e1999fef6a2b2e790e7e473a97d))
* **bridge:** render AskUserQuestion as question card with option buttons in hook mode ([ecbd7e3](https://github.com/y49/tlive/commit/ecbd7e3395ab0cc307227f939eeed996a84dce29))
* **bridge:** render Telegram messages as HTML with proper formatting ([fffb9eb](https://github.com/y49/tlive/commit/fffb9eb09d067903dd9f20dfeb793e8bad4eaaa2))
* **bridge:** support free text replies for AskUserQuestion ([1a7880b](https://github.com/y49/tlive/commit/1a7880b008c04273798c3c608aebcd54bea214b8))
* **bridge:** support numeric text replies for AskUserQuestion options ([2e0f00b](https://github.com/y49/tlive/commit/2e0f00b997ad05795437d79d2e1a1a9732f073e0))
* **bridge:** Telegram chunked send with typed error wrapping ([fbb28b2](https://github.com/y49/tlive/commit/fbb28b21b31d9a4b5867a503533f73764e823108))
* **bridge:** wire notification polling, [Local] prefix on permissions, trackHookMessage ([0eede87](https://github.com/y49/tlive/commit/0eede87e987782993b5f73614c2f42e4fbc40b83))
* **bridge:** wire permission timeout IM notification ([83bbfe8](https://github.com/y49/tlive/commit/83bbfe8e5204dbccee29c9e9f3cad6cb9cd8e373))
* **bridge:** wire streaming edit, typing, session resume, verbose, cost tracking ([052579d](https://github.com/y49/tlive/commit/052579d57820ae1a9517b68511aa3b8b103e54a8))
* **config:** add global TL_PROXY and per-platform proxy overrides ([bc3ccda](https://github.com/y49/tlive/commit/bc3ccdae8021add819b4f061a887ae6513824fec))
* configure npm publishing — postinstall downloads Go binary + copies hook scripts ([ac3832f](https://github.com/y49/tlive/commit/ac3832f1de52f17e8832599a3063c1564a6cba8a))
* copy reference docs to ~/.tlive/docs/ during install ([3f619ae](https://github.com/y49/tlive/commit/3f619aee1554ef64f7df20f78860f02420ed5b0c))
* **core:** add GET /api/hooks/notifications endpoint, fix Bridge notification polling to parse stored JSON ([c1faac6](https://github.com/y49/tlive/commit/c1faac612ab945fba529422a96a785007ff54539))
* **core:** add TLIVE_SESSION_ID env injection + POST /api/sessions/:id/input ([7aa91ff](https://github.com/y49/tlive/commit/7aa91ff05c120f89867c8362d833a79cdf4a291f))
* **core:** extend hook resolution to support updatedInput for AskUserQuestion ([ce4ab2a](https://github.com/y49/tlive/commit/ce4ab2a35b7fa7d4dff3e8036cd80f52e66989d0))
* detect AskUserQuestion in canUseTool and route to dedicated handler ([ea3c1d9](https://github.com/y49/tlive/commit/ea3c1d9e3017cec839b5c9609a619c979f1ebef7))
* **discord:** apply proxy agent to Discord client REST ([a636cf6](https://github.com/y49/tlive/commit/a636cf6e645a438cf785ab65bbe3a2d75bd76272))
* display QR code on startup for mobile access ([a42ee94](https://github.com/y49/tlive/commit/a42ee94312ee09db2931421d302f82a5967d2f30))
* enable Feishu card action buttons for hook permission approval ([cb0ca53](https://github.com/y49/tlive/commit/cb0ca537d3ba4c501a7b658923640133a82dd5ad))
* expand /api/status with bridge, stats, and version info ([bd65524](https://github.com/y49/tlive/commit/bd655247c9953a720bc6122ac3c91c762429d6eb))
* extend config with daemon and notification options ([0434d7e](https://github.com/y49/tlive/commit/0434d7e7c9543362e1cfe23b21395ec2af144bae))
* extract Feishu card builder with header support ([8586a94](https://github.com/y49/tlive/commit/8586a940ea8718d01f2e89d2259cb90cd5ca37b1))
* Feishu Card 2.0 structured elements for notifications (hr, note, separate markdown blocks) ([7b42ddc](https://github.com/y49/tlive/commit/7b42ddcb11bd73262d4ecea380e5fc30cd40dde2))
* Feishu card action buttons via WSClient, hook reply with images ([43ae5e6](https://github.com/y49/tlive/commit/43ae5e66dbe583a1849997dfb9e27f0e27580ab6))
* Feishu schema 2.0 button components with behaviors callback ([b2005c5](https://github.com/y49/tlive/commit/b2005c52352a78802f31f33f59b000113f9848dd))
* forward unknown commands to Go Core for web terminal wrapping ([e91d26e](https://github.com/y49/tlive/commit/e91d26e0a48871dedc510f72056a79ca88e13f4b))
* graduated permission buttons with dynamic session whitelist ([8dbcb46](https://github.com/y49/tlive/commit/8dbcb463b82780339b1cbb70b54d145173d3e893))
* handle long output overflow with chunk splitting ([17622d5](https://github.com/y49/tlive/commit/17622d5020368bb34f2a0caed4493724864f5cdc))
* **hooks:** pass updatedInput from Go Core back to Claude Code ([7b1c6f4](https://github.com/y49/tlive/commit/7b1c6f4181bb7856dfd020dbef987cff9c0be8fa))
* image attachment buffering, merge with text, temp file for Claude SDK ([cf450fd](https://github.com/y49/tlive/commit/cf450fd1e4616bb2bea7a6dc25c9020d80d1c6c7))
* implement setup wizard and install skills in Node.js CLI ([0fb303e](https://github.com/y49/tlive/commit/0fb303e9d2b6effccba6055dc1116f63a732e29f))
* improve help text — grouped CLI commands, clear SKILL.md help, better IM /help ([ecc06ef](https://github.com/y49/tlive/commit/ecc06efa59b9d6ff0c9f687d25a43c9da7ed2884))
* improve setup wizard — update mode, show defaults, mask secrets, better prompts ([30375dc](https://github.com/y49/tlive/commit/30375dcee94bf6e095f0f9952e421b55b3e44912))
* improve SKILL.md with reconfigure, references guides, token validation, troubleshooting ([05f6976](https://github.com/y49/tlive/commit/05f69769d6f4c49cb93cb7b1d86c5bc70f62018d))
* initialize Node.js Bridge project skeleton ([ca47f22](https://github.com/y49/tlive/commit/ca47f22efc4ec858341aa67b211982accb883f7a))
* install stop hook, add replyToMessageId to adapters ([dc52096](https://github.com/y49/tlive/commit/dc52096f77e136ec49122130660679c3e6c91bd3))
* integrate Claude Agent SDK, Telegram IM bidirectional chat working ([ac0cef9](https://github.com/y49/tlive/commit/ac0cef9da3b4b292588e45618798c80841a4066b))
* major Telegram/Discord upgrade — grammY migration, threads, pairing, style overhaul ([73d05b7](https://github.com/y49/tlive/commit/73d05b7d861db26b02ddcdd966daa5cb6a210045))
* make cost tracker pricing configurable via env vars ([672a28d](https://github.com/y49/tlive/commit/672a28d1944d25bd4b6f9f6903c25bcfd179593f))
* message styling overhaul, Feishu Card 2.0, image support, robustness improvements ([01a59a6](https://github.com/y49/tlive/commit/01a59a6b669e9092c0627fb5bde83fda0646151f))
* permission queue for parallel subagent requests ([5af908c](https://github.com/y49/tlive/commit/5af908c98cf0c9aee56eadf603d728d9886a87d2))
* pipe tool_result events to renderer for tool completion display ([acfcd99](https://github.com/y49/tlive/commit/acfcd9999852cb0a59e6e90be800cb6b3c62713c))
* redesign terminal card for IM-native format — emoji+code, 3-space indent, no tree connectors ([33bf62e](https://github.com/y49/tlive/commit/33bf62eeda543839485a6465fd9836cd4c481094))
* relay notifications to WeChat/Feishu channels ([51edce0](https://github.com/y49/tlive/commit/51edce0d94d74584b1b536c543327717b52434db))
* remove Always button from permission cards — use /perm for persistent rules ([65d88f1](https://github.com/y49/tlive/commit/65d88f10f0537c80721d88005dba2aa4ff5a6e97))
* remove verbose level 2 — two levels sufficient for IM ([31dc1e7](https://github.com/y49/tlive/commit/31dc1e719135fe07217d276c9f0e7b79f1f0b338))
* replace IdleDetector with SmartIdleDetector using output classification ([fc9b2e5](https://github.com/y49/tlive/commit/fc9b2e51c1742b8ce083f62029bf44cd90483cc8))
* replace StreamController with TerminalCardRenderer in bridge-manager ([b563a25](https://github.com/y49/tlive/commit/b563a259c5c57dd04d60ca9252b441b1d0e0f9d5))
* restructure CLI as subcommands with init, notify, and daemon ([0db2f2f](https://github.com/y49/tlive/commit/0db2f2f60d7ba4441a001a7849b2fd014d59776a))
* rewrite daemon as HTTP notification hub ([50c375e](https://github.com/y49/tlive/commit/50c375e18bf37c69004475522593cddd43d5f2e5))
* set terminal to raw mode for proper input pass-through ([862163c](https://github.com/y49/tlive/commit/862163cb7f818937c692111aa883d1ec9bf0c12b))
* shared daemon with host/client mode for tlive run ([696538f](https://github.com/y49/tlive/commit/696538ff54578b9a0f39875eac6a1108e8d8fce7))
* show project name and session ID in hook notification title ([bc954cf](https://github.com/y49/tlive/commit/bc954cf8ebda7b195693179750d0ce7f31cbc104))
* **telegram:** apply proxy agent to grammy Bot ([568875e](https://github.com/y49/tlive/commit/568875e3565b55cfca686d139a674faf16e76ee2))
* update permission card to show result after button click ([2e1d521](https://github.com/y49/tlive/commit/2e1d521cec48ce0404e44020bad66677db2dfd29))
* update permission reminder message on resolution ([f4c93d4](https://github.com/y49/tlive/commit/f4c93d4ec83c95f5e425ba4a45392c1c55cb5fe7))
* web terminal redesign — macOS chrome, PTY resize, session CWD, UTF-8 fix ([923a09d](https://github.com/y49/tlive/commit/923a09dddf516a8140a75d560c14b478d501f84d))
* Windows compatibility — replace bash scripts with cross-platform Node.js ([9bf768a](https://github.com/y49/tlive/commit/9bf768a8279c530465805a06ae545f6c0a5b6516))
* wire CanonicalEvent stream through providers, conversation engine, and bridge-manager ([9bfc82c](https://github.com/y49/tlive/commit/9bfc82c104dea6833c30407d00a076fe51db10bb))
* wire formatting templates into broker and bridge-manager ([a5f1261](https://github.com/y49/tlive/commit/a5f12612fd6a0c83b617d97725bb92adb0c6b163))
* wire full mode to use HTTP daemon ([d28ccc5](https://github.com/y49/tlive/commit/d28ccc5617fc189e99b94b8ed239e54e7c23749e))
* wire MessageRenderer into bridge-manager, replace TerminalCardRenderer ([5b49a76](https://github.com/y49/tlive/commit/5b49a76afeffdde0d91b9a20d5095a30d2c98b27))
* wire SmartIdleDetector into CLI with dual timeout flags ([d9c55a6](https://github.com/y49/tlive/commit/d9c55a65afd83f2beb1f39fd7d54f8a10b27e597))
* wrap tool log in code block — monospace rendering for IM platforms ([f27ff5c](https://github.com/y49/tlive/commit/f27ff5c79e43c3b9b50ff1a0cdb19d00f3a2e3b8))


### Bug Fixes

* add --token CLI flag, complete docker-compose env vars, sync config examples ([e720f88](https://github.com/y49/tlive/commit/e720f88eaf0703fad7839c041af5ee9703bb52a8))
* add cookie auth to daemon and filter VPN IPs in LAN detection ([502db27](https://github.com/y49/tlive/commit/502db27cc3adfbeb933ec2aa52549da5bd1f8466))
* add Feishu card header for streaming fallback, log reaction errors ([f4ef92c](https://github.com/y49/tlive/commit/f4ef92ccb6fac814c636d3d951b3bf13cafc9484))
* add robustness improvements (retry, fallbacks, debounce, validation) ([d6a37f8](https://github.com/y49/tlive/commit/d6a37f83956e90c68a5614c92eb2c29899c79b42))
* add runtime dependencies to root package.json ([88511d5](https://github.com/y49/tlive/commit/88511d5dd056dc8c9d676bfc6c5e4e00be970a51))
* add TaskUpdate to HIDDEN_TOOLS, call scheduleFlush on tool start ([ac5b01d](https://github.com/y49/tlive/commit/ac5b01db7f423cdb048791d9bd544ddd708d44ec))
* add text fallback for Feishu card buttons, debug card JSON logging ([524865c](https://github.com/y49/tlive/commit/524865c913783f1205a42f44067efa1e1f9c1e67))
* address code review findings ([6b7d0cc](https://github.com/y49/tlive/commit/6b7d0cc0c84015fc8c0874b63d3ebd439e02d6f7))
* bridge workdir fallback to launch dir, hook links use LAN IP ([3487605](https://github.com/y49/tlive/commit/3487605ed28b6a0a9a2f8cecff36863007704fd9))
* **bridge:** add confirmation feedback for LLM permission callbacks ([b7d67d7](https://github.com/y49/tlive/commit/b7d67d7707261b070ad11aa142f6b0742f143491))
* **bridge:** add session timeout + typing cleanup tests, extract Feishu buildCard, fix pendingFlush costLine loss ([0f940b7](https://github.com/y49/tlive/commit/0f940b7cda674eb5ff1cace6f200d34e5fe74dae))
* **bridge:** address review findings across all platforms ([4cc12f4](https://github.com/y49/tlive/commit/4cc12f4e827ff0de0d87c3e30fbbdf6cbf886810))
* **bridge:** allow text replies to AskUserQuestion during active query ([e504da0](https://github.com/y49/tlive/commit/e504da039c075c24f12afc57664165792a7cd03d))
* **bridge:** auto-allow tools at SDK level, delegate permissions to hook system ([3284857](https://github.com/y49/tlive/commit/3284857d1cfc217f60dcb450a3e53e9eec68b34b))
* **bridge:** auto-rebind session after 30-minute inactivity ([fbe785e](https://github.com/y49/tlive/commit/fbe785e8beda31f4c01b5f3041030ef675a33207))
* **bridge:** bundle proxy agent packages instead of externalizing ([#10](https://github.com/y49/tlive/issues/10)) ([d4201aa](https://github.com/y49/tlive/commit/d4201aabaebf1bdf70899339f59e5049d7ba2cfb))
* **bridge:** Discord button row splitting and review fixes ([932ea9c](https://github.com/y49/tlive/commit/932ea9c48d9f37a18e3559baf5681fbc966cce15))
* **bridge:** Discord reply payload, Feishu error wrapping + file upload + markdown, config.env.example ([01a3ce1](https://github.com/y49/tlive/commit/01a3ce1c976105dab112bf2babb494dfda086faa))
* **bridge:** edit question card on Skip and option selection in SDK mode ([760f87d](https://github.com/y49/tlive/commit/760f87d7584141dd6e29b74e29394ebc6a283abe))
* **bridge:** fix Skip button in hook mode and clear buttons on edit ([f414014](https://github.com/y49/tlive/commit/f414014010378b561b835e211b2f5bd764d0b0a9))
* **bridge:** increase hook notification summary limit from 300 to 3000 chars ([9b8b24e](https://github.com/y49/tlive/commit/9b8b24eeaa72d31fdc1f1bdf00791e9dc55ae9de))
* **bridge:** prevent ambiguous permission resolution in multi-session mode ([b5bec82](https://github.com/y49/tlive/commit/b5bec8289642bd44059d9041f66ed4118fa77c38))
* **bridge:** prevent reply-to-hook from misrouting to Bridge LLM ([dbd6a20](https://github.com/y49/tlive/commit/dbd6a2091b099883d6d2a25387b5194cd4378c82))
* **bridge:** Skip returns allow + empty answers instead of deny ([0590190](https://github.com/y49/tlive/commit/05901904a20782266f7a93e61ca1ba289f5b7ac8))
* **bridge:** skip stale notifications after Bridge restart ([8decabd](https://github.com/y49/tlive/commit/8decabdc91358dc1a3833cd0dd5aa9f4806e0b43))
* **bridge:** swallow sendTyping errors, fix level-0 cost tracking, add parseInt radix ([a8a79c1](https://github.com/y49/tlive/commit/a8a79c12aa70aca8c625c457a21b40987d23e696))
* **bridge:** use English hints for Telegram and Discord ([89f62c4](https://github.com/y49/tlive/commit/89f62c486f4bcf3767e921eb1eb2cb512bb37acb))
* **build:** externalize proxy agent packages in esbuild ([fcc1049](https://github.com/y49/tlive/commit/fcc1049f55e33d4fc3f6c85c077e5147839e32c2))
* **ci:** combine release steps into release-please workflow ([fedaf1b](https://github.com/y49/tlive/commit/fedaf1bfd4948250965d8a48fada6f3d5da76338))
* clean up partial file on Go binary download failure ([ecc5a87](https://github.com/y49/tlive/commit/ecc5a87377e15cbff856c80bafbd953b0ae8664f))
* CLI help/setup routing, PTY size sync for web terminal, SIGWINCH handling ([d8eef66](https://github.com/y49/tlive/commit/d8eef6625fa13e8aafa3ffc0fb4dfe51f3c1cf23))
* cobra flag interception, bridge workdir fallback, docs update ([2c54db2](https://github.com/y49/tlive/commit/2c54db2adaf29ae9a0050975b61e9e73df025b6c))
* config validation at startup + telegram pairing rate limit ([7f36a8c](https://github.com/y49/tlive/commit/7f36a8ce068ed1242fb86af6c1319fc95514763a))
* **core:** extract SIGWINCH handler to platform files for Windows cross-compile ([f5da32d](https://github.com/y49/tlive/commit/f5da32d6b3219df8983382f7c8a48731f77de07f))
* **core:** filter WebSocket control messages in client mode ([45256ad](https://github.com/y49/tlive/commit/45256ad94d151319ffbaf8e5c14b45c0b277287f))
* **core:** show URL, IP and QR code in client mode ([b0ec351](https://github.com/y49/tlive/commit/b0ec351214f7626a35b27794349289f8cf0b0f95))
* create ~/.tlive/ directory before writing hooks-paused file ([ffb343d](https://github.com/y49/tlive/commit/ffb343d51e2f1d441cf8f4b8b22c2f478b3ad42b))
* deduplicate notification title from body content ([d7d779b](https://github.com/y49/tlive/commit/d7d779b29e5c688aafe6cb256998cc4bf44239ed))
* detect and replace empty tlive-core from failed downloads ([5a04c7c](https://github.com/y49/tlive/commit/5a04c7cde25ccf0326319fe311a8f507a7e99909))
* disable Feishu streaming, simplify permission to [Allow] [Deny] ([c61f7b7](https://github.com/y49/tlive/commit/c61f7b706a68a1c1f84c6978b2fa5ccd0afa72d0))
* Dockerfile path, setup-wizard .tlive path, remove dead notify package ([9a883b7](https://github.com/y49/tlive/commit/9a883b7db40e1d937d07867b901ee9f214900010))
* don't edit renderer message on permission callback ([da98f6c](https://github.com/y49/tlive/commit/da98f6c2c36a34c5901f52b0fd14d144e85b1cf5))
* edit original permission card on approval, deduplicate hook clicks ([30e1cde](https://github.com/y49/tlive/commit/30e1cde6b19502670da22c16d93bc4a10558d6fd))
* eliminate SKILL_DIR from SKILL.md, delegate to tlive CLI ([4bf742b](https://github.com/y49/tlive/commit/4bf742b8e567c9c689301de0ea60f664328289a5))
* fail npm install when tlive-core download fails ([6849655](https://github.com/y49/tlive/commit/68496551cc1ba9f1b132ef715164cf04d59728d6))
* Feishu card schema 2.0, Typing reaction, prefer raw markdown over HTML ([e1964b8](https://github.com/y49/tlive/commit/e1964b88514752f09356c2b2c82f2d4c95c24434))
* Feishu image download/upload using openclaw patterns, batch import permissions ([61dcce9](https://github.com/y49/tlive/commit/61dcce9959fc125163ef53e190ad9132b27eef90))
* flaky WebSocket tests — use long-lived process and wait for hub registration ([41b31e2](https://github.com/y49/tlive/commit/41b31e2384d004c72ae5dfe9a686db67b64072a0))
* handle SDK interrupt result gracefully in /stop command ([2e5b376](https://github.com/y49/tlive/commit/2e5b37687cb0b888948fa2bce2dd75fd6360b546))
* hook permission cleanup on fetch failure + merge tiny chunk fragments ([d82e525](https://github.com/y49/tlive/commit/d82e525ff5cd4fc47e3bb427791aebceedba3d32))
* hooks only activate for tlive-managed sessions ([e6d23ad](https://github.com/y49/tlive/commit/e6d23ada9f8d87607248fdd5cfb871d61f9062a8))
* inline permission buttons in terminal card — no separate message ([494ad5f](https://github.com/y49/tlive/commit/494ad5fd7a709ce7ce7cf1dcdef91fb56d906acd))
* let bridge-manager handle overflow chunking, not renderer ([cb332af](https://github.com/y49/tlive/commit/cb332afd8872b3d897ece19c276dfd50f62a3e85))
* mask proxy URL credentials in startup logs ([e16da8d](https://github.com/y49/tlive/commit/e16da8d61e3934cfc4cc6213fc4f567044b27868))
* pass buttons in Telegram editMessage via reply_markup ([7182b6c](https://github.com/y49/tlive/commit/7182b6cb5abfc1692b49b85e942c99fc9a7ccf02))
* postinstall re-downloads Go binary on version upgrade ([50b0f73](https://github.com/y49/tlive/commit/50b0f7370b6f41d30f897cb0ba2ce5fa065e218b))
* preserve permission card content on approval, only remove buttons and update header ([4bc3735](https://github.com/y49/tlive/commit/4bc373520ba05d6936337edbfdd3ed9d045ef36d))
* relax Node engine to &gt;=20.0.0, unify config example ([204fea1](https://github.com/y49/tlive/commit/204fea1befc1f50a0f5b1f46b4a5864a6cf7beac))
* relax Node engine to &gt;=20.0.0, unify config example, fix skill setup ([9518b7d](https://github.com/y49/tlive/commit/9518b7dcdda48c531cd99c8bbf28cb3b50e803bb))
* remove unused buttons parameter from doFlush ([d98ba48](https://github.com/y49/tlive/commit/d98ba4827476ece6bbe3dd1360f2c9663a1ecfd2))
* replace unsupported note tag with grey markdown in Feishu Card 2.0 ([c019c75](https://github.com/y49/tlive/commit/c019c753204f218103d441bcb25dc40140d69473))
* resolve all TypeScript type errors across bridge ([1ee8e4d](https://github.com/y49/tlive/commit/1ee8e4dae0f36759db307b6d2eac2a0f9cb0fddf))
* resolve tsc type errors in stream-controller test and Feishu editMessage ([3182c5d](https://github.com/y49/tlive/commit/3182c5dbe93c80f3317227a2f8eaaa0a076730b8))
* resolve TypeScript type errors across bridge ([9385260](https://github.com/y49/tlive/commit/93852609666b661d68e4fadc852bb18bd6586bae))
* resource cleanup — interval leak, Map pruning, processing timeout, image buffer limits ([c8fe3dc](https://github.com/y49/tlive/commit/c8fe3dce132312ebf3147b9f288eb3b4d5f957cc))
* route GET /api/sessions to session list handler in daemon ([ac57b1d](https://github.com/y49/tlive/commit/ac57b1d86c9b8a6f4405e9f2b5455b6a1ef26d4f))
* route GET /api/sessions to session list handler in daemon ([a92a6e2](https://github.com/y49/tlive/commit/a92a6e259161fdf29ee3e0af8971ea6357da6375))
* set executable permission on CLI and hook scripts ([f5e4ce2](https://github.com/y49/tlive/commit/f5e4ce2dc3e5aaaa061d73c845a4c7e259127c32))
* set TL_TOKEN in bridge-manager tests for CI ([79b0a9d](https://github.com/y49/tlive/commit/79b0a9df4488fcfe14ebb77842b97bce3baad0a3))
* set TL_TOKEN in config and channels tests for CI ([074c592](https://github.com/y49/tlive/commit/074c592cbead6abc8d29177c59eede1bfca6d652))
* show clean tool command in permission, not raw JSON ([a8e8d47](https://github.com/y49/tlive/commit/a8e8d477b8fef705b77962024cc6a3fc12501770))
* show full command in permission prompt, no truncation ([27ffc6c](https://github.com/y49/tlive/commit/27ffc6ce3d533e74bcd87027faa85d0d16de62f8))
* show full response text and stream text during execution ([83f73cb](https://github.com/y49/tlive/commit/83f73cbbb56b804d794b3e07b0817fb30e4216ae))
* skip Feishu streaming when permission buttons needed ([8b9538b](https://github.com/y49/tlive/commit/8b9538b85c5af0e87ab44a35e943b49e9cab9c1c))
* split test token to avoid GitHub push protection ([becc4b2](https://github.com/y49/tlive/commit/becc4b2fed34ff78dfb42e64c8d38094976f03cc))
* strip ANSI escape codes from tool output before sending to IM ([c4dd3b7](https://github.com/y49/tlive/commit/c4dd3b72bc1c1d9546cd0993cad0617cd365501b))
* update channel registry tests for registered adapters ([adee707](https://github.com/y49/tlive/commit/adee7075ea9b5056931ac6dc39a7e6c7949bce08))
* update coreVersion to 0.5.0 ([cdd52fa](https://github.com/y49/tlive/commit/cdd52fac6c7b50df2177f1a62a5c68bd11861808))
* update test assertion for Terminal notification header ([a88b52f](https://github.com/y49/tlive/commit/a88b52ffdc492ef503e0f27da38bffe63599c86e))
* update WebSocket path to /ws/session/ and add token to all frontend requests ([3faeff3](https://github.com/y49/tlive/commit/3faeff3e09c7c2697d5c1182bc4110c7f9310ea5))
* use \r for PTY input, auto-start Bridge on tlive &lt;cmd&gt;, richer Stop notifications with summary + web link ([6e62825](https://github.com/y49/tlive/commit/6e62825efb67562d4b3115970f4c01efb8d70caf))
* use package.json version for Go Core download URL ([c49af66](https://github.com/y49/tlive/commit/c49af66b7eb71efbc4564a91d2383090b543a978))
* web terminal token propagation, responsive layout, and session preview ([4e86a8f](https://github.com/y49/tlive/commit/4e86a8f0242ee7ce065e7abd5a531f8fd149d710))
* **windows:** only wrap non-exe commands with cmd /c in ConPTY ([aa27c8b](https://github.com/y49/tlive/commit/aa27c8b3b29eec1d32a7dd63ace066b25f930011))
* **windows:** QR code ASCII fallback + test compatibility ([205a7e7](https://github.com/y49/tlive/commit/205a7e77909ba4010e29853ed1ecf4f23206c334))
* **windows:** QR code display and SDK path resolution ([d39ff6f](https://github.com/y49/tlive/commit/d39ff6f744478aaddfc23f9ba4b4b659fed972ce))
* **windows:** QR code display, SDK executable resolution, and version check ([ce75d97](https://github.com/y49/tlive/commit/ce75d97fb8e5e7f19f09d8705605602c017c9a7d))
* wire Bridge components, simplify CoreClient to use /api/status, pass config token to daemon ([058919b](https://github.com/y49/tlive/commit/058919b697f200e20cfa98e9e4ac6c40ff78e3af))

## [0.5.2](https://github.com/y49/tlive/compare/v0.5.1...v0.5.2) (2026-04-02)


### Bug Fixes

* **bridge:** bundle proxy agent packages instead of externalizing ([#10](https://github.com/y49/tlive/issues/10)) ([d4201aa](https://github.com/y49/tlive/commit/d4201aabaebf1bdf70899339f59e5049d7ba2cfb))

## [0.4.0] - 2026-03-30

### Added
- `/model <name>` command — switch model per session (works for both Claude and Codex)
- `/settings user|full|isolated` command — control Claude Code settings scope
- `TL_CLAUDE_SETTINGS` config — choose which Claude Code settings files to load (default: `user`)
- `TL_ANTHROPIC_API_KEY` / `OPENAI_API_KEY` support in config.env — non-TL_ vars injected into process.env
- `settingSources` integration — load user's `~/.claude/settings.json` for auth/model config
- Codex provider: effort mapping (`modelReasoningEffort`), env passthrough, auth error detection
- Codex adapter: full SDK type safety (replaced all `any` with SDK types), hidden tools filtering, `web_search`/`todo_list` support
- Codex session continuity — `thread_id` persisted via `query_result` for thread resumption
- Codex resume fallback — auto start new thread if resume fails (cross-provider session switch)
- `/runtime codex` pre-check — rejects switch if SDK not installed
- `/runtime` status shows availability of both providers
- Codex cost display — shows only duration when SDK reports 0 tokens

### Changed
- `/runtime` switch auto-creates new session (prevents cross-provider session ID conflicts)
- `/settings` is provider-aware: Claude shows settings sources, Codex shows current config summary
- Codex SDK loaded via dynamic `import()` (pure ESM compatibility fix)
- `renderDone()` trims response text before separator (prevents missing newline)

## [0.5.0] - 2026-04-03

### Added
- AskUserQuestion interactive support in IM — question cards with option buttons replace raw JSON permission cards
- Three interaction modes: button click, numeric reply, free text input
- Skip button returns allow + empty answers (Claude handles gracefully, no "Permission denied" error)
- Full support for both SDK mode and Hook mode (Go Core)
- Telegram, Discord, Feishu all supported with platform-specific formatting
- Go Core `HookResolution` extended with `updatedInput` for answer passthrough
- Hook handler passes `updatedInput` back to Claude Code
- Discord button row auto-splitting (max 5 per ActionRow)
- `editMessage` clears inline keyboard / buttons on all platforms
- Pending question detection bypasses "previous message still processing" guard

## [Unreleased]

### Added
- Terminal-style card display with rolling tool window, tree connectors, and inline permissions
- Zod-validated canonical event system replacing SSE string pipeline
- Multi-provider support: Codex (OpenAI) via `/runtime codex` command
- Graduated permission buttons: "Allow all edits", "Allow Bash(prefix *)", "Allow {tool}"
- Dynamic session whitelist — approved tools auto-allowed for the session
- 250ms conditional tool delay buffer — prevents fast tool call flicker
- Sensitive content redaction — API keys, tokens, passwords, private keys auto-redacted in IM
- AskUserQuestion support with inline option buttons
- `/runtime`, `/effort`, `/stop` IM commands
- `thinking_delta` event kind — Claude's thinking hidden from IM by default
- Hidden internal tools filtered from display (ToolSearch, TaskCreate, etc.)
- `parentToolUseId` for subagent nesting tracking
- `SessionMode` and `ProviderBackend` types for future multi-provider architecture

### Changed
- `StreamController` replaced by `TerminalCardRenderer` with rolling window
- `sseEvent()`/`parseSSE()` replaced by Zod `CanonicalEvent` typed stream
- `BridgeManager` refactored: extracted `SessionStateManager`, `PermissionCoordinator`, `CommandRouter`
- Permission buttons: Yes/No only → graduated tool-specific options
- Verbose levels: 0/1/2 → 0/1 (quiet / terminal card)

### Removed
- `StreamController` class
- `sse-utils.ts` (SSE string serialization)
- Verbose level 2 (detailed)
- "Always" permission button (use `/perm off` instead)

## [0.2.3] - 2026-03-25

### Changed
- Renamed GitHub repository from `TermLive` to `tlive` for consistency with npm package name

### Fixed
- Detect and replace empty tlive-core from failed downloads
- Use package.json version for Go Core download URL

## [0.2.1] - 2026-03-22

### Fixed
- Fail npm install when tlive-core download fails

### Changed
- Set npm publish access to public
- Use npm trusted publishing with provenance

## [0.2.0] - 2026-03-20

### Added
- **Feishu support** — WebSocket long connection, CardKit v2 interactive cards
- File upload support — images (vision) and text files from Telegram + Discord
- Permission timeout IM notification
- Consistent source labels for hook permissions and notifications
- DeliveryLayer with typed errors for smart retry decisions

### Fixed
- Prevent ambiguous permission resolution in multi-session mode
- Show URL, IP and QR code in client mode
- Skip stale notifications after Bridge restart
- Hooks only activate for tlive-managed sessions
- Prevent reply-to-hook from misrouting to Bridge LLM
- Filter WebSocket control messages in client mode
- Auto-rebind session after 30-minute inactivity
- Windows cross-compile (extract SIGWINCH handler to platform files)

### Changed
- Render Telegram messages as HTML with proper formatting
- Replace `any` types with proper interfaces
- Increase hook notification summary limit from 300 to 3000 chars

## [0.1.0] - 2026-03-15

### Added
- **Web Terminal** — wrap any command with `tlive <cmd>`, multi-session dashboard
- **IM Bridge** — chat with Claude Code from Telegram and Discord
- **Hook Approval** — approve Claude Code permissions from your phone
- Go Core with PTY management, WebSocket, HTTP API
- Node.js Bridge with Agent SDK, streaming responses, cost tracking
- QR code display for mobile access
- Token-based authentication
- Smart idle detection with output classification
- Windows ConPTY support
- Docker Compose support
