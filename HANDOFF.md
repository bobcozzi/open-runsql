# Session handoff — 2026-11-07 night

Read this + PROJECT_STATE.md first when resuming.

## Environment / build cycle

- Rebuild: `cd wails-app/frontend && npx tsc --noEmit && npm test && npm run build && cd .. && go build -tags production -o ibmi-runsql .`
- Java bridge: `cd java-bridge && JAVA_HOME=/Users/cozzi/.jdk/jdk-25.0.2/jdk-25.0.2+10/Contents/Home /opt/homebrew/Cellar/maven/3.10.0/bin/mvn clean package`
- Run app: `pkill -x ibmi-runsql; IBMI_JAVA=/Users/cozzi/.jdk/jdk-25.0.2/jdk-25.0.2+10/Contents/Home/bin/java /Users/cozzi/Downloads/projects/open-runsql/wails-app/ibmi-runsql`
  - IBMI_JAVA needed: PATH java is Corretto 21, jar is Java 25 bytecode (v69).
- macOS linker warning "built for newer macOS version (13.3) than being linked (11.0)" — harmless for local dev.
- zsh gotchas: bare `===`/`==` separators break (`zsh: == not found`); never name a var `status`.
- Formatter reindents files on save (4-space) — re-read before editing if a replacement fails.
- Before trusting bug reports: `pgrep -x ibmi-runsql` + binary timestamp — stale-instance confusion has bitten twice.

## Current state at sign-off

- All suites green: Vitest 137/137, tsc clean, go build+vet clean, mvn compile clean.
- Binary built 22:01 with everything below.
- Branch v3-migration; remote origin = github.com/bobcozzi/open-runsql (private).
- Uncommitted at sign-off: everything under `git status` (spooled files + late prompter work). Commit planned next session start.

## What landed tonight (latest first)

### Spooled files — Stage 1 (NEW, untested live)
- Java: `listSpooledFiles` op in Main.java (SpooledFileList on Session.clSystem; user/queue filters; per-field try/catch; ISO dates; kind:"spooledFiles").
- Go: `ListSpooledFiles` in app.go (types SpooledFileRequest/Info/Result; follows GetCmdXml pattern). NOTE: subagent corrupted app.go during this (deleted helper block str/str2/boolVal/intVal/int64Val/normalizeNaming and mangled sqlMessageKind) — all restored from HEAD; duplicate ListSpooledFiles deduped. Files exist: wails-app/frontend/src/spool.ts + tests/spool.test.ts.
- Frontend: "Spooled Files" tab in work-tabs; filter row (User, All users, OutQ lib+name, All outqs, Refresh, Clear); sortable table (Name/Number/Job/User/Job#/UserData/OutQ LIB-NAME/Created/Pages/Size/Status/Hold); dblclick = TODO stub for viewer.
- NOT DONE: viewer (PDF via PrintObjectTransformedInputStream), download, hold/release, move, delete — stages 2-5 in PROJECT_STATE.md.
- Live-test it first tomorrow: filter combos, authority errors, big lists (no pagination yet — flagged in spec).

### CL prompter (after last commit 73821b3)
- Defaults are real values (value=dft, not placeholder) — fixed ASPDEV required-bug; dataset.default records prefill.
- valToInternal (MapTo) ported; Dep/PmtCtl compare internal values; CI + passthrough.
- Positional parms: positional.ts rewritePositionalParms (arrival order, maxPos cap); populate round-trips `DSPOBJD qiws/qcustcdt *file ...` etc.
- Input history per connection: inputHistory.ts (InputHistory/InputHistoryStore), ↑/↓ first/last-line, F9=older F8=newer (extension parity), draft stash/restore. In-memory only.
- Home/End line-start/line-end in editor (+shift select).
- ELEM positional fill: touched-container rule — buildCommand(..., touched) emits current values through last dirty part (LOG(*SAME *SAME *SECLVL) case). Populate dispatches input → counts as touched.
- Enter-in-field submits unless PmtCtl/Dep visibility flips or errors (errors scroll+focus).
- Header pinned: title + <xml> copy button + live command preview + error banner; form scrolls; footer Enter/Cancel/View-all.
- Label format "Prompt (KWD)"; .N child index hidden; focus ▶ arrow left of input in accent color.
- Numeric parms accept listed special values (RUNPTY *SAME MapTo=0 fix).
- CL runs show Messages pane (not empty Results).
- l10n: src/l10n.ts t() wired through main/prompterView/index.html (~100 keys en). Add language = src/l10n/<lang>.ts + register in CATALOGS.

### Deliberate gaps (don't "fix" by accident)
- ChoicePgm/PmtCtlPgm/PmtOvrPgm runtime host calls: TABLED. BUT CHGJOB XML showed ChoicePgmValues ship inline in the XML (LANGID/CNTRYID/CCSID) — those could render dropdowns WITHOUT host calls. Candidate next prompter piece.
- Multi-instance populate: only first instance populated (+ rows not auto-created).
- Blank-vs-unspecified collapse in SPCFD/X'40' handling (extension parity).
- P2 cosmetics: green non-default coloring, F-key footer, help buttons.

## Repo facts
- clprompter code COPIED from cozzi-cl-prompter (not shared). Extension reference: /Users/cozzi/Downloads/projects/cozzi-cl-prompter/src (prompter.ts ~6.7k lines is the source of truth for behaviors).
- IBM XML shape: <SpcVal><Value Val MapTo ValTxt/></SpcVal>; QUAL parts render document order, reverse on assembly (LIB/OBJ); PmtCtl on controlled parm's Kwd; PMTRQS hidden until specified; PMTOVRPGM protocol undocumented (dropped).
- JT400 21.0.7 jar has all print classes (verified).
- Profile dir: ibmi-runsql under os.UserConfigDir().
- User prefs: no emojis in code/commits; free-form RPG; fully free-form.
- /memories/ gets wiped on reboot — this file is the durable copy.
