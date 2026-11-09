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
dist: frontend
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql.exe .
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql-linux .
	GOOS=darwin GOARCH=arm64 go build -tags production -ldflags "-s -w" -o ibmi-runsql .
	# Intel Mac (only when someone asks):
	# GOOS=darwin GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql-macIntel .

dev:
	wails dev

test: frontend-test go-test

frontend-test:
	cd frontend && npm test

go-test:
	go test ./...

# Packaged app for the current platform (.app on macOS, .exe dir on Windows,
# binary + desktop file on Linux). Cross-compile is NOT supported for the
# webview builds — build on each target OS (or in CI per-OS runners).
package:
	wails build

clean:
	rm -f $(APP) $(APP).exe
	rm -rf frontend/dist build
