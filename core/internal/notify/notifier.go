package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type NotifyMessage struct {
	SessionID          string
	Command            string
	Pid                int
	Duration           string
	LastOutput         string
	WebURL             string
	IdleSeconds        int
	NotificationType   string
	PermissionToolName string
}

type Notifier interface {
	Send(msg *NotifyMessage) error
}

type MultiNotifier struct {
	notifiers []Notifier
}

func NewMultiNotifier(notifiers ...Notifier) *MultiNotifier {
	filtered := make([]Notifier, 0, len(notifiers))
	for _, notifier := range notifiers {
		if notifier != nil {
			filtered = append(filtered, notifier)
		}
	}
	return &MultiNotifier{notifiers: filtered}
}

func (m *MultiNotifier) Send(msg *NotifyMessage) error {
	if m == nil {
		return nil
	}
	var firstErr error
	for _, notifier := range m.notifiers {
		if err := notifier.Send(msg); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (m *MultiNotifier) Len() int {
	if m == nil {
		return 0
	}
	return len(m.notifiers)
}

const defaultWeChatHTTPTimeout = 8 * time.Second

type WeChatNotifier struct {
	webhookURL string
	client     *http.Client
}

func NewWeChatNotifier(webhookURL string) *WeChatNotifier {
	trimmed := strings.TrimSpace(webhookURL)
	if trimmed == "" {
		return nil
	}
	return &WeChatNotifier{
		webhookURL: trimmed,
		client:     &http.Client{Timeout: defaultWeChatHTTPTimeout},
	}
}

func (w *WeChatNotifier) Send(msg *NotifyMessage) error {
	if w == nil || w.webhookURL == "" {
		return nil
	}
	client := w.client
	if client == nil {
		client = &http.Client{Timeout: defaultWeChatHTTPTimeout}
	}
	content := renderWeChatContent(msg)
	payload := map[string]any{
		"msgtype":  "markdown",
		"markdown": map[string]string{"content": content},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := client.Post(w.webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wechat webhook returned status %d", resp.StatusCode)
	}
	return nil
}

func renderWeChatContent(msg *NotifyMessage) string {
	if msg == nil {
		return "**TLive 通知**"
	}

	command := strings.TrimSpace(msg.Command)
	if command == "" {
		command = "notification"
	}
	messageType := strings.TrimSpace(msg.NotificationType)
	category := classifyWeChatNotification(command, messageType)

	sections := []string{fmt.Sprintf("**%s**", weChatNotificationTitle(category, msg.PermissionToolName))}

	meta := make([]string, 0, 6)
	meta = append(meta, fmt.Sprintf("> 類型：`%s`", command))
	if messageType != "" {
		meta = append(meta, fmt.Sprintf("> 子類型：`%s`", messageType))
	}
	if tool := strings.TrimSpace(msg.PermissionToolName); tool != "" {
		meta = append(meta, fmt.Sprintf("> 工具：`%s`", tool))
	}
	if sessionID := strings.TrimSpace(msg.SessionID); sessionID != "" {
		meta = append(meta, fmt.Sprintf("> 會話：`%s`", sessionID))
	}
	if pid := msg.Pid; pid > 0 {
		meta = append(meta, fmt.Sprintf("> PID：`%d`", pid))
	}
	if duration := strings.TrimSpace(msg.Duration); duration != "" {
		meta = append(meta, fmt.Sprintf("> 持續時間：%s", duration))
	}
	if idle := msg.IdleSeconds; idle > 0 {
		meta = append(meta, fmt.Sprintf("> 空閒：%ds", idle))
	}
	sections = append(sections, strings.Join(meta, "\n"))

	if summary := strings.TrimSpace(weChatSummaryLine(category, msg.PermissionToolName)); summary != "" {
		sections = append(sections, summary)
	}
	if hint := strings.TrimSpace(weChatActionHint(category)); hint != "" {
		sections = append(sections, hint)
	}
	if output := weChatOutputExcerpt(msg.LastOutput, category); output != "" {
		sections = append(sections, fmt.Sprintf("%s\n```\n%s\n```", weChatOutputLabel(category), output))
	}
	if webURL := strings.TrimSpace(msg.WebURL); webURL != "" {
		sections = append(sections, fmt.Sprintf("[打開終端](%s)", webURL))
	}

	return strings.Join(sections, "\n\n")
}

func weChatNotificationTitle(category, toolName string) string {
	switch category {
	case "stop":
		return "TLive 停止通知"
	case "permission_prompt":
		if tool := strings.TrimSpace(toolName); tool != "" {
			return fmt.Sprintf("TLive 權限確認 · %s", tool)
		}
		return "TLive 權限確認"
	case "idle_prompt":
		return "TLive 等待輸入"
	case "error":
		return "TLive 異常通知"
	case "completion":
		return "TLive 任務完成"
	default:
		return "TLive 進度通知"
	}
}

func weChatSummaryLine(category, toolName string) string {
	switch category {
	case "permission_prompt":
		if tool := strings.TrimSpace(toolName); tool != "" {
			return fmt.Sprintf("需要你確認工具權限後才能繼續：`%s`", tool)
		}
		return "需要你確認工具權限後才能繼續。"
	case "idle_prompt":
		return "目前執行流程暫停中，正在等待你的下一步輸入。"
	case "completion":
		return "本次執行已完成，重點結果與最後輸出如下。"
	case "error":
		return "執行過程出現異常，以下是最近一次可用輸出。"
	case "stop":
		return "本次執行已停止，以下是結束前保留下來的內容。"
	default:
		return "執行中有新的進度更新。"
	}
}

func weChatActionHint(category string) string {
	switch category {
	case "permission_prompt":
		return "請先完成權限確認，再繼續後續流程。"
	case "idle_prompt":
		return "如需繼續，請回到終端或 Web 端輸入下一個指令。"
	case "completion":
		return "若結果符合預期，可直接進入下一步；若不符，建議先回看輸出細節。"
	case "error":
		return "建議優先查看錯誤上下文，再決定是否重試或調整指令。"
	case "stop":
		return "如需恢復處理，可重新進入該會話或重新執行命令。"
	default:
		return "可打開終端查看完整上下文與最新狀態。"
	}
}

func weChatOutputLabel(category string) string {
	switch category {
	case "completion":
		return "結果摘錄："
	case "error":
		return "錯誤上下文："
	case "permission_prompt":
		return "待確認內容："
	case "idle_prompt":
		return "目前停留內容："
	case "stop":
		return "停止前輸出："
	default:
		return "最近輸出："
	}
}

func classifyWeChatNotification(command, notificationType string) string {
	command = strings.ToLower(strings.TrimSpace(command))
	notificationType = strings.ToLower(strings.TrimSpace(notificationType))

	if command == "stop" {
		return "stop"
	}
	if notificationType != "" {
		switch notificationType {
		case "permission_prompt":
			return "permission_prompt"
		case "idle_prompt":
			return "idle_prompt"
		case "error", "failed", "failure":
			return "error"
		case "complete", "completed", "completion", "finished":
			return "completion"
		}
		if strings.Contains(notificationType, "idle") || strings.Contains(notificationType, "waiting") {
			return "idle_prompt"
		}
		if strings.Contains(notificationType, "error") || strings.Contains(notificationType, "fail") {
			return "error"
		}
		if strings.Contains(notificationType, "complete") || strings.Contains(notificationType, "finish") || strings.Contains(notificationType, "done") {
			return "completion"
		}
	}
	return "progress"
}

func weChatOutputExcerpt(lastOutput, category string) string {
	normalized := normalizeWeChatOutput(lastOutput)
	if normalized == "" {
		return ""
	}

	switch category {
	case "completion":
		if summary := completionSummaryLine(normalized); summary != "" {
			return sanitizeWeChatCodeBlock(summary)
		}
		return sanitizeWeChatCodeBlock(firstNonEmptyLine(normalized))
	case "progress":
		lines := dedupeAdjacentLines(strings.Split(normalized, "\n"))
		filtered := filterProgressLines(lines)
		if len(filtered) > 0 {
			return sanitizeWeChatCodeBlock(filtered[len(filtered)-1])
		}
		if len(lines) > 0 {
			return sanitizeWeChatCodeBlock(lines[len(lines)-1])
		}
		if tail := lastNonEmptyLine(normalized); tail != "" {
			return sanitizeWeChatCodeBlock(tail)
		}
		return sanitizeWeChatCodeBlock(normalized)
	case "error":
		if excerpt := errorFocusedExcerpt(normalized); excerpt != "" {
			return sanitizeWeChatCodeBlock(excerpt)
		}
		return sanitizeWeChatCodeBlock(lastLines(normalized, 12))
	case "permission_prompt", "idle_prompt", "stop":
		return sanitizeWeChatCodeBlock(lastLines(normalized, 8))
	default:
		return sanitizeWeChatCodeBlock(normalized)
	}
}

func completionSummaryLine(s string) string {
	lines := strings.Split(s, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "summary:") || strings.HasPrefix(lower, "result:") || strings.HasPrefix(lower, "done:") || strings.HasPrefix(lower, "completed:") || strings.HasPrefix(lower, "完成：") || strings.HasPrefix(lower, "結果：") {
			return trimmed
		}
	}
	if success := completionSuccessLine(lines); success != "" {
		return success
	}
	if informative := bestInformativeLine(lines); informative != "" {
		return informative
	}
	return firstNonEmptyLine(s)
}

func completionSuccessLine(lines []string) string {
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "succeeded") || strings.Contains(lower, "success") || strings.Contains(lower, "completed") || strings.Contains(lower, "complete") || strings.Contains(lower, "done") || strings.Contains(lower, "finished") || strings.Contains(lower, "成功") || strings.Contains(lower, "完成") || strings.Contains(lower, "已完成") {
			if !looksLikeCompletionNoise(lower) {
				return trimmed
			}
		}
	}
	return ""
}

func looksLikeCompletionNoise(lower string) bool {
	return strings.Contains(lower, "starting") || strings.Contains(lower, "running") || strings.Contains(lower, "loading")
}

func bestInformativeLine(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			continue
		}
		if !looksLikeInformativeNoise(strings.ToLower(trimmed)) {
			return trimmed
		}
	}
	return ""
}

func looksLikeInformativeNoise(lower string) bool {
	if lower == "" {
		return true
	}
	return strings.Contains(lower, "starting") || strings.Contains(lower, "running") || strings.Contains(lower, "loading") || strings.Contains(lower, "booting")
}

func errorFocusedExcerpt(s string) string {
	lines := strings.Split(s, "\n")
	idx, level := findLastErrorAnchor(lines)
	if idx < 0 {
		return lastLines(s, 12)
	}

	switch level {
	case 1:
		lower := strings.ToLower(strings.TrimSpace(lines[idx]))
		switch {
		case strings.Contains(lower, "traceback"):
			if excerpt := tracebackWindow(lines, idx); excerpt != "" {
				return excerpt
			}
		case strings.Contains(lower, "caused by"):
			if excerpt := causedByWindow(lines, idx); excerpt != "" {
				return excerpt
			}
		}
		return genericErrorWindow(lines, idx, 2, 4)
	case 2:
		return genericErrorWindow(lines, idx, 2, 3)
	default:
		return genericErrorWindow(lines, idx, 1, 2)
	}
}

func findLastErrorAnchor(lines []string) (int, int) {
	bestIdx, bestLevel := -1, 0
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		level := errorAnchorLevel(lower)
		if level == 0 {
			continue
		}
		if level == 1 {
			if strings.Contains(lower, "traceback") {
				return i, level
			}
			if bestIdx == -1 {
				bestIdx, bestLevel = i, level
			}
			continue
		}
		if bestIdx == -1 {
			bestIdx, bestLevel = i, level
		}
	}
	return bestIdx, bestLevel
}

func errorAnchorLevel(lower string) int {
	switch {
	case strings.Contains(lower, "panic:"), strings.HasPrefix(lower, "error:"), strings.Contains(lower, "traceback"), strings.Contains(lower, "caused by:"), strings.Contains(lower, "fatal"):
		return 1
	case strings.Contains(lower, "failed"), strings.Contains(lower, "exception"):
		return 2
	case strings.HasPrefix(lower, "at "):
		return 3
	default:
		return 0
	}
}

func tracebackWindow(lines []string, idx int) string {
	start := idx
	for start > 0 {
		prev := strings.TrimSpace(lines[start-1])
		lowerPrev := strings.ToLower(prev)
		if prev == "" || strings.Contains(lowerPrev, "caused by:") {
			start--
			continue
		}
		break
	}
	end := idx + 1
	for end < len(lines) {
		trimmed := strings.TrimSpace(lines[end])
		if trimmed == "" {
			break
		}
		end++
		if strings.HasPrefix(strings.ToLower(trimmed), "error:") || strings.Contains(strings.ToLower(trimmed), "panic:") {
			break
		}
	}
	return joinNonEmptyLines(skipLeadingAtLine(lines[start:end]))
}

func skipLeadingAtLine(lines []string) []string {
	if len(lines) == 0 {
		return lines
	}
	first := strings.TrimSpace(lines[0])
	if strings.HasPrefix(strings.ToLower(first), "at ") {
		return lines[1:]
	}
	return lines
}

func causedByWindow(lines []string, idx int) string {
	start := idx
	for start > 0 {
		prev := strings.TrimSpace(lines[start-1])
		if strings.Contains(strings.ToLower(prev), "caused by:") {
			start--
			continue
		}
		break
	}
	end := idx + 1
	for end < len(lines) {
		trimmed := strings.TrimSpace(lines[end])
		lower := strings.ToLower(trimmed)
		if trimmed == "" {
			break
		}
		if end > idx && !(strings.HasPrefix(lower, "at ") || strings.Contains(lower, "traceback") || strings.HasPrefix(lower, "error:") || strings.Contains(lower, "caused by:")) {
			break
		}
		end++
	}
	return joinNonEmptyLines(lines[start:end])
}

func genericErrorWindow(lines []string, idx int, before, after int) string {
	start := idx - before
	if start < 0 {
		start = 0
	}
	end := idx + after + 1
	if end > len(lines) {
		end = len(lines)
	}
	return joinNonEmptyLines(lines[start:end])
}

func joinNonEmptyLines(lines []string) string {
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			filtered = append(filtered, trimmed)
		}
	}
	return strings.Join(filtered, "\n")
}

func filterProgressLines(lines []string) []string {
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || looksLikeProgressNoise(trimmed) {
			continue
		}
		filtered = append(filtered, trimmed)
	}
	return filtered
}

func looksLikeProgressNoise(line string) bool {
	lower := strings.ToLower(strings.TrimSpace(line))
	if lower == "" {
		return true
	}
	if isPureSymbolLine(lower) || isSpinnerLine(lower) || isProgressBarLine(lower) || isTimingHeartbeatLine(lower) {
		return true
	}
	return false
}

func isPureSymbolLine(line string) bool {
	for _, r := range line {
		if !strings.ContainsRune(".-_=~>#[]()|/\\*+:", r) && (r < '0' || r > '9') && r != ' ' && r != '%' {
			return false
		}
	}
	return true
}

func isSpinnerLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return trimmed == "|" || trimmed == "/" || trimmed == "-" || trimmed == "\\"
}

func isProgressBarLine(line string) bool {
	hasPercent := strings.Contains(line, "%")
	hasBarChars := strings.ContainsAny(line, "[]=#")
	if !hasPercent && !hasBarChars {
		return false
	}
	letters := 0
	for _, r := range line {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			letters++
		}
	}
	if letters > 6 {
		return false
	}
	lower := strings.ToLower(strings.TrimSpace(line))
	if strings.Contains(lower, "step") || strings.Contains(lower, "checkpoint") || strings.Contains(lower, "download") || strings.Contains(lower, "upload") {
		return false
	}
	return true
}

func isTimingHeartbeatLine(line string) bool {
	if strings.HasPrefix(line, "elapsed:") || strings.HasPrefix(line, "time:") {
		return true
	}
	return strings.HasPrefix(line, "running for ")
}

func dedupeAdjacentLines(lines []string) []string {
	if len(lines) == 0 {
		return nil
	}
	result := make([]string, 0, len(lines))
	var last string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if trimmed == last {
			continue
		}
		result = append(result, trimmed)
		last = trimmed
	}
	return result
}

func normalizeWeChatOutput(s string) string {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return ""
	}
	trimmed = strings.ReplaceAll(trimmed, "\r\n", "\n")
	trimmed = strings.ReplaceAll(trimmed, "\r", "\n")
	return trimmed
}

func firstNonEmptyLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func lastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if trimmed := strings.TrimSpace(lines[i]); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func lastLines(s string, n int) string {
	if n <= 0 {
		return ""
	}
	lines := strings.Split(s, "\n")
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimRight(line, " \t"); trimmed != "" {
			filtered = append(filtered, trimmed)
		}
	}
	if len(filtered) == 0 {
		return ""
	}
	if len(filtered) > n {
		filtered = filtered[len(filtered)-n:]
	}
	return strings.Join(filtered, "\n")
}

func truncateRunes(s string, limit int) string {
	if limit <= 0 || s == "" {
		return ""
	}
	if utf8.RuneCountInString(s) <= limit {
		return s
	}
	count := 0
	for idx := range s {
		if count == limit {
			return s[:idx]
		}
		count++
	}
	return s
}

func sanitizeWeChatCodeBlock(s string) string {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return ""
	}
	trimmed = strings.ReplaceAll(trimmed, "```", "'''")
	trimmed = strings.ReplaceAll(trimmed, "\r\n", "\n")
	trimmed = strings.ReplaceAll(trimmed, "\r", "\n")
	const maxLen = 1200
	if utf8.RuneCountInString(trimmed) > maxLen {
		if lastFence := strings.LastIndex(trimmed, "'''"); lastFence >= 0 {
			prefixLimit := maxLen - utf8.RuneCountInString("\n…")
			if prefixLimit < 0 {
				prefixLimit = 0
			}
			fencePrefix := trimmed[:lastFence]
			if fenceRunes := utf8.RuneCountInString(fencePrefix); fenceRunes < prefixLimit {
				prefixLimit = fenceRunes
			}
			trimmed = strings.TrimSpace(truncateRunes(trimmed, prefixLimit)+trimmed[lastFence:]) + "\n…"
		} else {
			trimmed = strings.TrimSpace(truncateRunes(trimmed, maxLen)) + "\n…"
		}
	}
	return trimmed
}
