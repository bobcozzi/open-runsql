# IBM i Run SQL 0.1.2

- Live SQL catalog suggestions for qualified tables/views and routines, aliased columns, table-function result columns, and named parameters. Press Ctrl+Space to request suggestions explicitly, including at a SELECT-list star. Suggestions never execute the edited statement and use a separate metadata connection to preserve the user result cursor.
- Choose CommandCall, QSYS2.QCMDEXC, or CMD_RUN per saved connection. CMD_RUN runs in the SQL job and returns detailed command messages.
- Bundled CMD_RUN 0.2.1 with discovery, install/upgrade/repair, notification policies, compatible source-file reuse, and progress messages. C++ source builds check for QCPPLE first; absent compiler detection falls back to QCMDEXC for the connection.
- SQL job identity appears before Connect, empty CMD_RUN results preserve the existing grid, and character indentation remains visible without fixed-width right padding.
- Autocomplete popups can cross the editor/results splitter and follow the selected color theme, including the selected-item detail panel.

## Requirements and Scope

Java 17 or newer is required. Enhanced CMD_RUN installation requires the IBM i C++ compiler. QCMDEXC availability depends on host release/PTF level and user authority.

Live completion is an initial implementation: nested queries/CTEs, user-job QTEMP objects, and later SET SCHEMA changes are not resolved. Routine parameters are catalog suggestions, not a full signature-help panel. Catalog metadata coverage varies by host release and PTFs.

Automated frontend, Go, and Java tests are run before packaging. Cross-building the Windows executable is not a Windows runtime test. Please report platform-specific behavior with the exact SQL and caret position where relevant.