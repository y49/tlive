package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	qrterminal "github.com/mdp/qrterminal/v3"
	"github.com/spf13/cobra"
	"github.com/termlive/termlive/core/internal/config"
	"github.com/termlive/termlive/core/internal/daemon"
	"github.com/termlive/termlive/core/internal/notify"
	"github.com/termlive/termlive/core/internal/server"
	"github.com/termlive/termlive/core/web"
	"golang.org/x/term"
)

var publicIP string

// localOutputClient implements hub.Client to write PTY output to local
// stdout. It is registered on the session hub so that the SessionManager's
// output goroutine delivers data here.
type localOutputClient struct {
	writer   *os.File
	received atomic.Bool
}

func (c *localOutputClient) Send(data []byte) error {
	c.received.Store(true)
	c.writer.Write(data)
	return nil
}

func runCommand(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return cmd.Help()
	}

	cfg, _ := config.LoadFromEnv()

	// CLI flags override config values
	if cmd.Flags().Changed("port") {
		cfg.Daemon.Port = port
	}
	if cmd.Flags().Changed("token") && token != "" {
		cfg.Daemon.Token = token
	}

	rows, cols := uint16(24), uint16(80)
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		cols, rows = uint16(w), uint16(h)
	}

	lockPath := daemon.DefaultLockPath()

	// --- Determine host vs client mode ---
	isHost := true
	lock, err := daemon.ReadLockFile(lockPath)
	if err == nil {
		log.Printf("found lock file: port=%d pid=%d", lock.Port, lock.Pid)
		if daemonHealthCheck(lock.Port, lock.Token) {
			isHost = false
			log.Printf("daemon alive, running as client")
		} else {
			// Stale lock file from a crashed daemon — remove it
			log.Printf("daemon not responding, removing stale lock file")
			daemon.RemoveLockFile(lockPath)
		}
	}

	if isHost {
		log.Printf("starting as host, port=%d", cfg.Daemon.Port)
		return runHost(cfg, args, rows, cols, lockPath)
	}
	log.Printf("starting as client, daemon port=%d", lock.Port)
	return runClient(lock, args, rows, cols)
}

// runHost starts an embedded daemon (first process) and runs the command
// directly via the in-process SessionManager.
func runHost(cfg *config.Config, args []string, rows, cols uint16, lockPath string) error {
	// Create daemon
	d := daemon.NewDaemon(daemon.DaemonConfig{
		Port:          cfg.Daemon.Port,
		Token:         cfg.Daemon.Token,
		Host:          cfg.Daemon.Host,
		WeChatWebhook: cfg.Daemon.WeChatWebhook,
	})
	if wechat := notify.NewWeChatNotifier(cfg.Daemon.WeChatWebhook); wechat != nil {
		d.SetNotifiers(notify.NewMultiNotifier(wechat))
	}
	mgr := d.Manager()

	// Start reaper to clean up orphaned client-mode sessions (e.g. killed by timeout)
	mgr.StartReaper(60 * time.Second)

	// Create session directly (in-process, no HTTP)
	ms, err := mgr.CreateSession(args[0], args[1:], daemon.SessionConfig{
		Rows: rows, Cols: cols,
	})
	if err != nil {
		return fmt.Errorf("failed to start command: %w", err)
	}
	log.Printf("session created: id=%s cmd=%s args=%v pid=%d", ms.Session.ID, ms.Session.Command, args[1:], ms.Session.Pid)
	defer mgr.StopSession(ms.Session.ID)

	// On non-Windows, register local output client IMMEDIATELY after session
	// creation to minimize the window where initial PTY output could be missed.
	// On Windows, defer registration until after the QR code is shown, because
	// ConPTY output to stdout overwrites the shared console buffer.
	localClient := &localOutputClient{writer: os.Stdout}
	if runtime.GOOS != "windows" {
		ms.Hub.Register(localClient)
	}
	defer ms.Hub.Unregister(localClient)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Setup Web UI server as extra handler on the daemon.
	localIP := publicIP
	if localIP == "" {
		localIP = getLocalIP()
	}
	srv := server.New(mgr)
	// Let web clients resize the PTY so programs re-render at the viewer's width
	// (e.g. separator lines adapt to mobile screen width)
	srv.SetWebFS(web.Assets)
	d.SetExtraHandler(srv.Handler())

	// Write lock file BEFORE starting listener so clients can discover us
	daemon.WriteLockFile(lockPath, daemon.LockInfo{
		Port:  cfg.Daemon.Port,
		Token: d.Token(),
		Pid:   os.Getpid(),
	})
	defer daemon.RemoveLockFile(lockPath)

	// Print connection info
	url := fmt.Sprintf("http://%s:%d?token=%s", localIP, cfg.Daemon.Port, d.Token())
	localURL := fmt.Sprintf("http://localhost:%d?token=%s", cfg.Daemon.Port, d.Token())
	fmt.Fprintf(os.Stderr, "\n  TLive Web UI:\n")
	fmt.Fprintf(os.Stderr, "    Local:   %s\n", localURL)
	fmt.Fprintf(os.Stderr, "    Network: %s\n", url)
	fmt.Fprintf(os.Stderr, "  Session: %s (ID: %s)\n\n", ms.Session.Command, ms.Session.ID)
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stderr)
	fmt.Fprintln(os.Stderr)

	// On Windows, register the local output client now (after QR is shown)
	// and replay any buffered output the child produced while we were printing.
	if runtime.GOOS == "windows" {
		ms.Hub.Register(localClient)
	}

	// Set terminal to raw mode for proper input pass-through
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	rawMode := err == nil
	if !rawMode {
		fmt.Fprintf(os.Stderr, "  Note: Raw mode unavailable (Git Bash/mintty detected).\n")
		fmt.Fprintf(os.Stderr, "  For full interactive input, use Windows Terminal, PowerShell, or cmd.exe.\n")
		fmt.Fprintf(os.Stderr, "  In this mode, press Enter to send input. Web UI is fully interactive.\n\n")
	}

	// Sync PTY size after entering raw mode (QR code output may have changed terminal state)
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		ms.Proc.Resize(uint16(h), uint16(w))
	}

	// Replay buffered PTY output that may have been broadcast before
	// localClient was registered on the hub (race between CreateSession's
	// output goroutine and Register). Wait briefly for ConPTY initial output.
	time.Sleep(20 * time.Millisecond)
	if !localClient.received.Load() {
		if initial := ms.Session.LastOutput(64 * 1024); len(initial) > 0 {
			os.Stdout.Write(initial)
		}
	}

	// Local terminal input -> PTY (exits when ctx cancelled or stdin errors)
	go func() {
		buf := make([]byte, 1024)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				ms.Proc.Write(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	// Start daemon in goroutine
	go d.Run()

	// Start idle watcher — auto-shuts down after 15 min idle
	d.StartIdleWatcher()

	// Handle terminal resize (platform-specific: SIGWINCH on Unix, no-op on Windows)
	startResizeHandler(ms)

	// Wait for process exit or signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	doneCh := make(chan int, 1)
	go func() {
		doneCh <- ms.ExitCode()
	}()

	var exitCode int
	select {
	case exitCode = <-doneCh:
		ms.Hub.Unregister(localClient)
		fmt.Fprintf(os.Stderr, "\n  Process exited with code %d\n", exitCode)
	case sig := <-sigCh:
		ms.Hub.Unregister(localClient)
		fmt.Fprintf(os.Stderr, "\n  Received signal: %v\n", sig)
		ms.Proc.Kill()
		exitCode = 130
	}

	// Cleanup: cancel context first to signal all goroutines
	cancel()

	// Restore terminal BEFORE other cleanup (critical for Windows forced close)
	if rawMode {
		term.Restore(int(os.Stdin.Fd()), oldState)
	}

	// Check for remaining sessions (from client mode processes).
	// StopSession is deferred, so other sessions from clients may still be active.
	// We need to wait for them before shutting down the daemon.
	if mgr.ActiveCount() > 1 { // >1 because our session hasn't been stopped yet (deferred)
		fmt.Fprintf(os.Stderr, "  Daemon still serving %d other session(s). Press Ctrl+C to stop.\n", mgr.ActiveCount()-1)
		signal.Reset(syscall.SIGINT, syscall.SIGTERM)
		sigCh2 := make(chan os.Signal, 1)
		signal.Notify(sigCh2, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh2
		fmt.Fprintf(os.Stderr, "  Shutting down daemon...\n")
	}

	// deferred: mgr.StopSession, RemoveLockFile
	d.Stop()

	_ = exitCode
	return nil
}

// runClient connects to an already-running daemon and creates a new session
// via HTTP API, then relays I/O over WebSocket.
func runClient(lock daemon.LockInfo, args []string, rows, cols uint16) error {
	// Create session via HTTP API
	sessionID, err := createSessionViaAPI(lock.Port, lock.Token, args[0], args[1:], rows, cols)
	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}
	defer deleteSessionViaAPI(lock.Port, lock.Token, sessionID)

	localIP := publicIP
	if localIP == "" {
		localIP = getLocalIP()
	}
	url := fmt.Sprintf("http://%s:%d?token=%s", localIP, lock.Port, lock.Token)
	localURL := fmt.Sprintf("http://localhost:%d?token=%s", lock.Port, lock.Token)
	fmt.Fprintf(os.Stderr, "\n  TLive (client mode):\n")
	fmt.Fprintf(os.Stderr, "    Local:   %s\n", localURL)
	fmt.Fprintf(os.Stderr, "    Network: %s\n", url)
	fmt.Fprintf(os.Stderr, "  Session: %s (ID: %s)\n\n", args[0], sessionID)
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stderr)
	fmt.Fprintln(os.Stderr)

	// Set terminal to raw mode
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	rawMode := err == nil
	if !rawMode {
		fmt.Fprintf(os.Stderr, "  Note: Raw mode unavailable (Git Bash/mintty detected).\n")
		fmt.Fprintf(os.Stderr, "  For full interactive input, use Windows Terminal, PowerShell, or cmd.exe.\n\n")
	}
	defer func() {
		if rawMode {
			term.Restore(int(os.Stdin.Fd()), oldState)
		}
	}()

	// Connect WebSocket
	wsURL := fmt.Sprintf("ws://localhost:%d/ws/session/%s", lock.Port, sessionID)
	header := http.Header{}
	header.Set("Cookie", fmt.Sprintf("tl_token=%s", lock.Token))
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		if rawMode {
			term.Restore(int(os.Stdin.Fd()), oldState)
		}
		return fmt.Errorf("websocket connect: %w", err)
	}
	defer conn.Close()

	// Send initial resize
	resizeMsg, _ := json.Marshal(map[string]interface{}{
		"type": "resize",
		"rows": rows,
		"cols": cols,
	})
	conn.WriteMessage(websocket.TextMessage, resizeMsg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Signal handling
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		select {
		case <-sigCh:
			cancel()
		case <-ctx.Done():
		}
	}()

	// WS -> stdout (binary frames = PTY data, text frames = control messages)
	go func() {
		for {
			msgType, msg, err := conn.ReadMessage()
			if err != nil {
				cancel()
				return
			}
			if msgType == websocket.TextMessage {
				// Control message (size, exit) — don't print to terminal
				var ctrl struct {
					Type string `json:"type"`
					Code int    `json:"code"`
				}
				if json.Unmarshal(msg, &ctrl) == nil && ctrl.Type == "exit" {
					cancel()
				}
				continue
			}
			os.Stdout.Write(msg)
		}
	}()

	// stdin -> WS
	go func() {
		buf := make([]byte, 1024)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.BinaryMessage, buf[:n])
			}
			if err != nil {
				cancel()
				return
			}
		}
	}()

	// Wait for context cancellation (from WS close, signal, or stdin error)
	<-ctx.Done()

	fmt.Fprintf(os.Stderr, "\n  Session ended.\n")
	return nil
}

// --- Helper functions ---

// daemonHealthCheck pings the daemon status endpoint to verify it is alive.
func daemonHealthCheck(port int, token string) bool {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	url := fmt.Sprintf("http://localhost:%d/api/status", port)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// createSessionViaAPI creates a new session on the remote daemon via HTTP POST.
func createSessionViaAPI(port int, token string, command string, args []string, rows, cols uint16) (string, error) {
	reqBody := daemon.CreateSessionRequest{
		Command: command,
		Args:    args,
		Rows:    rows,
		Cols:    cols,
	}
	data, _ := json.Marshal(reqBody)
	url := fmt.Sprintf("http://localhost:%d/api/sessions", port)
	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	var result daemon.CreateSessionResponse
	json.NewDecoder(resp.Body).Decode(&result)
	return result.ID, nil
}

// deleteSessionViaAPI deletes a session on the remote daemon via HTTP DELETE.
func deleteSessionViaAPI(port int, token string, sessionID string) {
	url := fmt.Sprintf("http://localhost:%d/api/sessions/%s", port, sessionID)
	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

// isPrivateIP reports whether ip is an RFC 1918 private address
// (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16). This filters out
// VPN/tunnel adapters (e.g. Cloudflare WARP 198.18.0.0/15) that
// are not reachable from the local network.
func isPrivateIP(ip net.IP) bool {
	privateRanges := []struct {
		network *net.IPNet
	}{
		{parseCIDR("10.0.0.0/8")},
		{parseCIDR("172.16.0.0/12")},
		{parseCIDR("192.168.0.0/16")},
	}
	for _, r := range privateRanges {
		if r.network.Contains(ip) {
			return true
		}
	}
	return false
}

func parseCIDR(s string) *net.IPNet {
	_, network, _ := net.ParseCIDR(s)
	return network
}

func getLocalIP() string {
	// UDP dial trick: connect to a public IP to find the preferred outbound interface.
	// No actual traffic is sent since UDP is connectionless.
	conn, err := net.DialTimeout("udp4", "8.8.8.8:53", 1*time.Second)
	if err == nil {
		defer conn.Close()
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP.To4() != nil && !addr.IP.IsLoopback() && isPrivateIP(addr.IP) {
			return addr.IP.String()
		}
	}

	// Fallback: iterate interfaces, prefer private (RFC 1918) IPv4 addresses.
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && ipnet.IP.To4() != nil && isPrivateIP(ipnet.IP) {
			return ipnet.IP.String()
		}
	}
	return "127.0.0.1"
}
