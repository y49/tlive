package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
