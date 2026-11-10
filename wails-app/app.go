package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
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
	// BidiStringType: JT400 "bidi string type" JDBC property. "" = driver
	// default (no URL change). One of "-1","0","4","5","6","7","8","9","10","11".
	BidiStringType string `json:"bidiStringType,omitempty"`
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
	// SecondLevelText mirrors the IBM i message-file help (Cause/Recovery)
	// resolved by the bridge from QSQLMSG/QCPFMSG.
	SecondLevelText string `json:"secondLevelText,omitempty"`
	// Kind mirrors classifyMessage buckets: error/warning/info.
	Kind string `json:"kind"`
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

// Spooled Files (stage 1: list + filter).

type SpooledFileRequest struct {
	ConnectionID string `json:"connectionId"`
	OutqLib      string `json:"outqLib,omitempty"`
	Outq         string `json:"outq,omitempty"`
	User         string `json:"user,omitempty"`
	AllUsers     bool   `json:"allUsers,omitempty"`
	AllOutqs     bool   `json:"allOutqs,omitempty"`
	MaxRows      int    `json:"maxRows,omitempty"` // 0 = unlimited
}

type SpooledFileInfo struct {
	Name           string `json:"name"`
	Number         string `json:"number"`
	JobName        string `json:"jobName"`
	JobUser        string `json:"jobUser"`
	JobNumber      string `json:"jobNumber"`
	UserData       string `json:"userData"`
	OutqName       string `json:"outqName"`
	OutqLib        string `json:"outqLib"`
	CreateDate     string `json:"createDate"`
	CreateTime     string `json:"createTime"`
	Pages          int64  `json:"pages"`
	Size           int64  `json:"size"`
	Status         string `json:"status"`
	HoldStatus     string `json:"holdStatus"`
	Copies         int64  `json:"copies"`
	Printer        string `json:"printer"`
	PrinterDevType string `json:"printerDevType"`
	DeviceType     string `json:"deviceType"`
	CreatedBy      string `json:"createdBy"`
	Priority       string `json:"priority"`
	JobSystem      string `json:"jobSystem"`
	Lpi            string `json:"lpi"`
}

type SpooledFileResult struct {
	Kind      string            `json:"kind"`
	Files     []SpooledFileInfo `json:"files"`
	Truncated bool              `json:"truncated"`
	Cancelled bool              `json:"cancelled"`
	OpenMs    int64             `json:"openMs"`
	IterateMs int64             `json:"iterateMs"`
	ElapsedMs int64             `json:"elapsedMs"`
}

// SpooledFileTarget identifies one spooled file by its name/number/job triple.
type SpooledFileTarget struct {
	ConnectionID string `json:"connectionId"`
	Name         string `json:"name"`
	Number       string `json:"number"`
	JobName      string `json:"jobName"`
	JobUser      string `json:"jobUser"`
	JobNumber    string `json:"jobNumber"`
	DeviceType   string `json:"deviceType,omitempty"`
}

type SpooledFileActionRequest struct {
	SpooledFileTarget
	Action string `json:"action"` // hold | release | delete
}

type SpooledFileDataRequest struct {
	SpooledFileTarget
	Format     string `json:"format"`               // text | pdf | raw
	DeviceType string `json:"deviceType,omitempty"` // from the list row, e.g. *USERASCII
}

type SpooledFileMoveRequest struct {
	SpooledFileTarget
	ToLibrary string `json:"toLibrary"`
	ToQueue   string `json:"toQueue"`
	HoldFirst bool   `json:"holdFirst"`
}

type OutputQueueInfo struct {
	Name        string `json:"name"`
	Library     string `json:"library"`
	Description string `json:"description"`
}

type OutputQueueListRequest struct {
	ConnectionID  string `json:"connectionId"`
	NameFilter    string `json:"nameFilter"`
	LibraryFilter string `json:"libraryFilter"`
	Limit         int    `json:"limit"`
}

type OutputQueueListResult struct {
	Queues    []OutputQueueInfo `json:"queues"`
	ElapsedMs int64             `json:"elapsedMs"`
}

type SpooledFileActionResult struct {
	OK        bool   `json:"ok"`
	Message   string `json:"message"`
	ElapsedMs int64  `json:"elapsedMs"`
}

type SpooledFileDataResult struct {
	Kind        string   `json:"kind"`
	Format      string   `json:"format"`
	Bytes       int64    `json:"bytes"`
	Base64      string   `json:"base64"`
	ContentType string   `json:"contentType,omitempty"`
	Pages       []string `json:"pages,omitempty"`
	PageCount   int64    `json:"pageCount,omitempty"`
	ErrorCode   string   `json:"errorCode,omitempty"`
	Message     string   `json:"message,omitempty"`
	ElapsedMs   int64    `json:"elapsedMs"`
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
	// BidiStringType: JT400 "bidi string type" for hosts storing Arabic/Hebrew
	// (CCSID 420/424 etc.). "" = driver default; no JDBC URL change when unset.
	BidiStringType string `json:"bidiStringType,omitempty"`
	SavePassword   bool   `json:"savePassword,omitempty"`
	// PreloadSpool: fetch the spooled-file list at connect (default on).
	PreloadSpool *bool `json:"preloadSpool,omitempty"`
	// Script: SQL/CL text saved with the profile; restored into the editor on
	// connect when set. SaveScript gates the auto-save (default on).
	Script      string `json:"script,omitempty"`
	SaveScript  *bool  `json:"saveScript,omitempty"`
	PasswordB64 string `json:"passwordB64,omitempty"`
	LastUsedAt  int64  `json:"lastUsedAt"`
	// PinnedAt is set by "Move to top": the stable list position override.
	PinnedAt int64 `json:"pinnedAt,omitempty"`
	// SortOrder is the user's explicit list position (lower = earlier). Set by
	// drag reorder and A-Z sort in the Connections pane; 0 = not ordered.
	SortOrder int `json:"sortOrder,omitempty"`
}

// profileOrderThreshold: at or below this many saved profiles the dropdown
// shows a stable order (pinned first, then alphabetical) instead of MRU —
// with only a few connections, last-used-first makes them moving targets.
// Above the threshold the UI shows a Word-style recently-used section on top.
const profileOrderThreshold = 5

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
	// pinnedWins maps "connectionId/pinId" -> read-only pinned-result window.
	pinnedWins map[string]*application.WebviewWindow
}

type connState struct {
	id        string
	host      string
	user      string
	cursorID  string
	hasCursor bool
}

// ConnectionIdentity is the live host/user for a connection (used by the
// frontend to key per-connection state like the saved script).
type ConnectionIdentity struct {
	Host string `json:"host"`
	User string `json:"user"`
}

// GetConnectionIdentity returns the live host/user for a connection.
func (a *App) GetConnectionIdentity(connectionID string) (ConnectionIdentity, error) {
	a.mu.Lock()
	c := a.connections[connectionID]
	a.mu.Unlock()
	if c == nil {
		return ConnectionIdentity{}, errors.New("not connected")
	}
	return ConnectionIdentity{Host: c.host, User: c.user}, nil
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
	// Close any popped-out pinned-result windows so they don't outlive the app.
	a.CloseAllPinnedWindows()
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
	return filepath.Join(dir, "ibmi-runsql", "connections.json")
}

// --- App settings (spool download dir, ...; persisted next to profiles) ---

type AppSettings struct {
	SpoolDownloadDir    string `json:"spoolDownloadDir,omitempty"`
	ScriptsDir          string `json:"scriptsDir,omitempty"`
	FetchSize           int    `json:"fetchSize,omitempty"`
	AutoOpenDownloads   *bool  `json:"autoOpenDownloads,omitempty"`   // legacy; superseded by SpoolDblClickAction
	SpoolDblClickAction string `json:"spoolDblClickAction,omitempty"` // view | dlPdf | dlText | print ("" = view)
	DefaultNaming       string `json:"defaultNaming,omitempty"`       // sql | system ("" = sql)
	SpoolMaxRows        int    `json:"spoolMaxRows,omitempty"`        // 0 = unlimited
	ConfirmSpoolDelete  *bool  `json:"confirmSpoolDelete,omitempty"`  // nil = on
}

func settingsStorePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "ibmi-runsql", "settings.json")
}

func loadAppSettings() AppSettings {
	var s AppSettings
	data, err := os.ReadFile(settingsStorePath())
	if err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

func saveAppSettings(s AppSettings) error {
	path := settingsStorePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// GetAppSettings returns the persisted app settings for the Settings pane.
func (a *App) GetAppSettings() (AppSettings, error) {
	return loadAppSettings(), nil
}

// SetAppSetting persists one settings key. Unknown keys are rejected; values
// are validated here so the frontend editors stay dumb.
func (a *App) SetAppSetting(key, value string) error {
	s := loadAppSettings()
	switch key {
	case "spoolDownloadDir":
		d := strings.TrimSpace(value)
		if d != "" {
			info, err := os.Stat(d)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return fmt.Errorf("not a directory: %s", d)
			}
		}
		s.SpoolDownloadDir = d
	case "scriptsDir":
		d := strings.TrimSpace(value)
		if d != "" {
			info, err := os.Stat(d)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return fmt.Errorf("not a directory: %s", d)
			}
		}
		s.ScriptsDir = d
	case "fetchSize":
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 10 || n > 10000 {
			return fmt.Errorf("fetch size must be 10-10000")
		}
		s.FetchSize = n
	case "autoOpenDownloads":
		on := strings.EqualFold(strings.TrimSpace(value), "on") || value == "true"
		s.AutoOpenDownloads = &on
	case "spoolDblClickAction":
		switch strings.TrimSpace(value) {
		case "", "view", "dlPdf", "dlText", "print":
			s.SpoolDblClickAction = strings.TrimSpace(value)
		default:
			return fmt.Errorf("invalid double-click action: %s", value)
		}
	case "defaultNaming":
		switch strings.TrimSpace(value) {
		case "", "sql", "system":
			s.DefaultNaming = strings.TrimSpace(value)
		default:
			return fmt.Errorf("invalid naming mode: %s", value)
		}
	case "spoolMaxRows":
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 0 || n > 100000 {
			return fmt.Errorf("spool row cap must be 0-100000 (0 = unlimited)")
		}
		s.SpoolMaxRows = n
	case "confirmSpoolDelete":
		on := strings.EqualFold(strings.TrimSpace(value), "on") || value == "true"
		s.ConfirmSpoolDelete = &on
	default:
		return fmt.Errorf("unknown setting: %s", key)
	}
	return saveAppSettings(s)
}

// defaultDownloadsDir is the per-OS "Downloads" folder. Windows asks the shell
// for the localized FOLDERID_Downloads (not always <profile>\Downloads); other
// OSes fall back to ~/Downloads when it exists, else the home dir.
func defaultDownloadsDir() string {
	if runtime.GOOS == "windows" {
		// guid known-folder FOLDERID_Downloads.
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
			`(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path`).Output()
		if err == nil {
			if p := strings.TrimSpace(string(out)); p != "" {
				return p
			}
		}
		if pd := os.Getenv("USERPROFILE"); pd != "" {
			return filepath.Join(pd, "Downloads")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	dl := filepath.Join(home, "Downloads")
	if info, err := os.Stat(dl); err == nil && info.IsDir() {
		return dl
	}
	return home
}

// spoolDownloadDir resolves the target folder for spooled-file downloads.
func spoolDownloadDir() string {
	if d := strings.TrimSpace(loadAppSettings().SpoolDownloadDir); d != "" {
		return d
	}
	return defaultDownloadsDir()
}

// scriptsDir resolves the default folder for .sql script Open/Save As dialogs.
// Falls back to the spool download dir when unset so behavior is unchanged
// for anyone who never configures it.
func scriptsDir() string {
	if d := strings.TrimSpace(loadAppSettings().ScriptsDir); d != "" {
		return d
	}
	return spoolDownloadDir()
}

// openInFileManager shows a file or folder in the OS file manager.
func openInFileManager(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		// rundll32 url.dll,FileProtocolHandler handles both files and folders.
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	return cmd.Start()
}

// OpenSpoolDownloadDir opens the configured spool download folder in the OS
// file manager.
func (a *App) OpenSpoolDownloadDir() error {
	dir := spoolDownloadDir()
	if _, err := os.Stat(dir); err != nil {
		return err
	}
	return openInFileManager(dir)
}

// DefaultSpoolDownloadDir returns the OS default download folder (used by the
// Settings folder editor's browse helper).
func (a *App) DefaultSpoolDownloadDir() (string, error) {
	return defaultDownloadsDir(), nil
}

// PickDirectory opens the OS-native folder picker (Finder/Explorer/Qt) and
// returns the chosen path; empty string means canceled.
func (a *App) PickDirectory(title string) (string, error) {
	if a.app == nil || a.app.Dialog == nil {
		return "", errors.New("dialogs unavailable")
	}
	dlg := a.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseDirectories:            true,
		CanChooseFiles:                  false,
		CanCreateDirectories:            true,
		TreatsFilePackagesAsDirectories: true,
		Title:                           title,
	})
	return dlg.PromptForSingleSelection()
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
	sortProfiles(profiles)
	return profiles, nil
}

// sortProfiles orders profiles for the dropdown:
//   - Explicit SortOrder (drag/A-Z in the Connections pane) wins outright.
//   - Pinned (Move-to-top) entries come next, most recently pinned first.
//   - With <= profileOrderThreshold unordered profiles, the rest keep creation
//     order (FILO) so a handful of connections never becomes a moving target.
//   - Above the threshold, the rest stay MRU (LastUsedAt desc); the frontend
//     splits that into recently-used (top 5) + separator + remainder.
func sortProfiles(profiles []ConnectionProfile) {
	sort.SliceStable(profiles, func(i, j int) bool {
		soi, soj := profiles[i].SortOrder, profiles[j].SortOrder
		if (soi > 0) != (soj > 0) {
			return soi > 0
		}
		if soi > 0 && soj > 0 {
			return soi < soj
		}
		pi, pj := profiles[i].PinnedAt, profiles[j].PinnedAt
		if (pi > 0) != (pj > 0) {
			return pi > 0
		}
		if pi > 0 && pj > 0 {
			return pi > pj
		}
		if len(profiles) <= profileOrderThreshold {
			return false // keep file (creation) order
		}
		return profiles[i].LastUsedAt > profiles[j].LastUsedAt
	})
}

// ReorderConnectionProfiles applies an explicit list order: names are the
// connection names in the desired sequence; each gets SortOrder 1..N. Profiles
// not named keep their relative order after the named ones. Clears PinnedAt
// (explicit order replaces pinning).
func (a *App) ReorderConnectionProfiles(names []string) error {
	profiles, err := loadProfiles()
	if err != nil {
		return err
	}
	rank := map[string]int{}
	for i, n := range names {
		rank[strings.ToLower(strings.TrimSpace(n))] = i + 1
	}
	for i := range profiles {
		if r, ok := rank[strings.ToLower(profiles[i].Name)]; ok {
			profiles[i].SortOrder = r
			profiles[i].PinnedAt = 0
		} else {
			profiles[i].SortOrder = 0
		}
	}
	return saveProfiles(profiles)
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

// ListConnectionProfiles returns all saved connection profiles. Legacy
// base64 passwords are migrated into the OS credential vault on first read
// and scrubbed from the file when migration succeeds.
func (a *App) ListConnectionProfiles() ([]ConnectionProfile, error) {
	profiles, err := loadProfiles()
	if err != nil {
		return nil, err
	}
	migrated := false
	for i := range profiles {
		if migrateLegacyPassword(&profiles[i]) {
			migrated = true
		}
	}
	if migrated {
		_ = saveProfiles(profiles)
	}
	return profiles, nil
}

// GetProfilePassword returns the stored password for a profile (OS vault
// first, legacy base64 second). Used by the Quick Connect form to prefill.
func (a *App) GetProfilePassword(name string) (string, error) {
	profiles, err := loadProfiles()
	if err != nil {
		return "", err
	}
	for _, p := range profiles {
		if strings.EqualFold(p.Name, name) || strings.EqualFold(p.Host, name) {
			if pw := loadPassword(p.Host, p.User); pw != "" {
				return pw, nil
			}
			// Legacy in-file base64 (pre-vault, or no vault on this machine).
			if p.PasswordB64 != "" {
				raw, err := base64.StdEncoding.DecodeString(p.PasswordB64)
				if err == nil {
					return string(raw), nil
				}
			}
			return "", nil
		}
	}
	return "", nil
}

// mergeProfile folds p into profiles: host+user match replaces in place,
// preserving name/ordering/password when p carries only the auto-save
// defaults (name == host, no password). Returns (updated slice, replaced).
func mergeProfile(profiles []ConnectionProfile, p ConnectionProfile) ([]ConnectionProfile, bool) {
	for i, existing := range profiles {
		if strings.EqualFold(existing.Host, p.Host) && strings.EqualFold(existing.User, p.User) {
			// Password carries over whenever the incoming profile doesn't
			// explicitly clear it (SavePassword=false means "don't store").
			if p.PasswordB64 == "" && p.SavePassword {
				p.PasswordB64 = existing.PasswordB64
			}
			if strings.EqualFold(p.Name, p.Host) && !strings.EqualFold(existing.Name, existing.Host) {
				p.Name = existing.Name
			}
			p.PinnedAt = existing.PinnedAt
			p.SortOrder = existing.SortOrder
			profiles[i] = p
			return profiles, true
		}
	}
	return append(profiles, p), false
}

// SaveConnectionProfile upserts a profile keyed by host+user, refreshing
// LastUsedAt; list ordering is decided by sortProfiles at read time.
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
	// Vault first: passwords live in the OS credential store, not the file.
	if p.SavePassword && p.PasswordB64 != "" {
		raw, err := base64.StdEncoding.DecodeString(p.PasswordB64)
		if err == nil && len(raw) > 0 {
			if storePassword(p.Host, p.User, string(raw)) == nil {
				p.PasswordB64 = "" // scrub the in-file copy
			}
		}
	}
	if !p.SavePassword {
		p.PasswordB64 = ""
		deletePassword(p.Host, p.User)
	}
	profiles, err := loadProfiles()
	if err != nil {
		return err
	}
	profiles, _ = mergeProfile(profiles, p)
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
		if strings.EqualFold(p.Name, name) || strings.EqualFold(p.Host, name) {
			deletePassword(p.Host, p.User) // scrub the vault too
			continue
		}
		out = append(out, p)
	}
	return saveProfiles(out)
}

// UpdateConnectionProfile replaces the profile identified by origName with p
// (rename-safe, unlike the host+user-keyed SaveConnectionProfile). Created-
// order fields (LastUsedAt/PinnedAt) and a stored password are preserved.
func (a *App) UpdateConnectionProfile(origName string, p ConnectionProfile) error {
	p.Host = strings.TrimSpace(p.Host)
	if p.Host == "" {
		return errors.New("host is required")
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		p.Name = p.Host
	}
	if !p.SavePassword {
		p.PasswordB64 = ""
	}
	profiles, err := loadProfiles()
	if err != nil {
		return err
	}
	for i, existing := range profiles {
		if strings.EqualFold(existing.Name, origName) || strings.EqualFold(existing.Host, origName) {
			p.LastUsedAt = existing.LastUsedAt
			p.PinnedAt = existing.PinnedAt
			p.SortOrder = existing.SortOrder
			// Guard: never let an update collapse a custom display name back to
			// the host (auto-save/script-save callers rebuild from the form).
			if strings.EqualFold(p.Name, p.Host) && !strings.EqualFold(existing.Name, existing.Host) {
				p.Name = existing.Name
			}
			// Vault first; carry the legacy in-file password only when the vault
			// has nothing (no vault on this machine).
			if !p.SavePassword {
				deletePassword(existing.Host, existing.User)
				if existing.Host != p.Host || existing.User != p.User {
					deletePassword(p.Host, p.User)
				}
				p.PasswordB64 = ""
			} else if p.PasswordB64 != "" {
				raw, err := base64.StdEncoding.DecodeString(p.PasswordB64)
				if err == nil && len(raw) > 0 {
					if storePassword(p.Host, p.User, string(raw)) == nil {
						p.PasswordB64 = ""
					}
				}
			} else {
				// No new password typed: preserve the legacy in-file copy only
				// when the vault is empty for this profile.
				if loadPassword(p.Host, p.User) == "" {
					p.PasswordB64 = existing.PasswordB64
				}
			}
			profiles[i] = p
			return saveProfiles(profiles)
		}
	}
	// Unknown original name: treat as a new profile.
	p.LastUsedAt = time.Now().Unix()
	profiles = append(profiles, p)
	return saveProfiles(profiles)
}

// MoveConnectionProfileToTop pins a profile at the top of the dropdown.
func (a *App) MoveConnectionProfileToTop(name string) error {
	profiles, err := loadProfiles()
	if err != nil {
		return err
	}
	for i, p := range profiles {
		if strings.EqualFold(p.Name, name) || strings.EqualFold(p.Host, name) {
			profiles[i].PinnedAt = time.Now().Unix()
			return saveProfiles(profiles)
		}
	}
	return errors.New("profile not found: " + name)
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
		"fetchSize": fetchSize, "bidiStringType": strings.TrimSpace(req.BidiStringType),
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

// UpdatePinnedResults replaces the pinned (retained) result sets for a
// connection so torn-off windows and reattach render the same pinned tabs.
func (a *App) UpdatePinnedResults(connectionID string, pinned []PinnedResult) {
	a.workspace.Update(connectionID, func(w *WorkspaceState) {
		w.PinnedResults = pinned
	})
}

// OpenPinnedWindow opens a read-only grid window showing one pinned result.
// The snapshot (columns+rows) is passed wholesale in the URL query, so the
// window is fully static — no connection, cursor, or workspace involvement.
// Re-clicking an already-open pin focuses its window instead of duplicating.
func (a *App) OpenPinnedWindow(connectionID, pinID, title string) error {
	if a.app == nil {
		return errors.New("application not ready")
	}
	key := connectionID + "/" + pinID
	a.mu.Lock()
	if existing, ok := a.pinnedWins[key]; ok && existing != nil {
		a.mu.Unlock()
		existing.Focus()
		return nil
	}
	a.mu.Unlock()
	// Pull the frozen snapshot to embed in the URL (self-contained window).
	var snap *PinnedResult
	ws := a.workspace.GetWorkspace(connectionID)
	for _, p := range ws.PinnedResults {
		if p.ID == pinID {
			cp := p
			snap = &cp
			break
		}
	}
	if snap == nil {
		return fmt.Errorf("pinned result not found: %s", pinID)
	}
	label := snap.Label
	if title != "" {
		label = title
	}
	// Encode the snapshot so the window renders standalone (no connection).
	payload, err := json.Marshal(map[string]any{
		"label": label, "columns": snap.Columns, "rows": snap.Rows,
	})
	if err != nil {
		return err
	}
	w := a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            label,
		Width:            900,
		Height:           640,
		MinWidth:         480,
		MinHeight:        320,
		BackgroundColour: application.NewRGB(30, 30, 30),
		URL:              "/pinned.html?data=" + url.QueryEscape(base64.StdEncoding.EncodeToString(payload)),
	})
	a.mu.Lock()
	if a.pinnedWins == nil {
		a.pinnedWins = map[string]*application.WebviewWindow{}
	}
	a.pinnedWins[key] = w
	a.mu.Unlock()
	w.OnWindowEvent(events.Mac.WindowShouldClose, func(e *application.WindowEvent) {
		w.Close()
	})
	w.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
		a.mu.Lock()
		delete(a.pinnedWins, key)
		a.mu.Unlock()
		// Tell the main window this pinned result's pop-out closed so it can
		// restore the subtab (pop-out moves the pin into the window).
		if a.app != nil {
			a.app.Event.Emit("pinned:closed", map[string]string{"connectionId": connectionID, "pinId": pinID})
		}
	})
	w.Show()
	return nil
}

// CloseAllPinnedWindows closes every open pinned-result pop-out window. Called
// from the frontend button and from ServiceShutdown so popped-out windows never
// outlive the app.
func (a *App) CloseAllPinnedWindows() {
	a.mu.Lock()
	wins := a.pinnedWins
	a.pinnedWins = map[string]*application.WebviewWindow{}
	a.mu.Unlock()
	for _, w := range wins {
		if w != nil {
			w.Close()
		}
	}
}

// ClosePinnedWindowsFor closes only the popped-out pinned windows belonging to
// one connection, leaving the pinned subtabs (and their data) intact. Each
// window's WindowClosing handler emits pinned:closed, so the main window
// restores those subtabs.
func (a *App) ClosePinnedWindowsFor(connectionID string) {
	a.mu.Lock()
	var wins []*application.WebviewWindow
	for key, w := range a.pinnedWins {
		if strings.HasPrefix(key, connectionID+"/") {
			if w != nil {
				wins = append(wins, w)
			}
			delete(a.pinnedWins, key)
		}
	}
	a.mu.Unlock()
	for _, w := range wins {
		w.Close()
	}
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
	// macOS user close only emits WindowShouldClose; call Close() so the
	// window actually closes (same reasoning as the main window).
	w.OnWindowEvent(events.Mac.WindowShouldClose, func(e *application.WindowEvent) {
		w.Close()
	})
	w.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
		a.mu.Lock()
		delete(a.detached, connectionID)
		a.mu.Unlock()
	})
	w.Show()
	return nil
}

// AttachConnection closes the torn-off window for a connection, if any, and
// asks the main window to re-absorb it as a tab (ignored by detached windows).
func (a *App) AttachConnection(connectionID string) error {
	a.mu.Lock()
	w, ok := a.detached[connectionID]
	delete(a.detached, connectionID)
	a.mu.Unlock()
	if !ok || w == nil {
		return nil
	}
	if a.app != nil {
		a.app.Event.Emit("workspace:reattach", map[string]string{"connectionId": connectionID})
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

// ListSpooledFiles lists spooled files on the connection, filtered by user
// and/or output queue (blank user = *CURRENT; allUsers/allOutqs widen scope).
func (a *App) ListSpooledFiles(req SpooledFileRequest) (*SpooledFileResult, error) {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	resp, err := c.Call("listSpooledFiles", map[string]any{
		"connectionId": req.ConnectionID,
		"outqLib":      strings.TrimSpace(req.OutqLib),
		"outq":         strings.TrimSpace(req.Outq),
		"user":         strings.TrimSpace(req.User),
		"allUsers":     req.AllUsers,
		"allOutqs":     req.AllOutqs,
		"maxRows":      req.MaxRows,
	})
	if err != nil {
		return nil, err
	}
	raw, _ := resp["result"].(map[string]any)
	result := &SpooledFileResult{Kind: str2(raw, "kind"), OpenMs: int64Val(raw["openMs"]),
		IterateMs: int64Val(raw["iterateMs"]), ElapsedMs: int64Val(raw["elapsedMs"]),
		Truncated: boolVal(raw["truncated"]), Cancelled: boolVal(raw["cancelled"])}
	for _, f := range anySlice(raw["files"]) {
		if fm, ok := f.(map[string]any); ok {
			result.Files = append(result.Files, SpooledFileInfo{
				Name: str2(fm, "name"), Number: str2(fm, "number"),
				JobName: str2(fm, "jobName"), JobUser: str2(fm, "jobUser"), JobNumber: str2(fm, "jobNumber"),
				UserData: str2(fm, "userData"), OutqName: str2(fm, "outqName"), OutqLib: str2(fm, "outqLib"),
				CreateDate: str2(fm, "createDate"), CreateTime: str2(fm, "createTime"),
				Pages: int64Val(fm["pages"]), Size: int64Val(fm["size"]),
				Status: str2(fm, "status"), HoldStatus: str2(fm, "holdStatus"),
				Copies: int64Val(fm["copies"]), Printer: str2(fm, "printer"), PrinterDevType: str2(fm, "printerDevType"),
				DeviceType: str2(fm, "deviceType"),
				CreatedBy:  str2(fm, "createdBy"), Priority: str2(fm, "priority"), JobSystem: str2(fm, "jobSystem"), Lpi: str2(fm, "lpi"),
			})
		}
	}
	return result, nil
}

// CancelSpoolList asks the bridge to stop an in-flight spooled-file list for
// the connection (closes the host open list; best effort).
func (a *App) CancelSpoolList(connectionID string) error {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[connectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return errors.New("not connected")
	}
	_, err := c.Call("cancelSpoolList", map[string]any{"connectionId": connectionID})
	return err
}

// spoolTargetParams maps a SpooledFileTarget to bridge call params.
func spoolTargetParams(t SpooledFileTarget) map[string]any {
	return map[string]any{
		"connectionId": t.ConnectionID, "name": t.Name, "number": t.Number,
		"jobName": t.JobName, "jobUser": t.JobUser, "jobNumber": t.JobNumber,
		"devType": t.DeviceType,
	}
}

// SpooledFileAction runs hold/release/delete on one spooled file.
func (a *App) SpooledFileAction(req SpooledFileActionRequest) (*SpooledFileActionResult, error) {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	params := spoolTargetParams(req.SpooledFileTarget)
	params["action"] = strings.TrimSpace(req.Action)
	resp, err := c.Call("spooledFileAction", params)
	if err != nil {
		return nil, err
	}
	raw, _ := resp["result"].(map[string]any)
	return &SpooledFileActionResult{
		OK: boolVal(raw["ok"]), Message: str2(raw, "message"), ElapsedMs: int64Val(raw["elapsedMs"]),
	}, nil
}

// GetSpooledFileData reads a spooled file's content (text or PDF transform),
// base64-encoded.
func (a *App) GetSpooledFileData(req SpooledFileDataRequest) (*SpooledFileDataResult, error) {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	params := spoolTargetParams(req.SpooledFileTarget)
	params["format"] = strings.TrimSpace(req.Format)
	resp, err := c.Call("getSpooledFileData", params)
	if err != nil {
		return nil, err
	}
	raw, _ := resp["result"].(map[string]any)
	pages := []string{}
	if arr, ok := raw["pages"].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok {
				pages = append(pages, s)
			}
		}
	}
	return &SpooledFileDataResult{
		Kind: str2(raw, "kind"), Format: str2(raw, "format"), Bytes: int64Val(raw["bytes"]),
		Base64: str2(raw, "base64"), ContentType: str2(raw, "contentType"), Pages: pages,
		PageCount: int64Val(raw["pageCount"]), ErrorCode: str2(raw, "errorCode"),
		Message: str2(raw, "message"), ElapsedMs: int64Val(raw["elapsedMs"]),
	}, nil
}

// MoveSpooledFile moves a spooled file to another output queue.
func (a *App) MoveSpooledFile(req SpooledFileMoveRequest) (*SpooledFileActionResult, error) {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	params := spoolTargetParams(req.SpooledFileTarget)
	params["toLibrary"] = strings.TrimSpace(req.ToLibrary)
	params["toQueue"] = strings.TrimSpace(req.ToQueue)
	params["holdFirst"] = req.HoldFirst
	resp, err := c.Call("moveSpooledFile", params)
	if err != nil {
		return nil, err
	}
	raw, _ := resp["result"].(map[string]any)
	return &SpooledFileActionResult{
		OK: boolVal(raw["ok"]), Message: str2(raw, "message"), ElapsedMs: int64Val(raw["elapsedMs"]),
	}, nil
}

// ListOutputQueues lists output queues matching optional name/library filters,
// capped at limit (default 200) so large systems don't flood the picker.
func (a *App) ListOutputQueues(req OutputQueueListRequest) (*OutputQueueListResult, error) {
	a.mu.Lock()
	c := a.client
	_, known := a.connections[req.ConnectionID]
	a.mu.Unlock()
	if c == nil || !known {
		return nil, errors.New("not connected")
	}
	limit := req.Limit
	if limit <= 0 {
		limit = 200
	}
	resp, err := c.Call("listOutputQueues", map[string]any{
		"connectionId":  req.ConnectionID,
		"nameFilter":    strings.TrimSpace(req.NameFilter),
		"libraryFilter": strings.TrimSpace(req.LibraryFilter),
		"limit":         limit,
	})
	if err != nil {
		return nil, err
	}
	raw, _ := resp["result"].(map[string]any)
	queues := []OutputQueueInfo{}
	if arr, ok := raw["queues"].([]any); ok {
		for _, item := range arr {
			if m, ok := item.(map[string]any); ok {
				queues = append(queues, OutputQueueInfo{
					Name: str2(m, "name"), Library: str2(m, "library"), Description: str2(m, "description"),
				})
			}
		}
	}
	return &OutputQueueListResult{Queues: queues, ElapsedMs: int64Val(raw["elapsedMs"])}, nil
}

// SaveSpooledFile writes base64 content to the configured download folder
// (~/Downloads by default), returning the saved path. Filenames are
// sanitized to a safe basename.
func (a *App) SaveSpooledFile(filename, base64Data string) (string, error) {
	base := filepath.Base(strings.TrimSpace(filename))
	if base == "" || base == "." {
		return "", errors.New("filename is required")
	}
	raw, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	out := filepath.Join(spoolDownloadDir(), base)
	if err := os.WriteFile(out, raw, 0o600); err != nil {
		return "", err
	}
	return out, nil
}

// SaveFileAs prompts with the OS-native Save dialog (default name/folder, file
// filter for the chosen format) and writes base64 content to the chosen path.
// Returns "" when the user cancels.
func (a *App) SaveFileAs(filename, base64Data, filterLabel, filterPattern string) (string, error) {
	if a.app == nil || a.app.Dialog == nil {
		return "", errors.New("dialogs unavailable")
	}
	raw, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	opts := &application.SaveFileDialogOptions{
		CanCreateDirectories: true,
		Title:                "Save Results",
		Filename:             filename,
		Directory:            spoolDownloadDir(),
	}
	// .sql scripts honor the separate Scripts folder setting.
	if filterPattern == "*.sql" {
		opts.Title = "Save SQL Script As"
		opts.Directory = scriptsDir()
	}
	if filterLabel != "" && filterPattern != "" {
		opts.Filters = []application.FileFilter{{DisplayName: filterLabel, Pattern: filterPattern}}
	}
	dlg := a.app.Dialog.SaveFileWithOptions(opts)
	path, err := dlg.PromptForSingleSelection()
	if err != nil || strings.TrimSpace(path) == "" {
		return "", err // canceled or failed
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// OpenFileAs prompts with the OS-native Open dialog and returns the file's
// contents as text (for loading a .sql script into the editor). "" = canceled.
func (a *App) OpenFileAs(filterLabel, filterPattern string) (string, error) {
	if a.app == nil || a.app.Dialog == nil {
		return "", errors.New("dialogs unavailable")
	}
	opts := &application.OpenFileDialogOptions{
		CanChooseFiles:       true,
		CanChooseDirectories: false,
		Title:                "Open SQL Script",
		Directory:            scriptsDir(),
	}
	if filterLabel != "" && filterPattern != "" {
		opts.Filters = []application.FileFilter{{DisplayName: filterLabel, Pattern: filterPattern}}
	}
	dlg := a.app.Dialog.OpenFileWithOptions(opts)
	path, err := dlg.PromptForSingleSelection()
	if err != nil || strings.TrimSpace(path) == "" {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	// Return path + text so the caller can track the file for Save As prefill.
	return path + "\n" + string(data), nil
}

// PrintSpooledFile saves the PDF bytes to a temp file and opens it with the OS
// default handler, which surfaces the print dialog for a PDF on macOS.
func (a *App) PrintSpooledFile(filename, base64Data string) (string, error) {
	base := filepath.Base(strings.TrimSpace(filename))
	if base == "" || base == "." {
		base = "spooled-file.pdf"
	}
	if !strings.HasSuffix(strings.ToLower(base), ".pdf") {
		base += ".pdf"
	}
	raw, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	tmp := filepath.Join(os.TempDir(), base)
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return "", err
	}
	// OS file association handles the PDF (Preview's print flow on macOS).
	if err := openInFileManager(tmp); err != nil {
		return "", err
	}
	return tmp, nil
}

// OpenSpooledFile opens a previously saved spooled-file download with the OS
// default handler so the user can view it.
func (a *App) OpenSpooledFile(path string) error {
	p := strings.TrimSpace(path)
	if p == "" {
		return errors.New("path is required")
	}
	return openInFileManager(p)
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
				SecondLevelText: str2(mm, "secondLevelText"), Kind: str2(mm, "kind"),
			})
		}
	}
	if r.Kind == "error" {
		parts := []string{}
		for i := range r.Messages {
			m := &r.Messages[i]
			if m.Kind == "" {
				m.Kind = sqlMessageKind(m.SQLState)
			}
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

// sqlMessageKind classifies by SQLState class: 00 success, 01 warning, 02
// no-data (info); everything else is an error. Empty state on an error result
// is still an error (caller context decides).
func sqlMessageKind(sqlState string) string {
	switch {
	case strings.HasPrefix(sqlState, "01"):
		return "warning"
	case sqlState == "02" || strings.HasPrefix(sqlState, "020"):
		return "info"
	default:
		return "error"
	}
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
