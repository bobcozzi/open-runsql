# IBM i Run SQL — User Guide

A desktop "Run SQL Scripts"-style app for IBM i (macOS / Windows / Linux). Designed for IBM i by Bob Cozzi.

## Requirements

- Java 17 or newer on your PATH (`java -version` to check). The app uses it for the IBM i bridge.
- Network access to your IBM i (ports 8471/8475/8474, or 9471/9475/9474 with TLS).

## Connecting (Quick Connect)

The **Quick Connect** panel is at the top when no connection is open:

1. **Host** — system name or IP. The field suggests saved connections as you type (matches name, host, or user); the **×** clears it, **▼** opens the full list.
2. **User** / **Password** — your IBM i profile. Check **Save password** to store it in the OS credential vault (Keychain / Windows Credential Manager / Secret Service) — never in a file.
3. **Default schema** (optional), **Naming** (SQL or System), **Secure (TLS)** — encrypts all traffic.
4. Click **Connect** (or the green **GO** after picking a saved connection).

Connections are remembered automatically and editable in the **Connections** tab: name, host, user, schema, naming, TLS, password, preload-spool, script, plus reorder (drag or A-Z), New/Duplicate/Delete, and **Connect in new Tab**.

## Connection Tabs

- **+** in the Connection Tab opens a new connection tab. Each connection tab keeps its own script, results, and messages.
- The toolbar shows the current connection's SQL server job as `number/user/name` when available. Select the text to copy it; detached windows show their own connection's job.
- The bottom bar holds tabs for panels with other features, including: **Messages / Results / Spooled Files / Connections / Settings**. Connections and Settings work even when disconnected.

## The Scripts input area

Type SQL statements or CL commands, one or many; a statement ends at `;`.

- **Run** (▶ / Cmd/Ctrl+Enter) — statement at the cursor (or the selection).
- **Run All** — every statement in order. **Run From** — cursor statement through the last. **Cancel** stops a running statement.
- **CL commands**: prefix with `CL:` — e.g. `CL: WRKSYSSTS OUTPUT(*PRINT)`. When the command name can't collide with SQL you can omit the prefix, but `CL:` is recommended.
- **CL prompting**: caret on a CL command + **F4** (or **Prompt**) opens a form-driven prompter with validation, dependencies, and special values. SQL prompting is planned for a future release.
- **Editor Options** in Settings controls editor font size and the colors for STOP statements and comments.

## History & scripts

- **F8/F9** (or ↑/↓ on the first/last editor line) recall previous statements; **F6** or **History** opens the searchable, timestamped per-connection log (Enter inserts at the cursor, × deletes).
- In Connections, **Auto Save/Restore SQL Script between connections** saves editor text separately for each connection and restores it on connect. When off, the user-defined **Startup SQL Script** initializes the editor instead. Neither is run automatically. Existing profile scripts remain in the startup field; automatic session text starts separately. **File...** saves/opens a `.sql` file via the system dialog.
- **Reload initial SQL script** restores the editor to the text loaded at the start of the current connection after confirmation, even if later edits were automatically saved.

## Results

- Click column headers to sort; NULLs sort last. **Load more / Load all** page large result sets.
- **Save as...** exports the grid as CSV, TSV, JSON, Markdown, or XLSX (system Save dialog); **Open Folder** reveals the download folder. CSV uses field names; Settings > Excel Export Options selects field names or result column headings for XLSX and configures date/time display formats.

## Spooled Files

- List/filter by user and output queue; sortable columns; multi-select with Ctrl/Cmd+click and Shift+click.
- Double-click views (or the action chosen in Settings). Right-click for View / Download PDF / Download Text / Save Raw / Print / Move / Hold / Release / Delete.
- **Open Download Folder** (filter row) shows where downloads land. Downloads are named `name_jobnumber_splfnumber` so repeats never overwrite.

## Settings tab

Theme (System/Light/Dark, mirrors the titlebar dropdown), spool download folder (native picker), default fetch size, double-click action on spooled files, default naming mode, results font size, spool list cap, and delete-confirmation toggle. All apply immediately.

Each connection profile has a **Use Enhanced CL Support** switch. Off (the default for older profiles) runs CL through JT400 CommandCall in a separate host job, without enhanced checks or installation. On checks for `CMD_RUN` when connecting. A verified current or newer installation in the configured **Function Library** under Settings > **Enhanced CL Support** is used, even if a newer one exists elsewhere. Other discovered installations are not used automatically. The Messages tab reports the outcome and available alternatives. Profile changes and manual Function Library changes take effect after reconnecting; existing connections retain their selection. Legacy global CL mode and installation settings do not override the switch.

CL messages can be expanded in Messages to show second-level help and, when available, sender, recipient and timestamp details. Settings > **Enhanced CL Support** > **Show messages in results panel** is off by default. When enabled, the complete `CMD_RUN` message table also appears in Results, including an empty table when there are no messages. The command runs only once. Standard CL continues to use Messages without a `CMD_RUN` result table.

**Function update notifications** controls host changes at connection. **New** means a new installation or a program-only repair; **Updates** means upgrading an eligible older function. A program with no function counts as New, even though repair replaces that program.

- **Always** (the default): prompt for both New and Updates.
- **New only**: prompt for New; automatically apply Updates.
- **Updates only**: automatically install or repair New; prompt for Updates.
- **No notifications, auto install and update**: automatically apply eligible New and Updates without a prompt.
- **No notifications, no installs or updates**: skip both without a prompt or host writes; the connection remains available.

Automatic choices authorize the corresponding host changes. Messages report automatic starts and outcomes, or that changes were skipped. Existing safety checks still apply; current or newer functions are not changed and unknown versions are not replaced.

If the configured **Function Library** has no installation or an older or unknown version, a prompted dialog can offer eligible alternatives for explicit selection. Only verified installations with numeric versions at least as new as the bundled function are selectable. Selecting a radio button and confirming the additional **OK** prompt rechecks the chosen library, saves it as **Function Library**, and uses it for this connection; cancel makes no selection. Automatic operations use the configured library without selecting alternatives, which are reported in Messages. Neither no-notifications choice opens an alternative selector. Unknown versions are not used or replaced. Function Library defaults to `SQLTOOLS` and must identify an existing library that does not begin with `Q`, except `QGPL`. A routine-only target or a program with a conflicting routine is reported for inspection and is never repaired or replaced automatically. Catalog visibility depends on host authorities. The embedded JDBC bridge must include the `installations` discovery array and repair operation; older bridge builds may not support these features.

When the configured library contains a `CMD_RUN` program but no visible `CMD_RUN` routine, the application can repair it after confirmation or automatically under **Updates only** or **No notifications, auto install and update**. Repair replaces that program, which might belong to another application or owner, and creates the SQL function. The old program moves to `QRPLOBJ`, the new program uses public `AUT(*ALL)`, and new source members and a compiled module are retained. The check cannot establish ownership or rule out hidden objects; coordinate exclusive administrative access throughout, since other jobs are not locked out. Failure can leave partial changes, including a replaced program without a function; there is no rollback or automatic retry. Inspect the target objects and host job log before manual recovery. Enhanced CL remains unavailable after declining or failing repair and never silently falls back to CommandCall.

An eligible older version is upgraded after confirmation or automatically under **New only** or **No notifications, auto install and update**; declining, skipping or failing the upgrade leaves enhanced CL unavailable on that connection. The upgrade replaces the program and SQL routine, may affect dependencies, and can leave partial changes on failure. Existing source members are retained and new version-labeled source members and a module are added. Coordinate exclusive administrative access, review authorities, and inspect the target and host job log before any manual recovery; there is no automatic retry or rollback. A verified newer version is never downgraded. Version metadata does not establish compatibility.

Installation requires authority to create objects in the selected library, the IBM i C++ compiler, and `RUNSQLSTM`. It retains the uploaded sources in `QCOZZISRC` (record length 142) and the compiled module in the selected library. The module and program are created with public `*ALL` authority. Existing `QCOZZISRC` or `CMD_RUN` objects are not replaced. A failed installation may leave source or target objects behind for inspection; resolve those manually before retrying. No command is automatically retried after a SQL-job execution error because it may already have run.

The installer, repair, upgrade and enhanced routine have not yet been validated on an IBM i host; use a separate test library for initial host testing.
