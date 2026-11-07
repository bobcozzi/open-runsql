package main

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	var windowConn, windowTitle string
	for i, arg := range os.Args {
		if arg == "--window" && i+1 < len(os.Args) {
			windowConn = os.Args[i+1]
		}
		if strings.HasPrefix(arg, "--window=") {
			windowConn = strings.TrimPrefix(arg, "--window=")
		}
		if strings.HasPrefix(arg, "--title=") {
			windowTitle = strings.TrimPrefix(arg, "--title=")
		}
	}

	jar := os.Getenv("IBMI_JDBC_BRIDGE_JAR")
	if jar == "" {
		exe, err := os.Executable()
		base := "."
		if err == nil {
			base = filepath.Dir(exe)
		}
		candidates := []string{
			filepath.Join(base, "ibmi-jdbc-bridge.jar"),
			filepath.Join(base, "..", "java-bridge", "target", "ibmi-jdbc-bridge.jar"),
			filepath.Join("..", "java-bridge", "target", "ibmi-jdbc-bridge.jar"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				jar = c
				break
			}
		}
	}

	app := application.New(application.Options{
		Name:        "ibmi-run-sql",
		Description: "IBM i Run SQL Scripts",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	svc := NewApp(jar)
	svc.detachConnID = windowConn
	svc.app = app
	app.RegisterService(application.NewService(svc))

	title := "IBM i Run SQL"
	if windowTitle != "" {
		title = windowTitle
	}
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            title,
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
