package notify

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNewWeChatNotifierTrimsAndSetsTimeout(t *testing.T) {
	notifier := NewWeChatNotifier("  https://example.test/wechat  ")
	if notifier == nil {
		t.Fatal("expected notifier")
	}
	if notifier.webhookURL != "https://example.test/wechat" {
		t.Fatalf("expected trimmed webhook URL, got %q", notifier.webhookURL)
	}
	if notifier.client == nil {
		t.Fatal("expected HTTP client")
	}
	if notifier.client.Timeout != defaultWeChatHTTPTimeout {
		t.Fatalf("expected timeout %s, got %s", defaultWeChatHTTPTimeout, notifier.client.Timeout)
	}
}

func TestNewWeChatNotifierReturnsNilForEmptyURL(t *testing.T) {
	if notifier := NewWeChatNotifier("   "); notifier != nil {
		t.Fatalf("expected nil notifier for empty URL, got %#v", notifier)
	}
}

func TestWeChatNotifierSendPostsMarkdownPayload(t *testing.T) {
	var captured struct {
		MsgType  string `json:"msgtype"`
		Markdown struct {
			Content string `json:"content"`
		} `json:"markdown"`
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if got := r.Header.Get("Content-Type"); !strings.Contains(got, "application/json") {
			t.Fatalf("expected application/json content type, got %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	notifier := &WeChatNotifier{
		webhookURL: server.URL,
		client:     server.Client(),
	}

	msg := &NotifyMessage{Command: "notification", NotificationType: "permission_prompt", PermissionToolName: "Bash", LastOutput: "approve me"}
	if err := notifier.Send(msg); err != nil {
		t.Fatalf("expected send to succeed, got %v", err)
	}
	if captured.MsgType != "markdown" {
		t.Fatalf("expected markdown msgtype, got %q", captured.MsgType)
	}
	if !strings.Contains(captured.Markdown.Content, "TLive 權限確認") {
		t.Fatalf("expected rendered markdown content, got %q", captured.Markdown.Content)
	}
	if !strings.Contains(captured.Markdown.Content, "approve me") {
		t.Fatalf("expected output excerpt in markdown content, got %q", captured.Markdown.Content)
	}
}

func TestWeChatNotifierSendReturnsErrorOnNonOKStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	notifier := &WeChatNotifier{
		webhookURL: server.URL,
		client:     server.Client(),
	}

	err := notifier.Send(&NotifyMessage{Command: "progress", LastOutput: "hello"})
	if err == nil || !strings.Contains(err.Error(), "status 502") {
		t.Fatalf("expected 502 error, got %v", err)
	}
}

func TestWeChatNotifierSendFallsBackToDefaultClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	notifier := &WeChatNotifier{webhookURL: server.URL}
	if err := notifier.Send(&NotifyMessage{Command: "progress", LastOutput: "hello"}); err != nil {
		t.Fatalf("expected nil-client fallback to succeed, got %v", err)
	}
}

func TestWeChatNotifierSendReturnsTransportError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	client := server.Client()
	server.Close()

	notifier := &WeChatNotifier{
		webhookURL: server.URL,
		client:     client,
	}

	err := notifier.Send(&NotifyMessage{Command: "progress", LastOutput: "hello"})
	if err == nil {
		t.Fatal("expected transport error")
	}
}

func TestWeChatNotifierSendReturnsNilForNilReceiverOrEmptyURL(t *testing.T) {
	var notifier *WeChatNotifier
	if err := notifier.Send(&NotifyMessage{Command: "progress"}); err != nil {
		t.Fatalf("expected nil receiver to no-op, got %v", err)
	}

	notifier = &WeChatNotifier{}
	if err := notifier.Send(&NotifyMessage{Command: "progress"}); err != nil {
		t.Fatalf("expected empty webhook URL to no-op, got %v", err)
	}
}

type fakeNotifier struct {
	calls int
	err   error
}

func (f *fakeNotifier) Send(_ *NotifyMessage) error {
	f.calls++
	return f.err
}

func TestNewMultiNotifierFiltersNil(t *testing.T) {
	one := &fakeNotifier{}
	multi := NewMultiNotifier(nil, one)
	if multi.Len() != 1 {
		t.Fatalf("expected 1 notifier, got %d", multi.Len())
	}
}

func TestMultiNotifierSendReturnsFirstError(t *testing.T) {
	first := &fakeNotifier{err: assertErr("boom")}
	second := &fakeNotifier{}
	multi := NewMultiNotifier(first, second)

	err := multi.Send(&NotifyMessage{Command: "progress", LastOutput: "hello"})
	if err == nil || err.Error() != "boom" {
		t.Fatalf("expected first error boom, got %v", err)
	}
	if first.calls != 1 || second.calls != 1 {
		t.Fatalf("expected both notifiers called once, got %d and %d", first.calls, second.calls)
	}
}

func TestMultiNotifierSendReturnsNilOnNilReceiver(t *testing.T) {
	var multi *MultiNotifier
	if err := multi.Send(&NotifyMessage{Command: "progress"}); err != nil {
		t.Fatalf("expected nil error for nil multi notifier, got %v", err)
	}
}

func TestRenderWeChatContentIncludesStructuredMetadata(t *testing.T) {
	content := renderWeChatContent(&NotifyMessage{
		SessionID:        "sess-123",
		Command:          "stop",
		NotificationType: "finished",
		Pid:              4321,
		Duration:         "2m10s",
		LastOutput:       "line one\nline two",
		WebURL:           "https://example.test/terminal",
		IdleSeconds:      15,
	})

	checks := []string{
		"**TLive 停止通知**",
		"> 類型：`stop`",
		"> 子類型：`finished`",
		"> 會話：`sess-123`",
		"> PID：`4321`",
		"> 持續時間：2m10s",
		"> 空閒：15s",
		"本次執行已停止，以下是結束前保留下來的內容。",
		"如需恢復處理，可重新進入該會話或重新執行命令。",
		"[打開終端](https://example.test/terminal)",
	}
	assertContainsAll(t, content, checks)
}

func TestRenderWeChatContentClassifiesPermissionPrompt(t *testing.T) {
	content := renderWeChatContent(&NotifyMessage{
		Command:            "notification",
		NotificationType:   "permission_prompt",
		PermissionToolName: "Bash",
		LastOutput:         "command wants approval",
	})

	checks := []string{
		"**TLive 權限確認 · Bash**",
		"> 子類型：`permission_prompt`",
		"> 工具：`Bash`",
		"需要你確認工具權限後才能繼續：`Bash`",
		"請先完成權限確認，再繼續後續流程。",
	}
	assertContainsAll(t, content, checks)
}

func TestRenderWeChatContentSelectionRules(t *testing.T) {
	cases := []struct {
		name       string
		msg        *NotifyMessage
		title      string
		label      string
		summary    string
		actionHint string
		wants      []string
		notWants   []string
	}{
		{
			name: "completion_prefers_summary_prefix",
			msg: &NotifyMessage{
				Command:          "notification",
				NotificationType: "completed",
				LastOutput:       "noise line\nSummary: build succeeded\nfinal detail",
			},
			title:      "**TLive 任務完成**",
			label:      "結果摘錄：",
			summary:    "本次執行已完成，重點結果與最後輸出如下。",
			actionHint: "若結果符合預期，可直接進入下一步；若不符，建議先回看輸出細節。",
			wants: []string{
				"Summary: build succeeded",
			},
			notWants: []string{"noise line"},
		},
		{
			name: "completion_falls_back_to_success_line",
			msg: &NotifyMessage{
				Command:          "notification",
				NotificationType: "completed",
				LastOutput:       "booting\nchecking cache\nBuild completed successfully\nartifact: dist/app",
			},
			title:      "**TLive 任務完成**",
			label:      "結果摘錄：",
			summary:    "本次執行已完成，重點結果與最後輸出如下。",
			actionHint: "若結果符合預期，可直接進入下一步；若不符，建議先回看輸出細節。",
			wants: []string{
				"Build completed successfully",
			},
			notWants: []string{"booting"},
		},
		{
			name: "completion_falls_back_to_informative_tail",
			msg: &NotifyMessage{
				Command:          "notification",
				NotificationType: "completed",
				LastOutput:       "booting\nloading modules\nartifact path: dist/app.tar.gz",
			},
			title:      "**TLive 任務完成**",
			label:      "結果摘錄：",
			summary:    "本次執行已完成，重點結果與最後輸出如下。",
			actionHint: "若結果符合預期，可直接進入下一步；若不符，建議先回看輸出細節。",
			wants: []string{
				"artifact path: dist/app.tar.gz",
			},
			notWants: []string{"booting"},
		},
		{
			name: "error_prefers_traceback_context",
			msg: &NotifyMessage{
				Command:          "notification",
				NotificationType: "error",
				LastOutput:       strings.Join([]string{"bootstrap", "setup", "at bootstrap", "Caused by: upstream timeout", "Traceback (most recent call last):", "frame 1", "frame 2", "Error: boom", "cleanup"}, "\n"),
			},
			title:      "**TLive 異常通知**",
			label:      "錯誤上下文：",
			summary:    "執行過程出現異常，以下是最近一次可用輸出。",
			actionHint: "建議優先查看錯誤上下文，再決定是否重試或調整指令。",
			wants: []string{
				"Caused by: upstream timeout",
				"Traceback (most recent call last):",
				"Error: boom",
			},
			notWants: []string{"bootstrap"},
		},
		{
			name: "error_preserves_caused_by_chain",
			msg: &NotifyMessage{
				Command:          "notification",
				NotificationType: "error",
				LastOutput:       strings.Join([]string{"warmup", "Caused by: upstream timeout", "at retryLoop", "Error: request aborted", "cleanup"}, "\n"),
			},
			title:      "**TLive 異常通知**",
			label:      "錯誤上下文：",
			summary:    "執行過程出現異常，以下是最近一次可用輸出。",
			actionHint: "建議優先查看錯誤上下文，再決定是否重試或調整指令。",
			wants: []string{
				"Caused by: upstream timeout",
				"Error: request aborted",
			},
			notWants: []string{"warmup"},
		},
		{
			name: "progress_prefers_latest_semantic_line",
			msg: &NotifyMessage{
				Command:    "progress",
				LastOutput: "step 1\nstep 1\nstep 2\nstep 2\nlatest checkpoint",
			},
			title:      "**TLive 進度通知**",
			label:      "最近輸出：",
			summary:    "執行中有新的進度更新。",
			actionHint: "可打開終端查看完整上下文與最新狀態。",
			wants: []string{
				"latest checkpoint",
			},
			notWants: []string{"step 1", "step 2"},
		},
		{
			name: "progress_drops_bar_and_timing_noise",
			msg: &NotifyMessage{
				Command:    "progress",
				LastOutput: "step 1\n[####----] 40%\nelapsed: 12s\nlatest checkpoint",
			},
			title:      "**TLive 進度通知**",
			label:      "最近輸出：",
			summary:    "執行中有新的進度更新。",
			actionHint: "可打開終端查看完整上下文與最新狀態。",
			wants: []string{
				"latest checkpoint",
			},
			notWants: []string{"[####----] 40%", "elapsed: 12s"},
		},
		{
			name: "progress_prefers_latest_semantic_line_over_percent_line",
			msg: &NotifyMessage{
				Command:    "progress",
				LastOutput: "[42%] download checkpoint ready\nnext step pending",
			},
			title:      "**TLive 進度通知**",
			label:      "最近輸出：",
			summary:    "執行中有新的進度更新。",
			actionHint: "可打開終端查看完整上下文與最新狀態。",
			wants: []string{
				"next step pending",
			},
			notWants: []string{"[42%] download checkpoint ready"},
		},
		{
			name: "progress_keeps_descriptive_percent_when_it_is_only_signal",
			msg: &NotifyMessage{
				Command:    "progress",
				LastOutput: "[42%] download checkpoint ready",
			},
			title:      "**TLive 進度通知**",
			label:      "最近輸出：",
			summary:    "執行中有新的進度更新。",
			actionHint: "可打開終端查看完整上下文與最新狀態。",
			wants: []string{
				"[42%] download checkpoint ready",
			},
		},
		{
			name: "progress_falls_back_to_last_non_empty_noise_line",
			msg: &NotifyMessage{
				Command:    "progress",
				LastOutput: "|\n/\n-\n\\",
			},
			title:      "**TLive 進度通知**",
			label:      "最近輸出：",
			summary:    "執行中有新的進度更新。",
			actionHint: "可打開終端查看完整上下文與最新狀態。",
			wants: []string{
				"\\",
			},
		},
		{
			name: "permission_prompt_keeps_pending_excerpt",
			msg: &NotifyMessage{
				Command:            "notification",
				NotificationType:   "permission_prompt",
				PermissionToolName: "Bash",
				LastOutput:         "command wants approval",
			},
			title:      "**TLive 權限確認 · Bash**",
			label:      "待確認內容：",
			summary:    "需要你確認工具權限後才能繼續：`Bash`",
			actionHint: "請先完成權限確認，再繼續後續流程。",
			wants: []string{
				"command wants approval",
			},
		},
		{
			name: "idle_keeps_recent_tail_excerpt",
			msg: &NotifyMessage{
				Command:          "notification",
				NotificationType: "idle_prompt",
				LastOutput:       strings.Join([]string{"line1", "line2", "line3", "line4", "line5", "line6", "line7", "line8", "line9"}, "\n"),
			},
			title:      "**TLive 等待輸入**",
			label:      "目前停留內容：",
			summary:    "目前執行流程暫停中，正在等待你的下一步輸入。",
			actionHint: "如需繼續，請回到終端或 Web 端輸入下一個指令。",
			wants: []string{
				"line9",
			},
			notWants: []string{"line1"},
		},
		{
			name: "stop_keeps_recent_tail_excerpt",
			msg: &NotifyMessage{
				Command:          "stop",
				NotificationType: "finished",
				LastOutput:       strings.Join([]string{"line1", "line2", "line3", "line4", "line5", "line6", "line7", "line8", "line9"}, "\n"),
			},
			title:      "**TLive 停止通知**",
			label:      "停止前輸出：",
			summary:    "本次執行已停止，以下是結束前保留下來的內容。",
			actionHint: "如需恢復處理，可重新進入該會話或重新執行命令。",
			wants: []string{
				"line8",
				"line9",
			},
			notWants: []string{"line1"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			content := renderWeChatContent(tc.msg)
			if tc.title != "" && !strings.Contains(content, tc.title) {
				t.Fatalf("expected content to contain title %q, got %q", tc.title, content)
			}
			if tc.label != "" && !strings.Contains(content, tc.label) {
				t.Fatalf("expected content to contain label %q, got %q", tc.label, content)
			}
			if tc.summary != "" && !strings.Contains(content, tc.summary) {
				t.Fatalf("expected content to contain summary %q, got %q", tc.summary, content)
			}
			if tc.actionHint != "" && !strings.Contains(content, tc.actionHint) {
				t.Fatalf("expected content to contain action hint %q, got %q", tc.actionHint, content)
			}
			assertContainsAll(t, content, tc.wants)
			assertContainsNone(t, content, tc.notWants)
		})
	}
}

func TestRenderWeChatContentTruncatesAndEscapesCodeFence(t *testing.T) {
	long := strings.Repeat("a", 1300) + "```tail"
	content := renderWeChatContent(&NotifyMessage{Command: "progress", LastOutput: long})

	if !strings.Contains(content, "**TLive 進度通知**") {
		t.Fatalf("expected progress title, got %q", content)
	}
	if strings.Contains(content, "```tail") {
		t.Fatalf("expected embedded code fence to be escaped, got %q", content)
	}
	if !strings.Contains(content, "'''tail") {
		t.Fatalf("expected escaped fence marker, got %q", content)
	}
	if !strings.Contains(content, "…") {
		t.Fatalf("expected truncation marker, got %q", content)
	}
}

func TestRenderWeChatContentHandlesNilMessage(t *testing.T) {
	if got := renderWeChatContent(nil); got != "**TLive 通知**" {
		t.Fatalf("expected default title, got %q", got)
	}
}

func TestRenderWeChatContentPreservesValidUTF8AfterTruncation(t *testing.T) {
	long := strings.Repeat("測", 1300) + "```尾巴"
	content := renderWeChatContent(&NotifyMessage{Command: "progress", LastOutput: long})

	if !utf8.ValidString(content) {
		t.Fatalf("expected valid UTF-8 content, got %q", content)
	}
	if !strings.Contains(content, "…") {
		t.Fatalf("expected truncation marker, got %q", content)
	}
	if strings.Contains(content, "```尾巴") {
		t.Fatalf("expected embedded code fence to be escaped, got %q", content)
	}
	if !strings.Contains(content, "'''尾巴") {
		t.Fatalf("expected escaped fence marker, got %q", content)
	}
}

func assertContainsAll(t *testing.T, content string, wants []string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(content, want) {
			t.Fatalf("expected content to contain %q, got %q", want, content)
		}
	}
}

func assertContainsNone(t *testing.T, content string, notWants []string) {
	t.Helper()
	for _, notWant := range notWants {
		if strings.Contains(content, notWant) {
			t.Fatalf("expected content not to contain %q, got %q", notWant, content)
		}
	}
}

type assertErr string

func (e assertErr) Error() string { return string(e) }
