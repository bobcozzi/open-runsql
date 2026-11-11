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
