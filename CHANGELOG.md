# Changelog

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
