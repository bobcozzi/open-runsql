package main

import (
	"bytes"
	"embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed embed/ibmi-jdbc-bridge.jar
var jarFS embed.FS

// resolveJar: honor IBMI_JDBC_BRIDGE_JAR when set; otherwise extract the
// embedded jar to the user cache dir and use that path. The cached copy is
// re-extracted whenever it differs from the embedded one, so an app upgrade
// can never keep running a stale bridge jar.
func resolveJar() string {
	if j := os.Getenv("IBMI_JDBC_BRIDGE_JAR"); j != "" {
		return j
	}
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	out := filepath.Join(dir, "ibmi-runsql", "ibmi-jdbc-bridge.jar")
	data, err := jarFS.ReadFile("embed/ibmi-jdbc-bridge.jar")
	if err != nil {
		return ""
	}
	if existing, err := os.ReadFile(out); err == nil && bytes.Equal(existing, data) {
		return out
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return ""
	}
	if err := os.WriteFile(out, data, 0o644); err != nil {
		return ""
	}
	return out
}

func main() {
	jar := resolveJar()
	if jar == "" {
		fmt.Fprintln(os.Stderr, "could not resolve the JDBC bridge jar")
		os.Exit(1)
	}

	app := application.New(application.Options{
		Name:        "ibmi-runsql",
		Description: "IBM i Run SQL Scripts",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	svc := NewApp(jar)
	svc.app = app
	app.RegisterService(application.NewService(svc))

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "IBM i Run SQL",
		Width:            1180,
		Height:           780,
		MinWidth:         860,
		MinHeight:        560,
		BackgroundColour: application.NewRGB(30, 30, 30),
	})
	// macOS user close (red button / Cmd+W) only emits WindowShouldClose and
	// leaves the window open unless the app calls Close() — without this the
	// process keeps running with no window and relaunches appear to "do
	// nothing". Close() emits WindowClosing, whose default handler destroys
	// the window; ApplicationShouldTerminateAfterLastWindowClosed then quits
	// the app when the last window goes away.
	window.OnWindowEvent(events.Mac.WindowShouldClose, func(e *application.WindowEvent) {
		window.Close()
	})
	// Closing the MAIN window ends the session: close any popped-out pinned
	// windows too so they don't outlive the app. (ServiceShutdown also covers
	// this, but only runs at process quit — which a stray pinned window would
	// otherwise postpone under ApplicationShouldTerminateAfterLastWindowClosed.)
	window.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
		svc.CloseAllPinnedWindows()
	})
	window.Center()
	window.Show()

	if err := app.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "wails run failed:", err)
		os.Exit(1)
	}
}
