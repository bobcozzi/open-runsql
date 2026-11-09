// Statement history: persisted per connection (user@host) in history.json
// next to connections.json. SQL statements and CL: commands are appended at
// run time, newest first, consecutive duplicates collapsed, capped per
// connection. The picker overlay lives in stmtHistory.ts (frontend).
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const historyCapPerConn = 500

type HistoryEntry struct {
	Text string `json:"text"`
	At   int64  `json:"at"`
}

type historyFile map[string][]HistoryEntry

func historyStorePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "ibmi-runsql", "history.json")
}

func loadHistory() (historyFile, error) {
	h := historyFile{}
	data, err := os.ReadFile(historyStorePath())
	if err != nil {
		if os.IsNotExist(err) {
			return h, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, &h); err != nil {
		return historyFile{}, nil // corrupt file: start fresh rather than fail
	}
	return h, nil
}

func saveHistory(h historyFile) error {
	path := historyStorePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(h, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// historyKey identifies a connection's bucket: "user@host", lower-cased.
func historyKey(host, user string) string {
	return strings.ToLower(strings.TrimSpace(user)) + "@" + strings.ToLower(strings.TrimSpace(host))
}

// connIdentity resolves the active tab's host/user for history calls.
func (a *App) connIdentity(connectionID string) (host, user string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if c := a.connections[connectionID]; c != nil {
		return c.host, c.user
	}
	return "", ""
}

// ListStatementHistory returns the entries for a connection, newest first.
func (a *App) ListStatementHistory(connectionID string) ([]HistoryEntry, error) {
	host, user := a.connIdentity(connectionID)
	if host == "" {
		return []HistoryEntry{}, nil
	}
	h, err := loadHistory()
	if err != nil {
		return nil, err
	}
	return h[historyKey(host, user)], nil
}

// AddStatementHistory appends one entry (newest first, consecutive dup
// collapse, capped). Returns the connection's resulting list.
func (a *App) AddStatementHistory(connectionID, text string) ([]HistoryEntry, error) {
	trimmed := strings.TrimSpace(text)
	host, user := a.connIdentity(connectionID)
	if host == "" || trimmed == "" {
		return []HistoryEntry{}, nil
	}
	h, err := loadHistory()
	if err != nil {
		return nil, err
	}
	key := historyKey(host, user)
	entries := h[key]
	if len(entries) > 0 && entries[0].Text == trimmed {
		return entries, nil
	}
	entries = append([]HistoryEntry{{Text: trimmed, At: time.Now().Unix()}}, entries...)
	if len(entries) > historyCapPerConn {
		entries = entries[:historyCapPerConn]
	}
	h[key] = entries
	if err := saveHistory(h); err != nil {
		return nil, err
	}
	return entries, nil
}

// DeleteStatementHistory removes one entry by index (into the newest-first
// list). Out-of-range indexes are ignored.
func (a *App) DeleteStatementHistory(connectionID string, index int) ([]HistoryEntry, error) {
	host, user := a.connIdentity(connectionID)
	if host == "" {
		return []HistoryEntry{}, nil
	}
	h, err := loadHistory()
	if err != nil {
		return nil, err
	}
	key := historyKey(host, user)
	entries := h[key]
	if index >= 0 && index < len(entries) {
		entries = append(entries[:index], entries[index+1:]...)
		h[key] = entries
		if err := saveHistory(h); err != nil {
			return nil, err
		}
	}
	return entries, nil
}
