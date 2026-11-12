APP := ibmi-runsql
JAR := ../java-bridge/target/ibmi-jdbc-bridge.jar
NOTARY_PROFILE ?= ibmi-runsql-notary
RELEASE_DMG ?= $(CURDIR)/build/ibmi-runsql-notarized.dmg

# Wails v2.17 + newer macOS SDKs: UniformTypeIdentifiers (UTType) is not linked
# automatically by the darwin webview code. macOS-only flag — must NOT be set
# on Windows/Linux builds.
ifeq ($(shell uname -s),Darwin)
export CGO_LDFLAGS := -framework UniformTypeIdentifiers
endif

.PHONY: all jar frontend run build dev clean dmg release-dmg

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
# requires it); Windows cross-compiles cleanly with CGO off.
#   ibmi-runsql           macOS Apple Silicon (also the local dev name)
#   ibmi-runsql-macIntel  macOS Intel (rare; build on demand)
#   ibmi-runsql.exe       Windows amd64
dist: frontend winres
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql.exe .
	GOOS=darwin GOARCH=arm64 go build -tags production -ldflags "-s -w" -o ibmi-runsql .
	# Intel Mac (only when someone asks):
	# GOOS=darwin GOARCH=amd64 go build -tags production -ldflags "-s -w" -o ibmi-runsql-macIntel .

# macOS drag-to-Applications DMG. Rebuilds the binary straight into the .app
# bundle (keeps Info.plist/AppIcon.icns), stages it next to an /Applications
# symlink, and packs a compressed UDZO image. Output: ibmi-runsql.dmg
dmg:
	go build -tags production -ldflags "-s -w" -o ibmi-runsql.app/Contents/MacOS/ibmi-runsql .
	codesign --force --deep --sign - ibmi-runsql.app
	rm -rf /tmp/dmg-stage ibmi-runsql.dmg
	mkdir -p /tmp/dmg-stage
	cp -R ibmi-runsql.app /tmp/dmg-stage/
	ln -s /Applications /tmp/dmg-stage/Applications
	hdiutil create -volname "IBM i RunSQL" -srcfolder /tmp/dmg-stage -ov -format UDZO ibmi-runsql.dmg
	rm -rf /tmp/dmg-stage

release-dmg:
	@test -n "$(SIGN_IDENTITY)" || { echo "Set SIGN_IDENTITY to your Developer ID Application identity"; exit 1; }
	@test ! -e "$(RELEASE_DMG)" || { echo "Release already exists: $(RELEASE_DMG)"; exit 1; }
	cd frontend && npm run build
	@set -eu; \
	workdir=$$(mktemp -d "$${TMPDIR:-/tmp}/ibmi-runsql-release.XXXXXX"); \
	trap 'rm -rf "$$workdir"' EXIT; \
	app="$$workdir/$(APP).app"; \
	mkdir -p "$$app/Contents/MacOS" "$$app/Contents/Resources" "$$workdir/stage"; \
	go build -tags production -ldflags "-s -w" -o "$$app/Contents/MacOS/$(APP)" .; \
	cp packaging/darwin/Info.plist "$$app/Contents/Info.plist"; \
	cp packaging/darwin/AppIcon.icns "$$app/Contents/Resources/AppIcon.icns"; \
	codesign --force --options runtime --timestamp --sign "$(SIGN_IDENTITY)" "$$app"; \
	codesign --verify --deep --strict --verbose=2 "$$app"; \
	ditto -c -k --keepParent "$$app" "$$workdir/app.zip"; \
	xcrun notarytool submit "$$workdir/app.zip" --keychain-profile "$(NOTARY_PROFILE)" --wait; \
	xcrun stapler staple "$$app"; \
	xcrun stapler validate "$$app"; \
	cp -R "$$app" "$$workdir/stage/"; \
	ln -s /Applications "$$workdir/stage/Applications"; \
	hdiutil create -volname "IBM i RunSQL" -srcfolder "$$workdir/stage" -format UDZO "$$workdir/release.dmg"; \
	codesign --timestamp --sign "$(SIGN_IDENTITY)" "$$workdir/release.dmg"; \
	xcrun notarytool submit "$$workdir/release.dmg" --keychain-profile "$(NOTARY_PROFILE)" --wait; \
	xcrun stapler staple "$$workdir/release.dmg"; \
	xcrun stapler validate "$$workdir/release.dmg"; \
	mkdir -p "$$(dirname "$(RELEASE_DMG)")"; \
	cp -n "$$workdir/release.dmg" "$(RELEASE_DMG)"; \
	echo "Created $(RELEASE_DMG)"

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
