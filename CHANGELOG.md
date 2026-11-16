# Changelog

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
