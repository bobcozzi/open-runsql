# Changelog

## 2026-11-21 - 2.0.7

### Added
- Spooled-file View opens in its own window, with the first pages prefetched
  while the window opens.
- *AFPDS spooled files View as page images in the same window; Save Raw saves
  them with an `.afp` extension.
- Local cache for finished spooled files, so repeat View and Download of files
  that can no longer change are served without re-reading the host.
- Spool attributes (device type, code page) are looked up on demand for View and
  Save Raw, so the Full Attributes list option is no longer required.
- Admin Scheduler subpanel listing IBM i Job Scheduler entries.
- Admin Jobs filter keywords with flexible separators; Enter refreshes.
- Auto Recall: the SQL/CL editor session is saved and restored from the IBM i
  IFS or from the local PC only. A differing copy prompts Add/Replace, and an
  empty editor never overwrites a saved session.
- Save/Open script dialog with local, IFS file, and source member
  destinations; Ctrl/Cmd+S saves to the last destination.
- SQL/CL formatter and a textual CL message list.
- Copy results to the clipboard, or Save as..., as SQL INSERT (one multi-row
  statement) or SQL UPDATE (one statement per row, keyed on the first column).
  The table name is taken from the statement when it reads a single table.
  Large unselected copies ask for confirmation.

### Changed
- Spooled-file raw reads handle compressed and partial-buffer host replies.
- Download, Print, and PDF are not offered for *AFPDS files; use View or Save Raw.

### Release
- The 2.0.7 macOS and Windows assets were refreshed on 2026-11-22 with the
  Auto Recall, Save/Open script, formatter, and SQL INSERT/UPDATE changes
  above; SHA-256 values changed accordingly.
- macOS Apple Silicon: signed, notarized, and stapled application ZIP and DMG
  under `v2.0.7-macos`.
- Windows x64: unsigned, cross-compiled `IBMi-RUNSQL.zip` and executable under
  `v2.0.7-windows`. WebView2 Runtime is required; Windows runtime testing was not
  performed.
- The iPad development build is not included in the public downloads.

## 2026-11-20 - 2.0.6

### Added
- Admin Jobs actions: Display Job, Job Log, Call Stack, End Job, and End Job
  Abnormal, with sequential prompts for multi-job End Job.
- Progressive spooled-file text View with progress feedback and local SCS
  rendering.
- Session Log records CL commands with execution source and host responses.

### Changed
- The Admin panel is opt-in and its visibility persists across launches and tabs.
- Job Log shows SEQNBR first and a combined timestamp; Message Queue controls and
  CL prompter validation were refined.

## 2026-11-19 - 2.0.5

### Added
- Read-only Admin views for jobs, job queues, output queues, printers, and QHST history, with configurable columns, filters, and shared export and paging controls.
- German CCSID 273 message text decoding for QHST and message queues.

### Changed
- Admin views retain their loaded contents when switching panels and refresh explicitly; initial loads and refreshes show loading status.
- QHST and output-queue lists build their remaining entries asynchronously after the first page, improving responsiveness on large lists.
- Shared table pagination keeps the More control visible at the right edge, including when scrolling horizontally.
- Spooled Files printer selection uses the native printer list API.

### Release
- macOS Apple Silicon: signed, notarized, and stapled application and DMG under `v2.0.5-macos`.
- Windows x64: unsigned, cross-compiled `IBMi-RUNSQL.zip` under `v2.0.5-windows`. WebView2 Runtime is required; Windows runtime testing was not performed.
- The iPad development build is not included in the public downloads.

## 2026-11-18 - 2.0.4

### Added
- Native SQL catalog completion for tables, columns, and routines, with separate controls for keyword and catalog suggestions.
- SQL/CL statement history per host and user, with Never, Always, and Session retention.
- Reconnect replaces the host connections without clearing the SQL/CL editor or loaded results. The old result cursor is closed.
- Shared sorting, column resizing, and long-text scrolling across SQL/CL, IFS, Spooled Files, and Messages. Copy uses selected rows or the displayed table when no rows are selected.

### Changed
- Settings are grouped by task, with separate table font sizes and a CSV heading preference for file exports.
- IFS supports per-connection listing modes, dot-prefixed entries in File Server listings, and Copy path on files and folders.
- Improved SQL/CL editor visibility, script recall persistence, connection summaries, and SQL job log access.

### Release
- macOS Apple Silicon: signed, notarized, and stapled application and DMG under `v2.0.4-macos`.
- Windows x64: unsigned, cross-compiled `IBMi-RUNSQL.zip` under `v2.0.4-windows`. WebView2 Runtime is required; Windows runtime testing was not performed.
- The iPad development build is not included in the public downloads.

## 2026-11-18 - 2.0.3 Preview

### Added
- Per-connection SPOOLED filters, a page-layout view, and a visible scrollbar in the text spool viewer; Greenbar and page-layout choices persist during the app session.
- IFS folder navigation by path with GO, session-only sidebar roots, and New Folder creation from the active directory.

### Changed
- Missing or inaccessible IFS folders leave the current folder open and show a prominent error; the IFS extended-attributes control is shortened to Full.

### Release
- macOS Apple Silicon: `IBMi-RUNSQL.app`, signed and notarized, distributed in `IBMi-RUNSQL-2.0.3-macos-arm64.dmg`.
- Windows x64: unsigned, cross-compiled `IBMi-RUNSQL.exe` in `IBMi-RUNSQL.zip`; Windows runtime behavior has not been tested on Windows hardware.
- iPad development build is not included in public release assets. Application source remains private; public tags point to documentation-only commits.

## 2026-11-17 - 2.0.2 Preview

### Added
- Native Messages panel with queue views, message details, queue descriptions, paging, filters, and inquiry replies.
- Cancellable IFS View/Download and spooled-file View/Download/Save batches with a persistent progress dialog.
- Status checkbox picker using IBM QGYOLSPL status values; `*MSGW` maps to the API's `*MESSAGE` value.
- Shared Save As export for the IFS, Spooled Files, and Messages lists; IFS XLSX exports retain numeric attribute types.

### Changed
- Simplified User and output-queue filters; improved spool status and output-queue selection controls.
- Refined IFS and spool detail/progress dialogs and shared panel toolbar visibility.

### Release
- macOS Apple Silicon: signed, notarized, and stapled `IBMi-RUNSQL.app` DMG under `v2.0.2-macos`.
- Windows x64: unsigned cross-compiled `IBMi-RUNSQL.zip` under `v2.0.2-windows`; Windows runtime behavior has not been tested on Windows hardware.
- iPad development build is not included in the public release assets.
- Application source remains private; public tags point to documentation-only commits.

## 2026-11-20 - 2.0.6

### Added
- Admin Jobs actions for Display Job, Job Log, call stack inspection, and prompted End Job / End Job Abnormal commands.
- Cancellable batch confirmation for ending multiple jobs; commands run only after every selected job is confirmed.
- Persistent, opt-in Admin panel visibility. Existing installations with the former default-on value migrate to off unless the user explicitly enables Admin.
- Progressive spooled-file text viewing and improved read progress reporting.

### Changed
- Job Details displays CYYMMDDHHMMSS fields as ISO date/time values without fractional seconds.
- Job Log displays sequence number first and uses one timestamp column with local-PC time separators.
- CL command execution and host responses include their execution source in Session Log.
- Message Queue controls and CL prompting validation were refined.

### Release
- macOS Apple Silicon: signed, notarized, and stapled `.app` ZIP and DMG under `v2.0.6-macos`.
- Windows x64: unsigned, cross-compiled executable and ZIP under `v2.0.6-windows`. WebView2 Runtime is required; Windows runtime testing was not performed.
- The iPad development build is not included in public downloads.

## 2026-11-16 - 2.0.0 Preview

### Added
- Native Go connections to IBM i host servers for the Java-free desktop preview, including SQL execution and CL commands with prompting.
- IFS Text/Hex viewing, extended attributes on IBM i 7.3 and newer, and native attribute retrieval on older hosts.
- Native spooled-file access and SCS/AFPDS viewing, with View controls and long-press actions.
- CL choice popups with on-demand full-list loading and keyboard navigation.
- Auto theme selection following the system appearance.

### Changed
- F4 is ignored for SQL; CL prompting remains available for CL commands.
- Connection loss does not automatically replay SQL or CL commands. Reconnect and verify the host-side outcome before deciding whether to run an operation again.

### Release
- 2.0.0 is a PREVIEW, not a compatibility guarantee. The native application does not require Java; legacy 0.1.x releases still require Java 17 or newer.
- macOS Apple Silicon: signed and notarized application and DMG, distributed as `IBMi-RunSQL-2.0.0-macos-arm64.dmg` under `v2.0.0-macos`.
- Windows x64: `IBMi-RUNSQL.zip` under `v2.0.0-windows`. Extract the ZIP before launching the executable. Microsoft Edge WebView2 Runtime is required. The executable is unsigned and cross-compiled, and has not been runtime-tested on Windows.
- Application source remains private. iPad support is private development only; no public iPad asset is provided.

### Limitations
- Host-dependent features are gated by IBM i release, PTF levels, configuration, and authority. IBM i 7.3 or newer alone does not guarantee extended-attribute availability; validate required host services and PTFs on the target system.
- Preview compatibility is not guaranteed across IBM i releases or PTF levels. Verify the workflows you depend on before deployment.

## 2026-11-13 - 0.1.2

### Added
- Live SQL catalog completion for tables, views, routines, columns, table-function result columns, and named routine parameters. Metadata uses a separate read-only JDBC connection, bounded catalog queries, and a per-connection frontend cache without executing edited SQL or disturbing the active result cursor.
- Per-connection CL Support choices: Standard (CommandCall), SQL-job QCMDEXC, and SQL-job CMD_RUN with message logging.
- CMD_RUN component discovery, installation, upgrade, and repair, with versioned metadata, configurable notifications, additional-installation log entries, and install progress reporting. Bundled CMD_RUN version is 0.2.1.
- QCPPLE prerequisite detection for the C++ component, with a connection-local QCMDEXC fallback when the compiler library is not detected.

### Fixed
- Display the JDBC SQL job in number/user/name format to the left of Connect.
- Preserve existing Results when an enhanced CL command returns no message rows; scroll Messages to the latest entries when activated.
- Preserve leading and interior character-field whitespace while removing fixed-width right padding for display.
- Reuse a compatible existing QCOZZISRC without overwriting existing members, uploading each new member before adding the next.
- Render SQL completion and detail popups outside the editor's clipping container with app-theme colors.

### Limitations
- Live completion does not resolve nested queries/CTEs, user-job QTEMP objects, or later SET SCHEMA changes. Catalog parameter suggestions are not full signature help; metadata availability depends on host release, PTFs, and authority.
- Releases still require Java 17 or newer. Windows runtime behavior needs a Windows host test; cross-compilation alone is not a runtime test.

## 2026-11-12

### Changed
- Improved the toolbar Pin icon with a solid pushpin tilted 45 degrees and a heavier needle for better visibility.

### Release
- Bumped the release version from 0.1.0 to 0.1.1 with separate published Windows x64 and macOS Apple Silicon releases. The Mac app and DMG are signed with Developer ID, notarized by Apple, and include stapled notarization tickets.

## 2026-11-11

### Added
- Added SQL and CL syntax highlighting, including configurable colors for comments, STOP, CL command names, parameter names, and values. Editor Options also provides font size and an SQL highlighting switch.
- Added a reload button that restores the SQL editor to its initial connection script after confirmation, even if later edits were automatically saved.
- Added temporary toolbar status messages and a highlight showing the statement currently running.

### Changed
- Separated the user-defined Startup SQL Script from automatically saved session text. With Auto Save/Restore on, the last session is restored; with it off, the startup script initializes the editor. Neither runs automatically.
- Added an Excel column heading choice between field names and result column headings. CSV still uses field names. XLSX is now the initial Save As format for new users while existing user's format choice remain saved between sessions.
- Keyboard behavior on all platforms is now "correct". (i.e., HOME and END move to the start and end of the current editor line on every platform. Batch runs move the caret to the next statement, the end of the final statement, or immediately before STOP.

### Fixed
- STOP is handled locally when run as the current statement instead of being sent as a CL command.
- Fixed CL-style comments which are now support (yes, /* ... */ works.)
## 2026-11-10

### Added
- Added native XLSX export for SQL result sets using Excelize, including typed cells, safe handling of high-precision numeric values, formatted date/time values, frozen headers, sized columns, and streaming for large exports.
- Added persisted Excel Date/Time Format settings for dates, times, and timestamps, including locale defaults, ISO and U.S./day-first choices, IBM i date patterns (`*MDY`, `*MDYY`, `*DMY`, `*DMYY`, `*YMD`, `*YYMD`), and IBM i ISO time patterns (`*ISO`, `*ISO12`).
- Added persistent Save As format selection and labeled the Excel export option `XLSX`.

### Changed
- Grouped the three Excel date/time settings under one Settings entry and aligned their controls with the Connection Settings layout.
- Added IBM i-style timestamp display choices: `YYYY-MM-DD HH:MM:SS` and `YYYY-MM-DD HH.MM.SS`.
- Time-only Excel cells now display seconds without a fractional `.000` suffix; timestamps retain their configured fractional-second display.

### Fixed
- Corrected XLSX worksheet dimensions and shared-string counts, and preserved XML namespaces while updating package metadata.
- Changed time number formats to Excel-compatible precision and corrected the locale timestamp format so Excel opens exported workbooks without repairing their styles.
- Preserved oversized integer values and fractional JDBC TIME values through the bridge to avoid precision loss during export.

### Release
- Built the Windows x64 executable and macOS Apple Silicon DMG installer; updated the existing GitHub releases in place with the new artifacts and corrected macOS installation instructions.
