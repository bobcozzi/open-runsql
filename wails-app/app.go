package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/BobCozzi/open-runsql/wails-app/internal/bridge"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Public request/response models exposed to the Wails frontend.

type ConnectRequest struct {
	Host          string `json:"host"`
	User          string `json:"user"`
	Password      string `json:"password"`
	TLS           bool   `json:"tls"`
	Naming        string `json:"naming"`
	DefaultSchema string `json:"defaultSchema"`
	FetchSize     int    `json:"fetchSize"`
}

type ConnectResponse struct {
	ConnectionID    string `json:"connectionId"`
	DatabaseProduct string `json:"databaseProduct"`
	DatabaseVersion string `json:"databaseVersion"`
	DriverName      string `json:"driverName"`
	DriverVersion   string `json:"driverVersion"`
	Host            string `json:"host"`
	User            string `json:"user"`
	ServerJob       string `json:"serverJob,omitempty"`
}

type RunRequest struct {
	ConnectionID string `json:"connectionId"`
	Text         string `json:"text"`
	FetchSize    int    `json:"fetchSize"`
}

type ColumnInfo struct {
	Name          string `json:"name"`
	Label         string `json:"label"`
	Type          int    `json:"type"`
	TypeName      string `json:"typeName"`
	Precision     int    `json:"precision"`
	Scale         int    `json:"scale"`
	DisplaySize   int    `json:"displaySize"`
	Nullable      bool   `json:"nullable"`
	AutoIncrement bool   `json:"autoIncrement"`
	SchemaName    string `json:"schemaName"`
	TableName     string `json:"tableName"`
}

type FetchRequest struct {
	ConnectionID string `json:"connectionId"`
	CursorID     string `json:"cursorId"`
	FetchSize    int    `json:"fetchSize"`
}

type SqlMessage struct {
	SQLState   string `json:"sqlState"`
	VendorCode int    `json:"vendorCode"`
	Message    string `json:"message"`
}

type SqlResult struct {
	Kind        string       `json:"kind"`
	Columns     []ColumnInfo `json:"columns"`
	Rows        [][]any      `json:"rows"`
	CursorID    string       `json:"cursorId,omitempty"`
	More        bool         `json:"more"`
	UpdateCount int64        `json:"updateCount,omitempty"`
	Messages    []SqlMessage `json:"messages,omitempty"`
	ElapsedMs   int64        `json:"elapsedMs"`
	Error       string       `json:"error,omitempty"`
}

type CLMessage struct {
	ID       string `json:"id"`
	Severity int    `json:"severity"`
	Type     int    `json:"type"`
	TypeName string `json:"typeName"`
	Text     string `json:"text"`
	// SecondLevelText mirrors SECLVLMSG from the cl-prompter CMD_RUN UDTF.
	SecondLevelText string `json:"secondLevelText"`
	// Kind mirrors the cl-prompter classifyMessage buckets: error/warning/info.
	Kind string `json:"kind"`
}

type CLResult struct {
	Kind      string      `json:"kind"`
	Command   string      `json:"command"`
	OK        bool        `json:"ok"`
	Messages  []CLMessage `json:"messages"`
	ElapsedMs int64       `json:"elapsedMs"`
}

type GetCmdXmlRequest struct {
	ConnectionID string `json:"connectionId"`
	Command      string `json:"command"`
	Library      string `json:"library,omitempty"`
}

type CmdXmlResult struct {
	XML       string `json:"xml"`
	Bytes     int    `json:"bytes"`
	ElapsedMs int64  `json:"elapsedMs"`
}

// ConnectionProfile is a saved connection. Password is stored base64-obscured
// only when the user opted in via the "Save password" checkbox — this is
// obscurity, not encryption, for trusted/limited-access environments.
type ConnectionProfile struct {
	Name          string `json:"name"`
	Host          string `json:"host"`
	User          string `json:"user"`
	DefaultSchema string `json:"defaultSchema,omitempty"`
	Naming        string `json:"naming,omitempty"`
	TLS           bool   `json:"tls"`
	SavePassword  bool   `json:"savePassword,omitempty"`
	PasswordB64   string `json:"passwordB64,omitempty"`
	LastUsedAt    int64  `json:"lastUsedAt"`
}

// App is the Wails v3 service. It owns the Java bridge process and the
// per-connection state. Methods on App are callable from the frontend.
type App struct {
	app *application.App

	mu     sync.Mutex
	client *bridge.Client
	jar    string

	connections map[string]*connState
	workspace   *WorkspaceStore
	// detached maps connectionId -> torn-off window (native v3 windows).
	detached map[string]*application.WebviewWindow
}

type connState struct {
	id        string
	host      string
	user      string
	cursorID  string
	hasCursor bool
}

func NewApp(jar string) *App {
	a := &App{jar: jar, connections: map[string]*connState{}, detached: map[string]*application.WebviewWindow{}}
	a.workspace = NewWorkspaceStore(a)
	return a
}

// v3 lifecycle hooks (ServiceStartup / ServiceShutdown replace startup/shutdown).
func (a *App) ServiceStartup(_ context.Context, _ application.ServiceOptions) error {
	return nil
}

func (a *App) ServiceShutdown() error {
	a.closeClient()
	return nil
}

func (a *App) ensureClient() (*bridge.Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client != nil && a.client.Alive() {
		return a.client, nil
	}
	c, err := bridge.Start("", a.jar)
	if err != nil {
		return nil, fmt.Errorf("could not start JDBC bridge (%s): %w", a.jar, err)
	}
	a.client = c
	a.connections = map[string]*connState{}
	return c, nil
}

func (a *App) closeClient() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client != nil {
		_ = a.client.Close()
		a.client = nil
	}
	a.connections = map[string]*connState{}
}

// Version returns the bridge/app version string for the status bar.
func (a *App) Version() string { return "0.1.0" }

func profileStorePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "ibmi-run-sql", "connections.json")
}

func loadProfiles() ([]ConnectionProfile, error) {
	data, err := os.ReadFile(profileStorePath())
	if errors.Is(err, os.ErrNotExist) {
		return []ConnectionProfile{}, nil
	}
	if err != nil {
		return nil, err
	}
	var profiles []ConnectionProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, err
	}
	sort.SliceStable(profiles, func(i, j int) bool { return profiles[i].LastUsedAt > profiles[j].LastUsedAt })
	return profiles, nil
}

func saveProfiles(profiles []ConnectionProfile) error {
	path := profileStorePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// ListConnectionProfiles returns all saved connection profiles.
func (a *App) ListConnectionProfiles() ([]ConnectionProfile, error) {
	return loadProfiles()
}

// SaveConnectionProfile upserts a profile keyed by host+user, MRU-first.
func (a *App) SaveConnectionProfile(p ConnectionProfile) error {
	p.Host = strings.TrimSpace(p.Host)
	if p.Host == "" {
		return errors.New("host is required")
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		p.Name = p.Host
	}
	p.LastUsedAt = time.Now().Unix()
	if !p.SavePassword {
		p.PasswordB64 = ""
	}
	profiles, err := loadProfiles()
	if err != nil {
		return err
	}
	// Preserve a previously saved password when the new save carries none
	// but still has savePassword set (e.g. auto-save with empty field).
	for i, existing := range profiles {
		if strings.EqualFold(existing.Host, p.Host) && strings.EqualFold(existing.User, p.User) {
			if p.SavePassword && p.PasswordB64 == "" {
				p.PasswordB64 = existing.PasswordB64
			}
			profiles[i] = p
			return saveProfiles(profiles)
		}
	}
	profiles = append(profiles, p)
	return saveProfiles(profiles)
}

// DeleteConnectionProfile removes a profile by name.
func (a *App) DeleteConnectionProfile(name string) error {
	profiles, err := loadProfiles()
	if err != nil {
		return err
	}
	out := profiles[:0]
	for _, p := range profiles {
		if !strings.EqualFold(p.Name, name) && !strings.EqualFold(p.Host, name) {
			out = append(out, p)
		}
	}
	return saveProfiles(out)
}

// Connect opens a new JDBC connection to the IBM i.
func (a *App) Connect(req ConnectRequest) (*ConnectResponse, error) {
	host := strings.TrimSpace(req.Host)
	user := strings.TrimSpace(req.User)
	if host == "" || user == "" {
		return nil, errors.New("host and user are required")
	}
	c, err := a.ensureClient()
	if err != nil {
		return nil, err
	}
	fetchSize := req.FetchSize
	if fetchSize <= 0 {
		fetchSize = 200
	}
	resp, err := c.Call("connect", map[string]any{
		"host": host, "user": user, "password": req.Password,
		"tls": req.TLS, "naming": normalizeNaming(req.Naming),
		"defaultSchema": req.DefaultSchema, "timeoutSeconds": 30,
		"fetchSize": fetchSize,
	})
	if err != nil {
		return nil, err
	}
	connID := str(resp, "connectionId")
	a.mu.Lock()
	a.connections[connID] = &connState{id: connID, host: host, user: user}
	a.mu.Unlock()
	a.workspace.Update(connID, func(w *WorkspaceState) {
		w.Label = user + "@" + host
	})
	return &ConnectResponse{
		ConnectionID:    connID,
		DatabaseProduct: str(resp, "databaseProduct"),
		DatabaseVersion: str(resp, "databaseVersion"),
		DriverName:      str(resp, "driverName"),
		DriverVersion:   str(resp, "driverVersion"),
		Host:            host,
		User:            user,
		ServerJob:       str(resp, "serverJob"),
	}, nil
}

// Disconnect closes the connection and forgets it.
func (a *App) Disconnect(connectionID string) error {
	a.mu.Lock()
	c := a.client
	state, known := a.connections[connectionID]
	delete(a.connections, connectionID)
	a.mu.Unlock()
	if c == nil || !known {
		return nil
	}
	_, _ = c.Call("disconnect", map[string]any{"connectionId": state.id})
	a.workspace.remove(connectionID)
	return nil
}

// CancelSQL requests cancellation of the statement running on a connection.
func (a *App) CancelSQL(connectionID string) error {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[connectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return errors.New("no active connection")
	}
	_, err := c.Call("cancelSQL", map[string]any{"connectionId": connectionID})
	return err
}

var clPrefix = regexp.MustCompile(`(?i)^\s*(?:CL\s*:\s*|CL\s+)([\s\S]+)$`)

// stripTrailingSemicolon ports sqlSyntaxChecker.ts stripTrailingSemicolon():
// JDBC Statement.execute() is single-statement; a trailing ';' trips JTOpen.
func stripTrailingSemicolon(sql string) string {
	return strings.TrimSpace(regexp.MustCompile(`;\s*$`).ReplaceAllString(sql, ""))
}

// classifyEntry splits the Command Entry text into SQL or CL.
// Rules (aligned with cozzi-cl-prompter):
//   - "CL:" prefix (or "CL <cmd>") forces CL mode.
//   - "SQL:" prefix strips to SQL.
//   - Bare SELECT/VALUES/WITH/SET/CALL/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/...
//     keywords are treated as SQL.
//   - Anything else is treated as a CL command.
func classifyEntry(text string) (mode string, payload string) {
	trimmed := strings.TrimSpace(text)
	if m := clPrefix.FindStringSubmatch(trimmed); m != nil {
		return "CL", strings.TrimSpace(m[1])
	}
	if m := regexp.MustCompile(`(?i)^\s*sql\s*:\s*([\s\S]*)$`).FindStringSubmatch(trimmed); m != nil {
		return "SQL", stripTrailingSemicolon(m[1])
	}
	if regexp.MustCompile(`(?i)^(select|values|with|set|call|insert|update|delete|merge|create|drop|alter|declare|truncate|comment|grant|revoke|rename|label)\b`).MatchString(trimmed) {
		return "SQL", stripTrailingSemicolon(trimmed)
	}
	return "CL", trimmed
}

// Run executes the command-entry text: SQL via JDBC, or CL via CommandCall.
func (a *App) Run(req RunRequest) (any, error) {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	mode, payload := classifyEntry(req.Text)
	if payload == "" {
		return nil, errors.New("nothing to run")
	}
	if mode == "CL" {
		return a.runCL(c, req.ConnectionID, payload)
	}
	return a.runSQL(c, req.ConnectionID, payload, req.FetchSize)
}

func (a *App) runSQL(c *bridge.Client, connID string, sql string, fetchSize int) (*SqlResult, error) {
	if fetchSize <= 0 {
		fetchSize = 200
	}
	resp, err := c.Call("executeSQL", map[string]any{
		"connectionId": connID, "sql": sql, "fetchSize": fetchSize,
	})
	if err != nil {
		return nil, err
	}
	result := decodeSqlResult(resp["result"])
	a.setCursor(connID, result.CursorID, result.More)
	a.workspace.Update(connID, func(w *WorkspaceState) {
		w.Columns = result.Columns
		w.Rows = result.Rows
		w.CursorID = result.CursorID
		w.More = result.More
		w.ShowingResults = result.Kind == "rows"
	})
	return result, nil
}
func (a *App) Fetch(req FetchRequest) (*SqlResult, error) {
	a.mu.Lock()
	c := a.client
	state, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	cursorID := req.CursorID
	if cursorID == "" && state != nil && state.hasCursor {
		cursorID = state.cursorID
	}
	if cursorID == "" {
		return nil, errors.New("no open cursor to fetch from")
	}
	fetchSize := req.FetchSize
	if fetchSize <= 0 {
		fetchSize = 200
	}
	resp, err := c.Call("fetchRows", map[string]any{
		"connectionId": req.ConnectionID, "cursorId": cursorID, "fetchSize": fetchSize,
	})
	if err != nil {
		return nil, err
	}
	result := decodeSqlResult(resp["result"])
	a.setCursor(req.ConnectionID, result.CursorID, result.More)
	if result.Kind == "rows" {
		a.workspace.Update(req.ConnectionID, func(w *WorkspaceState) {
			w.Rows = append(w.Rows, result.Rows...)
			w.CursorID = result.CursorID
			w.More = result.More
		})
	}
	return result, nil
}

// GetWorkspace returns the workspace state for a connection (window boot).
func (a *App) GetWorkspace(connectionID string) WorkspaceState {
	return a.workspace.GetWorkspace(connectionID)
}

// ListWorkspaces returns all workspaces (main window tab strip restore).
func (a *App) ListWorkspaces() []WorkspaceState {
	return a.workspace.ListWorkspaces()
}

// UpdateEditorText records the editor text for a connection (called on input).
func (a *App) UpdateEditorText(connectionID, text string) {
	a.workspace.Update(connectionID, func(w *WorkspaceState) {
		w.EditorText = text
	})
}

// UpdateMessagesHTML records the rendered messages list HTML for a connection.
func (a *App) UpdateMessagesHTML(connectionID, html string) {
	a.workspace.Update(connectionID, func(w *WorkspaceState) {
		w.MessagesHTML = html
	})
}

// UpdateStatusText records the status line for a connection.
func (a *App) UpdateStatusText(connectionID, text string) {
	a.workspace.Update(connectionID, func(w *WorkspaceState) {
		w.StatusText = text
	})
}

// DetachConnection opens a torn-off window for a connection. Native v3: a new
// WebviewWindow on the same process, sharing the bridge JVM and workspace
// store. The window's frontend boots into single-connection mode via the
// ?connection=<id> query parameter it reads at startup.
func (a *App) DetachConnection(connectionID, title string) error {
	a.mu.Lock()
	_, already := a.detached[connectionID]
	a.mu.Unlock()
	if already {
		return errors.New("connection already detached")
	}
	if a.app == nil {
		return errors.New("application not ready")
	}
	w := a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            title,
		Width:            980,
		Height:           700,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: application.NewRGB(30, 30, 30),
		URL:              "/?connection=" + connectionID,
	})
	a.mu.Lock()
	a.detached[connectionID] = w
	a.mu.Unlock()
	w.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
		a.mu.Lock()
		delete(a.detached, connectionID)
		a.mu.Unlock()
	})
	w.Show()
	return nil
}

// AttachConnection closes the torn-off window for a connection, if any.
func (a *App) AttachConnection(connectionID string) error {
	a.mu.Lock()
	w, ok := a.detached[connectionID]
	delete(a.detached, connectionID)
	a.mu.Unlock()
	if !ok || w == nil {
		return nil
	}
	w.Close()
	return nil
}

// ListDetached returns connectionIds currently shown in torn-off windows.
func (a *App) ListDetached() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, 0, len(a.detached))
	for id := range a.detached {
		out = append(out, id)
	}
	return out
}

func (a *App) setCursor(connID, cursorID string, more bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if st, ok := a.connections[connID]; ok {
		st.cursorID = cursorID
		st.hasCursor = more && cursorID != ""
	}
}

func (a *App) runCL(c *bridge.Client, connID, command string) (*CLResult, error) {
	resp, err := c.Call("executeCL", map[string]any{
		"connectionId": connID, "command": command,
	})
	if err != nil {
		return nil, err
	}
	raw, _ := resp["result"].(map[string]any)
	result := &CLResult{Kind: "cl", Command: command, OK: boolVal(raw["ok"]), ElapsedMs: int64Val(raw["elapsedMs"])}
	for _, m := range anySlice(raw["messages"]) {
		if mm, ok := m.(map[string]any); ok {
			sev := intVal(mm["severity"])
			typeName := str2(mm, "typeName")
			result.Messages = append(result.Messages, CLMessage{
				ID: str2(mm, "id"), Severity: sev, Type: intVal(mm["type"]),
				TypeName: typeName, Text: str2(mm, "text"),
				SecondLevelText: str2(mm, "secondLevelText"),
				Kind:            classifyCLMessage(sev, typeName),
			})
		}
	}
	return result, nil
}

// GetCmdXml returns the QCDRCMDD CMDD0200 XML for a command (cl-prompter source).
func (a *App) GetCmdXml(req GetCmdXmlRequest) (*CmdXmlResult, error) {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	cmd := strings.TrimSpace(req.Command)
	if cmd == "" {
		return nil, errors.New("command is required")
	}
	resp, err := c.Call("getCmdXml", map[string]any{
		"connectionId": req.ConnectionID, "command": cmd, "library": strings.TrimSpace(req.Library),
	})
	if err != nil {
		return nil, err
	}
	raw, _ := resp["result"].(map[string]any)
	return &CmdXmlResult{XML: str2(raw, "xml"), Bytes: intVal(raw["bytes"]), ElapsedMs: int64Val(raw["elapsedMs"])}, nil
}

// classifyCLMessage ports commandEntryModel.ts classifyMessage(). Severity is
// kept in the signature to mirror the reference; high-severity messages count
// as errors even if the type name is unrecognized.
func classifyCLMessage(severity int, typeName string) string {
	t := strings.ToUpper(strings.TrimSpace(typeName))
	if strings.Contains(t, "ESCAPE") || strings.Contains(t, "ERROR") || severity >= 30 {
		return "error"
	}
	if strings.Contains(t, "DIAG") || strings.Contains(t, "WARNING") {
		return "warning"
	}
	return "info"
}

func decodeSqlResult(v any) *SqlResult {
	raw, _ := v.(map[string]any)
	r := &SqlResult{Kind: str2(raw, "kind"), CursorID: str2(raw, "cursorId"), More: boolVal(raw["more"]), UpdateCount: int64Val(raw["updateCount"]), ElapsedMs: int64Val(raw["elapsedMs"])}
	for _, c := range anySlice(raw["columns"]) {
		if cm, ok := c.(map[string]any); ok {
			r.Columns = append(r.Columns, ColumnInfo{
				Name: str2(cm, "name"), Label: str2(cm, "label"),
				Type: intVal(cm["type"]), TypeName: str2(cm, "typeName"),
				Precision: intVal(cm["precision"]), Scale: intVal(cm["scale"]),
				DisplaySize: intVal(cm["displaySize"]), Nullable: boolVal(cm["nullable"]),
				AutoIncrement: boolVal(cm["autoIncrement"]),
				SchemaName:    str2(cm, "schemaName"), TableName: str2(cm, "tableName"),
			})
		}
	}
	for _, row := range anySlice(raw["rows"]) {
		if ra, ok := row.([]any); ok {
			r.Rows = append(r.Rows, ra)
		}
	}
	for _, m := range anySlice(raw["messages"]) {
		if mm, ok := m.(map[string]any); ok {
			r.Messages = append(r.Messages, SqlMessage{
				SQLState: str2(mm, "sqlState"), VendorCode: intVal(mm["vendorCode"]), Message: str2(mm, "message"),
			})
		}
	}
	if r.Kind == "error" {
		parts := []string{}
		for _, m := range r.Messages {
			if m.SQLState != "" {
				parts = append(parts, fmt.Sprintf("[%s] %s", m.SQLState, m.Message))
			} else {
				parts = append(parts, m.Message)
			}
		}
		r.Error = strings.Join(parts, "\n")
	}
	return r
}

func normalizeNaming(n string) string {
	if strings.EqualFold(n, "system") {
		return "system"
	}
	return "sql"
}

func str(m map[string]any, k string) string { return str2(m, k) }

func str2(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}

func boolVal(v any) bool {
	b, _ := v.(bool)
	return b
}

func intVal(v any) int { return int(int64Val(v)) }

func int64Val(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}

func anySlice(v any) []any {
	s, _ := v.([]any)
	return s
}
