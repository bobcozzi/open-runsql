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

func main() {
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
