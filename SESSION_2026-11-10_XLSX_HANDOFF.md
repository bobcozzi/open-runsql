# OPEN RUNSQL XLSX handoff — 2026-11-10

Read `PROJECT_STATE.md`, then `SESSION_2026-11-10.md` for pre-existing project context. This note captures the XLSX work and release state completed today.

## Current source state

- Branch: `v3-migration`
- Feature commit pushed: `f321014 Add XLSX export and configurable date formats`
- Existing GitHub releases were updated in place; tags and URLs were preserved.
- `CHANGELOG.md` was created after the commit and is currently untracked. It should be committed and pushed next session if desired.
- Do not stage the user-provided workbook samples (`file_desc.xlsx`, `new_File_desc_test.xlsx`, `phase_2_test.xlsx`, `runSQL_Sample.xlsx`, `workbook_v3.xlsx`) or generated app artifacts unless specifically requested.

## XLSX implementation

- Result-grid Save As supports CSV, TAB, JSON, Markdown, and XLSX. XLSX menu label is `XLSX`; selected Save As format persists in localStorage under `ibmi-runsql-save-format`.
- Export uses Excelize v2.11.1 in the Go app. Workbooks use a `SQL Results` sheet, frozen header, styled headings, capped auto-width, and StreamWriter for 10k+ rows.
- Package post-processing fixes worksheet used dimensions and shared-string occurrence counts while preserving XML namespaces. Regression tests cover ZIP/XML integrity, shared strings, dimensions, and duplicate namespace prevention.
- JDBC bridge preserves integers above 15 digits as text and reads JDBC TIME values with `getString` to retain fractions.
- Date/time display choices live under Settings > Excel Date/Time Formats. Choices include Locale, ISO/U.S./day-first patterns and IBM i dates `*MDY`, `*MDYY`, `*DMY`, `*DMYY`, `*YMD`, `*YYMD`; time-only choices include `*ISO` and `*ISO12`.
- Timestamp choices include ISO, U.S., day-first, `U.S. time separators (YYYY-MM-DD HH:MM:SS)`, and `IBM i ISO (YYYY-MM-DD HH.MM.SS)`. IBM i timestamp choices omit milliseconds.
- TIME-only values display seconds without milliseconds. TIMESTAMP formats may display milliseconds where configured.
- Locale timestamp formatting now uses a valid ordinary custom number format selected from system locale (macOS `defaults read -g AppleLocale`, otherwise locale environment). The previous `[$-F800] [$-F400]` styles caused Excel to repair `/xl/styles.xml`. For `en_US`, Locale maps to `m/d/yy h:mm:ss AM/PM`; unknown locale falls back to ISO ordering. Do not reintroduce the old F800/F400-only custom style.
- `niceDates_4.xlsx` opened in Excel without repair after the original style issue was addressed. The later Locale timestamp marker issue was found through Excel's repair log. Latest source replaces those markers; a new export after the final change should be opened once more to verify.

## Tests and builds

- Go: `cd wails-app && go test ./...` passed after the final timestamp format changes.
- Frontend: `cd wails-app/frontend && npx tsc --noEmit && npm test`; latest suite passed 212 tests.
- Release build: from `wails-app`, `make dist && make dmg` built Windows and macOS only. Linux is intentionally deferred. `dist` now excludes Linux; `dmg` ad-hoc signs the app bundle before packaging.
- Windows artifact: `wails-app/ibmi-runsql.exe`, 22,483,968 bytes, verified PE32+ x86-64.
- macOS artifact: `wails-app/ibmi-runsql.dmg`, 15,601,489 bytes; `hdiutil verify` passed and the bundled app signature verified.
- Build emits an existing CSS minifier warning at `frontend/src/style.css` around the comment containing `mouse-focus ring`; builds still complete. `npm install` reports five dependency advisories; not remediated in this task.
- App is not currently running (last `pgrep` returned no process). Launch from `wails-app` with `nohup ./ibmi-runsql >/tmp/open-runsql-launch.log 2>&1 </dev/null &`.

## GitHub releases

- Windows: https://github.com/bobcozzi/open-runsql/releases/tag/v0.1.0-windows
  - Asset `ibmi-runsql.exe`; SHA-256 `19931fbf6202d24e170cc10c67b84df19ac6026e91e0478cfb5a9a8622104354`.
- macOS: https://github.com/bobcozzi/open-runsql/releases/tag/v0.1.0-macos
  - Asset `ibmi-runsql.dmg`; SHA-256 `70eecc447ae007a79c5493ad0d32ed3e1e0ae3dc96ff2a56eac333556f3ba41a`.
- Both existing release assets were replaced with `gh release upload <tag> <asset> --clobber`; release descriptions were updated. The Mac release now describes installing from the DMG (open it, drag app to Applications), not downloading a ZIP.

## Next

1. Commit and push the newly created root `CHANGELOG.md` if requested; it is not included in `f321014`.
2. Export a fresh Locale-format workbook with the final build and verify Excel opens it without repair. If Excel repairs it, inspect the newest file under `~/Library/Containers/com.microsoft.Excel/Data/tmp/Repair Result to *.xml` before changing formats.
3. Keep Linux out of release builds until the user asks for it.
