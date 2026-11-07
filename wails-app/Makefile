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
