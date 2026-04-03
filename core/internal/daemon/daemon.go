package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// DaemonConfig holds configuration for the daemon HTTP server.
type DaemonConfig struct {
	Port         int
	Token        string
	Host         string // default "0.0.0.0"
	HistoryLimit int
}

// Daemon is the TermLive session hub. It manages PTY sessions and exposes
// them via HTTP API and WebSocket.
type Daemon struct {
	cfg           DaemonConfig
	mgr           *SessionManager
	notifications *NotificationStore
	hooks         *HookManager
	token         string
	host          string
	startTime     time.Time
	server        *http.Server
	extraHandler  http.Handler
	mu            sync.Mutex
}

// NewDaemon creates a new Daemon with the given config.
func NewDaemon(cfg DaemonConfig) *Daemon {
	token := cfg.Token
	if token == "" {
		b := make([]byte, 16)
		rand.Read(b)
		token = hex.EncodeToString(b)
	}
	historyLimit := cfg.HistoryLimit
	if historyLimit <= 0 {
		historyLimit = 100
	}
	host := cfg.Host
	if host == "" {
		host = "127.0.0.1"
	}
	return &Daemon{
		cfg:           cfg,
		mgr:           NewSessionManager(),
		notifications: NewNotificationStore(historyLimit),
		hooks:         NewHookManager(),
		token:         token,
		host:          host,
		startTime:     time.Now(),
	}
}

// Manager returns the session manager (used by full mode for PTY sessions).
func (d *Daemon) Manager() *SessionManager { return d.mgr }

// Token returns the authentication token.
func (d *Daemon) Token() string { return d.token }

// Notifications returns the notification store (for direct internal use).
func (d *Daemon) Notifications() *NotificationStore { return d.notifications }

// SetExtraHandler sets an additional HTTP handler that serves routes
// not handled by the daemon's own API (e.g., Web UI, WebSocket).
// Must be called before Run() or Handler().
func (d *Daemon) SetExtraHandler(h http.Handler) {
	d.extraHandler = h
}

// --- HTTP API types ---

// StatusResponse is the JSON response for GET /api/status.
type StatusResponse struct {
	Status   string `json:"status"`
	Uptime   int64  `json:"uptime"`
	Port     int    `json:"port"`
	Sessions int    `json:"sessions"`
	Version  string `json:"version"`
}

// --- Session management API types ---

// CreateSessionRequest is the JSON body for POST /api/sessions.
type CreateSessionRequest struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Rows    uint16   `json:"rows"`
	Cols    uint16   `json:"cols"`
}

// CreateSessionResponse is the JSON response for POST /api/sessions.
type CreateSessionResponse struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	Pid     int    `json:"pid"`
}

// DeleteSessionResponse is the JSON response for DELETE /api/sessions/{id}.
type DeleteSessionResponse struct {
	OK bool `json:"ok"`
}

// Handler returns the HTTP handler for the daemon API.
// Separated from Run() so it can be tested with httptest.
func (d *Daemon) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", d.handleStatus)
	mux.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
		if strings.HasSuffix(path, "/input") && r.Method == http.MethodPost {
			d.handleSessionInput(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			d.handleDeleteSession(w, r)
			return
		}
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})
	mux.HandleFunc("/api/sessions", d.handleSessions)
	mux.HandleFunc("/api/hooks/permission/", d.handleHookPermissionResolve)
	mux.HandleFunc("/api/hooks/permission", d.handleHookPermission)
	mux.HandleFunc("/api/hooks/pending", d.handleHooksPending)
	mux.HandleFunc("/api/hooks/notify", d.handleHookNotify)
	mux.HandleFunc("/api/hooks/notifications", d.handleHookNotifications)
	if d.extraHandler != nil {
		mux.Handle("/", d.extraHandler)
	}
	return d.authMiddleware(mux)
}

// Run starts the HTTP server and blocks until Stop is called.
func (d *Daemon) Run() error {
	addr := fmt.Sprintf("%s:%d", d.host, d.cfg.Port)
	d.mu.Lock()
	d.server = &http.Server{Addr: addr, Handler: d.Handler()}
	d.mu.Unlock()
	log.Printf("TLive daemon listening on %s", addr)
	if err := d.server.ListenAndServe(); err != http.ErrServerClosed {
		return err
	}
	return nil
}

// Stop gracefully shuts down the daemon HTTP server.
func (d *Daemon) Stop() error {
	d.mu.Lock()
	srv := d.server
	d.mu.Unlock()
	if srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}

// StartIdleWatcher starts a background goroutine that auto-shuts down the
// daemon after 15 minutes of inactivity (no active sessions).
func (d *Daemon) StartIdleWatcher() {
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		var idleSince time.Time
		for range ticker.C {
			if d.mgr.ActiveCount() == 0 {
				if idleSince.IsZero() {
					idleSince = time.Now()
				} else if time.Since(idleSince) > 15*time.Minute {
					log.Println("Daemon idle for 15 minutes, auto-shutting down")
					d.Stop()
					return
				}
			} else {
				idleSince = time.Time{} // reset
			}
		}
	}()
}

// --- Handlers ---

func (d *Daemon) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sessions := d.mgr.ListSessions()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(StatusResponse{
		Status:   "running",
		Uptime:   int64(time.Since(d.startTime).Seconds()),
		Port:     d.cfg.Port,
		Sessions: len(sessions),
		Version:  "0.1.0",
	})
}

func (d *Daemon) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		d.handleListSessions(w, r)
	case http.MethodPost:
		d.handleCreateSession(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ansiRegex matches ANSI CSI sequences (colors, cursor movement, etc.),
// OSC sequences (title, hyperlinks), and other common escape codes.
var ansiRegex = regexp.MustCompile(`\x1b\[[0-9;?<>=!]*[a-zA-Z@~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[=>]|\r`)

// stripANSI removes ANSI escape sequences and control characters from
// terminal output, leaving only printable text suitable for display in HTML.
func stripANSI(s string) string {
	s = ansiRegex.ReplaceAllString(s, "")
	// Remove remaining non-printable control chars (keep newline/tab)
	var b strings.Builder
	for _, r := range s {
		if r == '\n' || r == '\t' || r >= 32 {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (d *Daemon) handleListSessions(w http.ResponseWriter, r *http.Request) {
	sessions := d.mgr.Store().List()
	type sessionInfo struct {
		ID         string `json:"id"`
		Command    string `json:"command"`
		Pid        int    `json:"pid"`
		Status     string `json:"status"`
		Duration   string `json:"duration"`
		Cwd        string `json:"cwd"`
		LastOutput string `json:"last_output"`
		PreviewRaw string `json:"preview_raw"`
		Rows       uint16 `json:"rows"`
		Cols       uint16 `json:"cols"`
	}
	infos := make([]sessionInfo, len(sessions))
	for i, s := range sessions {
		rawOutput := s.LastOutput(8192)
		// Align to valid UTF-8 boundary to avoid splitting multi-byte characters
		for len(rawOutput) > 0 && !utf8.RuneStart(rawOutput[0]) {
			rawOutput = rawOutput[1:]
		}
		rows, cols := s.Size()
		infos[i] = sessionInfo{
			ID:         s.ID,
			Command:    s.Command,
			Pid:        s.Pid,
			Status:     string(s.Status),
			Duration:   s.Duration().Truncate(time.Second).String(),
			Cwd:        s.Cwd,
			LastOutput: stripANSI(string(s.LastOutput(200))),
			PreviewRaw: base64.StdEncoding.EncodeToString(rawOutput),
			Rows:       rows,
			Cols:       cols,
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(infos)
}

func (d *Daemon) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req CreateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Command == "" {
		http.Error(w, "command is required", http.StatusBadRequest)
		return
	}
	if req.Rows == 0 {
		req.Rows = 24
	}
	if req.Cols == 0 {
		req.Cols = 80
	}

	ms, err := d.mgr.CreateSession(req.Command, req.Args, SessionConfig{
		Rows: req.Rows, Cols: req.Cols,
	})
	if err != nil {
		http.Error(w, "failed to create session: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(CreateSessionResponse{
		ID:      ms.Session.ID,
		Command: ms.Session.Command,
		Pid:     ms.Session.Pid,
	})
}

func (d *Daemon) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	if id == "" {
		http.Error(w, "session ID required", http.StatusBadRequest)
		return
	}
	if err := d.mgr.StopSession(id); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(DeleteSessionResponse{OK: true})
}

// handleSessionInput handles POST /api/sessions/:id/input — writes text to PTY stdin.
func (d *Daemon) handleSessionInput(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	id := strings.TrimSuffix(path, "/input")
	if id == "" {
		http.Error(w, "session ID required", http.StatusBadRequest)
		return
	}

	ms, ok := d.mgr.GetSession(id)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	ms.Hub.Input([]byte(body.Text))
	w.WriteHeader(http.StatusOK)
}

// --- Hooks handlers ---

// handleHookPermission handles POST /api/hooks/permission — receives Claude Code hook JSON,
// creates a pending request, and long-polls until resolved or timeout.
func (d *Daemon) handleHookPermission(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rawBody, _ := io.ReadAll(r.Body)

	var body struct {
		ToolName string          `json:"tool_name"`
		Input    json.RawMessage `json:"tool_input"`
	}
	json.Unmarshal(rawBody, &body)

	// Extract additional fields from the raw hook data
	var hookData map[string]interface{}
	json.Unmarshal(rawBody, &hookData)

	if body.ToolName == "" {
		if tn, ok := hookData["tool_name"].(string); ok {
			body.ToolName = tn
		}
	}

	// Extract session ID injected by hook script
	sessionID, _ := hookData["tlive_session_id"].(string)

	// Extract permission_suggestions for "always allow" option
	var suggestions json.RawMessage
	if s, ok := hookData["permission_suggestions"]; ok {
		suggestions, _ = json.Marshal(s)
	}

	req := d.hooks.AddPermission(body.ToolName, body.Input, sessionID, suggestions)

	// Long-poll: block until resolved or timeout
	resolution := d.hooks.WaitForResolution(req)

	w.Header().Set("Content-Type", "application/json")
	resp := map[string]interface{}{"decision": resolution.Decision}
	if len(resolution.UpdatedInput) > 0 {
		resp["updated_input"] = json.RawMessage(resolution.UpdatedInput)
	}
	// Include suggestions for "allow_always" so hook script can build updatedPermissions
	if resolution.Decision == "allow_always" && req.Suggestions != nil {
		resp["suggestions"] = json.RawMessage(req.Suggestions)
	}
	json.NewEncoder(w).Encode(resp)
}

// handleHookPermissionResolve handles POST /api/hooks/permission/:id/resolve
func (d *Daemon) handleHookPermissionResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse ID from path: /api/hooks/permission/:id/resolve
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/hooks/permission/"), "/")
	if len(parts) < 2 || parts[1] != "resolve" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	id := parts[0]

	var body struct {
		Decision     string          `json:"decision"`
		UpdatedInput json.RawMessage `json:"updated_input,omitempty"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Decision != "allow" && body.Decision != "deny" && body.Decision != "allow_always" {
		body.Decision = "deny"
	}

	ok := d.hooks.Resolve(id, body.Decision, body.UpdatedInput)
	if !ok {
		http.Error(w, "permission not found or already resolved", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "resolved"})
}

// handleHooksPending handles GET /api/hooks/pending — returns list of pending permissions.
func (d *Daemon) handleHooksPending(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pending := d.hooks.ListPending()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pending)
}

// handleHookNotify handles POST /api/hooks/notify — receives notification, stores for Bridge polling.
// For stop notifications, enriches with PTY last output while the session is still alive.
func (d *Daemon) handleHookNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rawBody, _ := io.ReadAll(r.Body)

	// Try to enrich stop notifications with session last output
	var hookData map[string]interface{}
	if err := json.Unmarshal(rawBody, &hookData); err == nil {
		if hookData["tlive_hook_type"] == "stop" {
			if sid, ok := hookData["tlive_session_id"].(string); ok && sid != "" {
				if ms, found := d.mgr.GetSession(sid); found {
					lastOutput := stripANSI(string(ms.Session.LastOutput(500)))
					if lastOutput != "" {
						hookData["last_output"] = lastOutput
						if enriched, err := json.Marshal(hookData); err == nil {
							rawBody = enriched
						}
					}
				}
			}
		}
	}

	d.notifications.Add(NotifyProgress, string(rawBody), "")
	w.WriteHeader(http.StatusOK)
}

// handleHookNotifications handles GET /api/hooks/notifications — returns recent notifications for Bridge polling.
func (d *Daemon) handleHookNotifications(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	notifications := d.notifications.List(50)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(notifications)
}

// --- Auth middleware ---

const unauthorizedHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TermLive - Unauthorized</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: #0d1117;
    color: #e6edf3;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
}
.card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: 48px;
    max-width: 420px;
    width: 90%;
    text-align: center;
}
.lock-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.6;
}
h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #e6edf3;
}
.desc {
    font-size: 14px;
    color: #8b949e;
    margin-bottom: 24px;
    line-height: 1.5;
}
.token-form {
    display: flex;
    gap: 8px;
}
.token-input {
    flex: 1;
    padding: 10px 14px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    color: #e6edf3;
    font-size: 14px;
    font-family: monospace;
    outline: none;
    transition: border-color 0.2s;
}
.token-input:focus {
    border-color: #4ecca3;
}
.token-input::placeholder {
    color: #484f58;
}
.submit-btn {
    padding: 10px 20px;
    background: #4ecca3;
    color: #0d1117;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
}
.submit-btn:hover {
    opacity: 0.85;
}
.hint {
    margin-top: 16px;
    font-size: 12px;
    color: #484f58;
}
</style>
</head>
<body>
<div class="card">
    <div class="lock-icon">&#128274;</div>
    <h1>Access Unauthorized</h1>
    <p class="desc">A valid token is required to access TermLive.<br>Check your terminal for the access URL with token.</p>
    <form class="token-form" onsubmit="event.preventDefault();location.href='/?token='+document.getElementById('tk').value;">
        <input id="tk" class="token-input" type="text" placeholder="Paste token here..." autofocus>
        <button class="submit-btn" type="submit">Go</button>
    </form>
    <p class="hint">Token is displayed when you run <code style="color:#8b949e;">tlive run</code></p>
</div>
</body>
</html>`

func (d *Daemon) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := ""
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimPrefix(auth, "Bearer ")
		}
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if token == "" {
			if cookie, err := r.Cookie("tl_token"); err == nil {
				token = cookie.Value
			}
		}
		if token != d.token {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(unauthorizedHTML))
			return
		}
		// Set cookie so browser AJAX/WebSocket requests authenticate automatically
		http.SetCookie(w, &http.Cookie{
			Name:  "tl_token",
			Value: d.token,
			Path:  "/",
		})
		next.ServeHTTP(w, r)
	})
}
