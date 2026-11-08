package main

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed embed/ibmi-jdbc-bridge.jar
var jarFS embed.FS

// resolveJar: honor IBMI_JDBC_BRIDGE_JAR when set; otherwise extract the
// embedded jar to the user cache dir once and use that path.
func resolveJar() string {
	if j := os.Getenv("IBMI_JDBC_BRIDGE_JAR"); j != "" {
		return j
	}
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	out := filepath.Join(dir, "ibmi-runsql", "ibmi-jdbc-bridge.jar")
	if _, err := os.Stat(out); err == nil {
		return out
	}
	data, err := jarFS.ReadFile("embed/ibmi-jdbc-bridge.jar")
	if err != nil {
		return ""
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
	window.Center()
	window.Show()

	if err := app.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "wails run failed:", err)
		os.Exit(1)
	}
}
