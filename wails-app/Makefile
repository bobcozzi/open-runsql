APP := ibmi-runsql
JAR := ../java-bridge/target/ibmi-jdbc-bridge.jar

# Wails v2.17 + newer macOS SDKs: UniformTypeIdentifiers (UTType) is not linked
# automatically by the darwin webview code. macOS-only flag — must NOT be set
# on Windows/Linux builds.
ifeq ($(shell uname -s),Darwin)
export CGO_LDFLAGS := -framework UniformTypeIdentifiers
endif

.PHONY: all jar frontend run build dev clean

all: jar frontend build

jar:
	cd ../java-bridge && mvn -q clean package

frontend:
	cd frontend && npm install && npm run build

# Plain 'go run'/'go build' need a Wails build tag: dev or production.
run:
	go run -tags dev .

build:
	go build -tags production -o $(APP) .

# Distribution builds (stripped, shareable). Naming: common platforms get the
# plain base name; rare ones get a suffix. macOS builds keep CGO on (webview
# requires it); Windows/Linux cross-compile clean with CGO off.
#   ibmi-runsql           macOS Apple Silicon (also the local dev name)
#   ibmi-runsql-macIntel  macOS Intel (rare; build on demand)
#   ibmi-runsql.exe       Windows amd64
#   ibmi-runsql-linux     Linux amd64
dist: frontend winres
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql.exe .
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql-linux .
	GOOS=darwin GOARCH=arm64 go build -tags production -ldflags "-s -w" -o ibmi-runsql .
	# Intel Mac (only when someone asks):
	# GOOS=darwin GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql-macIntel .

# Windows icon/manifest resources. The Go linker auto-embeds rsrc_windows_amd64.syso
# (main package dir) when building GOOS=windows. Regenerated from packaging/windows/
# on every dist build. Requires rsrc: go install github.com/akavel/rsrc@latest
winres:
	~/go/bin/rsrc -ico packaging/windows/app.ico -manifest packaging/windows/app.manifest \
		-arch amd64 -o packaging/windows/rsrc_windows_amd64.syso
	cp packaging/windows/rsrc_windows_amd64.syso .

dev:
	wails dev

test: frontend-test go-test

frontend-test:
	cd frontend && npm test

go-test:
	go test ./...

# macOS .app bundle. Launching the bare binary from Finder makes macOS open it
# in Terminal.app first; wrapping it in a bundle lets LaunchServices run it
# directly (no terminal window). wails3 v3.1 'build' requires a Taskfile (this
# project doesn't use one), so the bundle is assembled by hand: production
# binary + Info.plist + ad-hoc codesign.
package: bundle

bundle: build
	rm -rf $(APP).app
	mkdir -p $(APP).app/Contents/MacOS $(APP).app/Contents/Resources
	cp $(APP) $(APP).app/Contents/MacOS/
	cp packaging/darwin/Info.plist $(APP).app/Contents/
	cp packaging/darwin/AppIcon.icns $(APP).app/Contents/Resources/
	codesign --force --deep --sign - $(APP).app
	@echo "Built $(APP).app - launch with: open $(APP).app"

clean:
	rm -f $(APP) $(APP).exe $(APP)-linux rsrc_*.syso
	rm -rf $(APP).app frontend/dist build
