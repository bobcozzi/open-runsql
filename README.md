# IBM i JDBC Bridge — component test starter

A small, standalone Java/JTOpen JDBC process with a JSON-lines protocol, plus Go and
TypeScript test callers. It is deliberately separate from the 5250 Desktop repository:
you can build and test the JDBC component first, then adapt the Go client into the Wails
application.

## Architecture

```text
TypeScript test client (Node)
          |
          | JSON-lines over stdin/stdout
          v
Go stub (starts and supervises Java process)
          |
          | JSON-lines over stdin/stdout
          v
Java bridge (JTOpen JDBC)
          |
          | IBM i Database Host Server
          v
       IBM i DB2
```

The Go stub is intentionally small and has no Wails dependency. Its methods mirror the
kind of methods the desktop app can later expose: connect, run SQL, fetch, cancel,
commit, rollback, and disconnect. The TypeScript client exercises those methods.

The bridge uses JDBC only. It does not replace or duplicate the existing Go Remote
Command Server or File Server code in `tn5250-desktop`.

## Requirements

- JDK 25 or later
- Maven 3.9+
- Go 1.22+
- Node.js 20+
- Network access from the workstation to the IBM i Database Host Server
- IBM i Database Host Server active and reachable (commonly started with
  `STRTCPSVR *DDM` / `STRHOSTSVR *DATABASE`, depending on release and site setup)

No Mapepire installation is required on IBM i. JTOpen is bundled as a Maven dependency.

## Build

From this directory:

```sh
cd java-bridge
mvn clean package
```

The shaded executable jar is:

```text
java-bridge/target/ibmi-jdbc-bridge.jar
```

Check the Java process starts:

```sh
java -jar java-bridge/target/ibmi-jdbc-bridge.jar
```

It waits for JSON request lines on stdin. Send `{"id":"1","op":"shutdown"}` to stop it.
Protocol responses are written to stdout; diagnostics go to stderr.

Build the Go stub:

```sh
cd go-stub
go build -o bridge-test ./cmd/bridge-test
```

Run the TypeScript caller:

```sh
cd ts-client
npm install
npm run test-bridge
```

The TypeScript caller starts the Go stub, which starts the Java helper. It prompts for
connection details interactively. The password is read without terminal echo.

## Test sequence

The client performs the following sequence:

1. Connect to the IBM i.
2. Run `VALUES CURRENT SERVER` (or a query you provide).
3. Display returned metadata and the first batch of rows.
4. Fetch remaining rows using the cursor ID.
5. Run a simple update-count example only if you explicitly enter a statement.
6. Disconnect and shut down the helper.

For a safe first test, use a read-only query such as:

```sql
SELECT CURRENT_USER, CURRENT_SCHEMA, CURRENT_TIMESTAMP
  FROM SYSIBM.SYSDUMMY1
```

## Protocol overview

Each request is one JSON object per line. Each response includes the matching `id`.

Operations:

- `connect`: `{op, id, host, user, password, tls, naming, defaultSchema, fetchSize}`
- `disconnect`: `{op, id, connectionId}`
- `executeSQL`: `{op, id, connectionId, sql, fetchSize}`
- `fetchRows`: `{op, id, connectionId, cursorId, fetchSize}`
- `cancelSQL`: `{op, id, connectionId}`
- `executeCL`: `{op, id, connectionId, command}` — runs a CL command via JTOpen
  `CommandCall` and returns `{kind:"cl", ok, messages:[{id, severity, type,
  typeName, text}], elapsedMs}`. Shares the connection's credentials; uses a
  `SecureAS400` when the connection was opened with `tls: true`.
- `commit`, `rollback`, `setAutoCommit`: transaction controls
- `getConnectionInfo`: returns driver and database metadata
- `shutdown`: closes cursors/connections and exits

The Java process can handle multiple IBM i connections. Each connection has its own
lock for statement execution/fetch/transaction operations. Cancellation deliberately
does not wait for that lock; it calls `Statement.cancel()` on the active statement.

### Result shape

`executeSQL` and `fetchRows` return a result object with:

- `kind`: `rows`, `count`, `none`, or `error`
- `columns`: column `name`/`label`/`type`/`typeName`/`precision`/`scale`/
  `displaySize`/`nullable`/`autoIncrement`/`schemaName`/`tableName`
- `rows`: arrays of JSON values; SQL NULL is JSON null. `DECIMAL`/`NUMERIC`/
  date/time/timestamp values serialize as canonical text (no double rounding).
- `cursorId` and `more`: present for paged result sets
- `updateCount`
- `messages`: SQLState, vendor code, and message
- `elapsedMs`

The first batch is returned by `executeSQL`; the ResultSet and Statement remain open
until exhausted, explicitly closed by a new statement, or disconnected. A later fetch
uses the cursor ID. The implementation currently handles the first result set/update
count from a JDBC statement; compound/multiple-result SQL scripts are a later extension.

## Wails desktop app (`wails-app/`)

`wails-app` is a Wails v2 desktop application ("Run SQL Scripts"-style) on top of
the bridge. The Go process starts the Java jar as a child and owns a webview window;
the jar stays a replaceable JDBC/JT400 adapter — there is no Java UI.

Features:

- Connect dialog (host, user, password, TLS, naming, default schema)
- Command entry: run SQL directly; prefix with `CL:` to run IBM i CL commands
  through `executeCL` (messages classified info/warning/error like the
  cozzi-cl-prompter Command Entry)
- Result grid with Db2 for i type mapping ported from the cl-prompter extension:
  right-aligned numbers/dates/times, `Zoned(p,s)` / `Dec(p,s)` tooltips,
  identity/table info, NULL styling, client-side sorting (bigint-safe)
- Paged fetching via `cursorId` with Load more / Load all, statement cancel,
  elapsed-time status

Build and run:

```sh
# 1. Build the bridge jar (once, and after any java-bridge change)
cd java-bridge && mvn clean package && cd ..

# 2. Build the frontend bundle (once, and after any frontend change)
cd wails-app/frontend && npm install && npm run build && cd ..

# 3. Build and run the desktop app (Wails needs the dev or production tag;
#    CGO_LDFLAGS works around a missing UniformTypeIdentifiers link on newer SDKs)
#    The bridge jar is compiled for JDK 25: the app needs java >= 25 on PATH,
#    or IBMI_JAVA pointing at one.
CGO_LDFLAGS="-framework UniformTypeIdentifiers" go build -tags production -o ibmi-runsql . && ./ibmi-runsql
```

Or from `wails-app/`, use the Makefile: `make run` (or `make build`).

Bridge Java runtime: the Go process starts the bridge with `java` from PATH;
set `IBMI_JAVA=/path/to/jdk25/bin/java` to pick a specific JDK (required when
PATH `java` is older than the JDK the jar was built with).

Or use the Wails CLI for a packaged app / live-reload dev loop:

```sh
wails dev          # from wails-app/, frontend hot reload
wails build        # macOS: build/bin/ibmi-runsql.app | Windows: .exe | Linux: binary
```

### Tests

Component tests live outside the shipped bundle and are never compiled into it:

```sh
cd wails-app && make test          # both suites
# or individually:
cd wails-app/frontend && npm test  # Vitest + jsdom (frontend/src tests + tests/)
cd wails-app && go test ./...      # Go bridge protocol tests
```

- **Frontend** ([frontend/tests/](wails-app/frontend/tests/)): Vitest + jsdom.
  Covers the SQL type mapping ported from cozzi-cl-prompter, the prompter XML
  model (including the constant-parm filtering regression), and DOM-level
  behavior like the saved-connections context menu. Vite's `vite build` only
  bundles modules reachable from [index.html](wails-app/frontend/index.html) —
  test files are not imported, so they are excluded automatically.
- **Go** ([internal/bridge/client_test.go](wails-app/internal/bridge/client_test.go)):
  protocol decode/correlation tests; no JVM needed.
- **Java bridge**: no unit tests (single-file protocol adapter); the go-stub /
  ts-client harnesses exercise it end-to-end against a live IBM i.

### Cross-platform notes

The app targets macOS, Windows, and Linux from the same code:

- **Go/Wails** and the **JT400 jar** are platform-neutral. No OS-specific code paths.
- The `CGO_LDFLAGS=-framework UniformTypeIdentifiers` workaround is **macOS-only**
  (Makefile guards it with `ifeq Darwin`). On Windows/Linux, build with plain
  `go build -tags production` — no CGO override needed.
- **No cross-compiling** the webview build: Wails needs the target OS's native
  webview (WebKit/WebKitGTK/WebView2), so build on each platform (or per-OS CI
  runners). `wails build` produces the native package on whatever host runs it.
- Linux prerequisite: WebKitGTK dev package (`libwebkit2gtk-4.1-dev` on
  Debian/Ubuntu, `webkit2gtk4.1-devel` on Fedora) before `wails build`.
- Saved connections live in the per-user config dir on every OS
  (`os.UserConfigDir()`): `~/Library/Application Support/ibmi-runsql/` on macOS,
  `~/.config/ibmi-runsql/` on Linux, `%APPDATA%\ibmi-runsql\` on Windows.

The app locates the jar relative to the executable or at
`../java-bridge/target/ibmi-jdbc-bridge.jar`; override with
`IBMI_JDBC_BRIDGE_JAR=/path/to/jar`.

## Connection options and caveats

- `tls: true` adds `secure=true` to the JTOpen JDBC URL. The JVM/JTOpen trust
  configuration must trust the IBM i certificate.
- `naming` accepts `sql` or `system`.
- `defaultSchema`, when supplied, is applied with `SET SCHEMA` after connecting.
- The starter intentionally does **not** implement a trust-all-certificate switch.
  For production, configure a truststore rather than disabling certificate validation.
- Login timeout is configurable in `connect` as `timeoutSeconds`.
- This is a component starter, not yet production-hardened. Validate TLS, naming,
  CCSID, binary/LOB handling, transaction semantics, and cancellation against your
  IBM i releases and the exact JTOpen version you deploy.

## VS Code

Open this folder in VS Code. The Java source is a normal Maven project. The Go stub
is a normal Go module, and the TypeScript client is a small Node project. You can
build/debug each independently before bringing the bridge into the Wails repository.

## Integration direction for tn5250-desktop

Keep the existing Go Remote Command Server and File Server implementations. Add a Go
adapter around `go-stub/bridge` (or move that package into the repo), and have the
existing Wails methods call the Java helper:

- `SqlConnect` -> `connect`
- `SqlRun` -> `executeSQL`
- `SqlFetch` -> `fetchRows`
- `SqlCancel` -> `cancelSQL`
- `SqlClose` -> `disconnect`

Keep the current frontend-facing result model initially; translate the bridge response
into the existing `SqlResult` structure. CL execution remains on the current Go
Remote Command Server path.
