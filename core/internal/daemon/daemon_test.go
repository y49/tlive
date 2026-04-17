package daemon

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/termlive/termlive/core/internal/notify"
)

func TestDaemon_StatusEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "t"})
	handler := d.Handler()

	req := httptest.NewRequest("GET", "/api/status", nil)
	req.Header.Set("Authorization", "Bearer t")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp StatusResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "running" {
		t.Fatalf("expected status 'running', got %q", resp.Status)
	}
}

func TestDaemon_CreateSessionEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	body := `{"command":"echo","args":["hello"],"rows":24,"cols":80}`
	req := httptest.NewRequest("POST", "/api/sessions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp CreateSessionResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.ID == "" {
		t.Fatal("expected non-empty session ID")
	}
	if resp.Command != "echo" {
		t.Errorf("expected command 'echo', got %q", resp.Command)
	}
}

func TestDaemon_UnauthorizedReturnsHTML(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "secret"})
	handler := d.Handler()

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	ct := w.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/html") {
		t.Errorf("expected text/html content type, got %q", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, "<html") {
		t.Error("expected HTML response body")
	}
	if !strings.Contains(body, "token") {
		t.Error("expected token reference in response")
	}
}

func TestDaemon_DeleteSessionEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	// Create a session first
	body := `{"command":"echo","args":["hello"],"rows":24,"cols":80}`
	req := httptest.NewRequest("POST", "/api/sessions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var created CreateSessionResponse
	json.NewDecoder(w.Body).Decode(&created)

	// Delete it
	req = httptest.NewRequest("DELETE", "/api/sessions/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDaemon_ListSessionsEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	// Create a session
	body := `{"command":"echo","args":["hello"],"rows":24,"cols":80}`
	req := httptest.NewRequest("POST", "/api/sessions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var created CreateSessionResponse
	json.NewDecoder(w.Body).Decode(&created)

	// List sessions via GET
	req = httptest.NewRequest("GET", "/api/sessions", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	respBody := w.Body.String()
	if !strings.Contains(respBody, created.ID) {
		t.Errorf("expected session ID %q in list response, got: %s", created.ID, respBody)
	}
	if !strings.Contains(respBody, "echo") {
		t.Errorf("expected command 'echo' in list response, got: %s", respBody)
	}
}

func TestDaemon_StatusVersion(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 9090, Token: "tok"})
	handler := d.Handler()

	req := httptest.NewRequest("GET", "/api/status", nil)
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp StatusResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Version != "0.1.0" {
		t.Errorf("expected version='0.1.0', got %q", resp.Version)
	}
	if resp.Sessions != 0 {
		t.Errorf("expected sessions=0, got %d", resp.Sessions)
	}
}

func TestStripANSI(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"plain text", "hello world", "hello world"},
		{"color codes", "\x1b[38;2;153;153;153mhello\x1b[0m", "hello"},
		{"cursor movement", "\x1b[11;3Hworld", "world"},
		{"mixed", "\x1b[?25l\x1b[2J\x1b[mhello\r\nworld\x1b[?25h", "hello\nworld"},
		{"OSC title", "\x1b]0;My Title\x07text", "text"},
		{"empty", "", ""},
		{"conpty output", "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[Hhello\r\n", "hello\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripANSI(tt.input)
			if got != tt.want {
				t.Errorf("stripANSI(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

type stubNotifier struct {
	err   error
	calls int
	last  *notify.NotifyMessage
}

func (s *stubNotifier) Send(msg *notify.NotifyMessage) error {
	s.calls++
	s.last = msg
	return s.err
}

func TestDaemon_HookNotifyRelaysToNotifiers(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "127.0.0.1"})
	stub := &stubNotifier{}
	d.SetNotifiers(notify.NewMultiNotifier(stub))
	handler := d.Handler()

	req := httptest.NewRequest("POST", "/api/hooks/notify", strings.NewReader(`{"tlive_hook_type":"notification","tlive_session_id":"sess-42","notification_type":"permission_prompt","tool_name":"Bash","idle_seconds":15,"message":"hello"}`))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if stub.calls != 1 {
		t.Fatalf("expected notifier called once, got %d", stub.calls)
	}
	if stub.last == nil || stub.last.Command != "notification" {
		t.Fatalf("expected notification relay message, got %#v", stub.last)
	}
	if stub.last.SessionID != "sess-42" {
		t.Fatalf("expected session id sess-42, got %#v", stub.last)
	}
	if stub.last.NotificationType != "permission_prompt" {
		t.Fatalf("expected notification type permission_prompt, got %#v", stub.last)
	}
	if stub.last.PermissionToolName != "Bash" {
		t.Fatalf("expected permission tool Bash, got %#v", stub.last)
	}
	if stub.last.IdleSeconds != 15 {
		t.Fatalf("expected idle seconds 15, got %#v", stub.last)
	}
	if stub.last.LastOutput != "hello" {
		t.Fatalf("expected extracted message output, got %q", stub.last.LastOutput)
	}
	if !strings.Contains(stub.last.WebURL, "session=sess-42") {
		t.Fatalf("expected web url to include session, got %q", stub.last.WebURL)
	}
}

func TestDaemon_HookNotifyContinuesOnRelayError(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "tok"})
	stub := &stubNotifier{err: errors.New("boom")}
	d.SetNotifiers(notify.NewMultiNotifier(stub))
	handler := d.Handler()

	req := httptest.NewRequest("POST", "/api/hooks/notify", strings.NewReader(`{"tlive_hook_type":"notification","message":"hello"}`))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if stub.calls != 1 {
		t.Fatalf("expected notifier called once, got %d", stub.calls)
	}
}

func TestBuildRelayNotifyMessageUsesSessionContext(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "0.0.0.0"})
	ms, err := d.mgr.CreateSession("echo", []string{"hello"}, SessionConfig{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	ms.Session.AppendOutput([]byte("ansi-free output"))

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"tlive_hook_type":  "stop",
		"tlive_session_id": ms.Session.ID,
	}, []byte(`{"tlive_hook_type":"stop"}`))

	if msg.Command != "stop" {
		t.Fatalf("expected stop command, got %q", msg.Command)
	}
	if msg.SessionID != ms.Session.ID {
		t.Fatalf("expected session id %q, got %q", ms.Session.ID, msg.SessionID)
	}
	if msg.Pid != ms.Session.Pid {
		t.Fatalf("expected pid %d, got %d", ms.Session.Pid, msg.Pid)
	}
	if msg.Duration == "" {
		t.Fatal("expected duration to be populated")
	}
	if msg.LastOutput != string([]byte(`{"tlive_hook_type":"stop"}`)) {
		t.Fatalf("expected raw body to be preserved when no hook output fields exist, got %q", msg.LastOutput)
	}
	if !strings.Contains(msg.WebURL, "127.0.0.1:4590") {
		t.Fatalf("expected localhost web url, got %q", msg.WebURL)
	}
}

func TestBuildRelayNotifyMessageUsesHookOutputWithoutSession(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "127.0.0.1"})

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"tlive_hook_type":  "notification",
		"tlive_session_id": "missing-session",
		"message":          "hook supplied message",
		"idle_seconds":     float64(22),
	}, []byte(`{"tlive_hook_type":"notification"}`))

	if msg.Command != "notification" {
		t.Fatalf("expected notification command, got %q", msg.Command)
	}
	if msg.SessionID != "missing-session" {
		t.Fatalf("expected session id missing-session, got %q", msg.SessionID)
	}
	if msg.LastOutput != "hook supplied message" {
		t.Fatalf("expected hook output, got %q", msg.LastOutput)
	}
	if msg.IdleSeconds != 22 {
		t.Fatalf("expected idle seconds 22, got %d", msg.IdleSeconds)
	}
	if msg.Pid != 0 {
		t.Fatalf("expected no pid without session, got %d", msg.Pid)
	}
	if msg.Duration != "" {
		t.Fatalf("expected empty duration without session, got %q", msg.Duration)
	}
}

func TestBuildRelayNotifyMessagePreservesProvidedWebURL(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "127.0.0.1"})
	ms, err := d.mgr.CreateSession("echo", []string{"hello"}, SessionConfig{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"tlive_hook_type":  "notification",
		"tlive_session_id": ms.Session.ID,
		"web_url":          "https://example.test/custom",
		"summary":          "custom summary",
	}, []byte(`{"tlive_hook_type":"notification"}`))

	if msg.WebURL != "https://example.test/custom" {
		t.Fatalf("expected provided web URL preserved, got %q", msg.WebURL)
	}
	if msg.LastOutput != "custom summary" {
		t.Fatalf("expected summary to be used as output, got %q", msg.LastOutput)
	}
}

func TestBuildRelayNotifyMessagePrefersLastOutputOverMessageAndSummary(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "127.0.0.1"})

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"last_output": "final output",
		"message":     "message output",
		"summary":     "summary output",
	}, []byte(`{"tlive_hook_type":"notification"}`))

	if msg.LastOutput != "final output" {
		t.Fatalf("expected last_output to win, got %q", msg.LastOutput)
	}
}

func TestBuildRelayNotifyMessageIgnoresUnsupportedIdleSecondsType(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "127.0.0.1"})

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"idle_seconds": "22",
	}, []byte(`{"tlive_hook_type":"notification"}`))

	if msg.IdleSeconds != 0 {
		t.Fatalf("expected unsupported idle seconds type to be ignored, got %d", msg.IdleSeconds)
	}
}

func TestHandleHookNotify_NonJSONBodyFallsBackToRawMessage(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "tok"})
	stub := &stubNotifier{}
	d.SetNotifiers(notify.NewMultiNotifier(stub))
	handler := d.Handler()

	body := "plain text notify"
	req := httptest.NewRequest("POST", "/api/hooks/notify", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if stub.calls != 1 {
		t.Fatalf("expected notifier called once, got %d", stub.calls)
	}
	if stub.last == nil {
		t.Fatal("expected relay message")
	}
	if stub.last.Command != string(NotifyProgress) {
		t.Fatalf("expected command %q, got %q", string(NotifyProgress), stub.last.Command)
	}
	if stub.last.LastOutput != body {
		t.Fatalf("expected last output %q, got %q", body, stub.last.LastOutput)
	}
}

func TestBuildRelayNotifyMessage_UsesTextFallbackOutput(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "tok"})

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"tlive_hook_type": "notification",
		"text":            "fallback text value",
	}, []byte(`{"tlive_hook_type":"notification"}`))

	if msg.LastOutput != "fallback text value" {
		t.Fatalf("expected text fallback output, got %q", msg.LastOutput)
	}
}

func TestSessionWebURL_UsesDefaultHostWhenEmpty(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 8080, Token: "tok", Host: ""})
	url := d.sessionWebURL("sess-123")
	want := "http://127.0.0.1:8080/?token=tok&session=sess-123"
	if url != want {
		t.Fatalf("expected %q, got %q", want, url)
	}
}

func TestSessionWebURL_ReturnsEmptyForBlankSessionID(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 8080, Token: "tok", Host: "127.0.0.1"})
	if url := d.sessionWebURL("   "); url != "" {
		t.Fatalf("expected empty url for blank session id, got %q", url)
	}
}

func TestBuildRelayNotifyMessage_TrimsMetadataFields(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "127.0.0.1"})

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"tlive_hook_type":  "notification",
		"notification_type": " permission_prompt ",
		"tool_name":         " Bash ",
		"web_url":           " https://example.test/custom ",
	}, []byte(`{"tlive_hook_type":"notification"}`))

	if msg.NotificationType != "permission_prompt" {
		t.Fatalf("expected trimmed notification type, got %q", msg.NotificationType)
	}
	if msg.PermissionToolName != "Bash" {
		t.Fatalf("expected trimmed tool name, got %q", msg.PermissionToolName)
	}
	if msg.WebURL != "https://example.test/custom" {
		t.Fatalf("expected trimmed web url, got %q", msg.WebURL)
	}
}

func TestReadIntFieldSupportsIntegerTypes(t *testing.T) {
	tests := []struct {
		name string
		data map[string]interface{}
		want int
	}{
		{name: "int", data: map[string]interface{}{"idle_seconds": int(7)}, want: 7},
		{name: "int32", data: map[string]interface{}{"idle_seconds": int32(8)}, want: 8},
		{name: "int64", data: map[string]interface{}{"idle_seconds": int64(9)}, want: 9},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := readIntField(tt.data, "idle_seconds")
			if !ok {
				t.Fatal("expected integer field to be read successfully")
			}
			if got != tt.want {
				t.Fatalf("expected %d, got %d", tt.want, got)
			}
		})
	}
}

func TestReadIntFieldReturnsFalseForMissingKey(t *testing.T) {
	if got, ok := readIntField(map[string]interface{}{}, "idle_seconds"); ok || got != 0 {
		t.Fatalf("expected missing key to return 0, false; got %d, %v", got, ok)
	}
}

func TestPickRelayOutputSkipsBlankValues(t *testing.T) {
	got := pickRelayOutput(map[string]interface{}{
		"last_output": "   ",
		"message":     "\n\t",
		"summary":     " summary wins ",
		"text":        "text fallback",
	})

	if got != "summary wins" {
		t.Fatalf("expected summary fallback after blank values, got %q", got)
	}
}

func TestPickRelayOutputFallsBackToText(t *testing.T) {
	got := pickRelayOutput(map[string]interface{}{
		"last_output": "  ",
		"message":     "\t",
		"summary":     "\n",
		"text":        " text fallback ",
	})

	if got != "text fallback" {
		t.Fatalf("expected text fallback, got %q", got)
	}
}

func TestHandleHookNotify_StopWithoutSessionPreservesRawBody(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "tok"})
	stub := &stubNotifier{}
	d.SetNotifiers(notify.NewMultiNotifier(stub))
	handler := d.Handler()

	body := `{"tlive_hook_type":"stop","tlive_session_id":"missing-session"}`
	req := httptest.NewRequest(http.MethodPost, "/api/hooks/notify", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if stub.calls != 1 {
		t.Fatalf("expected notifier called once, got %d", stub.calls)
	}
	if stub.last == nil {
		t.Fatal("expected relay message")
	}
	if stub.last.Command != "stop" {
		t.Fatalf("expected stop command, got %q", stub.last.Command)
	}
	if stub.last.LastOutput != body {
		t.Fatalf("expected raw body preserved, got %q", stub.last.LastOutput)
	}
}

func TestHandleHookNotify_StopWithSessionEnrichesLastOutput(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 4590, Token: "tok", Host: "127.0.0.1"})
	stub := &stubNotifier{}
	d.SetNotifiers(notify.NewMultiNotifier(stub))
	handler := d.Handler()

	ms, err := d.mgr.CreateSession("echo", []string{"hello"}, SessionConfig{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	ms.Session.AppendOutput([]byte("session-enriched output"))

	body := `{"tlive_hook_type":"stop","tlive_session_id":"` + ms.Session.ID + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/hooks/notify", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if stub.calls != 1 {
		t.Fatalf("expected notifier called once, got %d", stub.calls)
	}
	if stub.last == nil {
		t.Fatal("expected relay message")
	}
	if stub.last.Command != "stop" {
		t.Fatalf("expected stop command, got %q", stub.last.Command)
	}
	if stub.last.LastOutput != "session-enriched output" {
		t.Fatalf("expected enriched last output, got %q", stub.last.LastOutput)
	}
}

func TestHandleHookNotifySucceedsWithoutNotifier(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "tok"})
	handler := d.Handler()

	req := httptest.NewRequest(http.MethodPost, "/api/hooks/notify", strings.NewReader(`{"tlive_hook_type":"notification"}`))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestHandleHookNotifyRejectsNonPOST(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "tok"})
	stub := &stubNotifier{}
	d.SetNotifiers(notify.NewMultiNotifier(stub))
	handler := d.Handler()

	req := httptest.NewRequest(http.MethodGet, "/api/hooks/notify", nil)
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
	if stub.calls != 0 {
		t.Fatalf("expected notifier not called, got %d", stub.calls)
	}
}

func TestBuildRelayNotifyMessage_TrimsHookType(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "tok"})

	msg := d.buildRelayNotifyMessage(map[string]interface{}{
		"tlive_hook_type": " stop ",
	}, []byte(`{"tlive_hook_type":"notification"}`))

	if msg.Command != "stop" {
		t.Fatalf("expected trimmed hook type stop, got %q", msg.Command)
	}
}

func TestSessionWebURL_UsesLoopbackForWildcardHost(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 8080, Token: "tok", Host: "0.0.0.0"})
	url := d.sessionWebURL("sess-123")
	want := "http://127.0.0.1:8080/?token=tok&session=sess-123"
	if url != want {
		t.Fatalf("expected %q, got %q", want, url)
	}
}
