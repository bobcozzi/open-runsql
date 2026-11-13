# SQL Completion Backend

The existing Wails `App` exposes
`GetSQLCompletions(connectionID, kind, schema, object, prefix string)` returning
`([]SQLCompletion, error)`. It forwards the `sqlCompletions` bridge operation with
those fields (`connectionId` on the wire). The bridge's `result` is an array of
objects with string fields `name`, `kind`, `detail`, and optional `specificName`.
Empty successful results are arrays, not null.

Supported kinds:

| Kind | Catalog | Object Required | Selection |
| --- | --- | --- | --- |
| `tables` | QSYS2.SYSTABLES | No | Table name and table text |
| `columns` | QSYS2.SYSCOLUMNS | Yes | Columns in ordinal order, with data type |
| `routines` | QSYS2.SYSROUTINES | No | Functions and procedures, including overload identity |
| `tableFunctions` | QSYS2.SYSROUTINES | No | FUNCTION routines with FUNCTION_TYPE T |
| `parameters` | QSYS2.SYSPARMS joined to SYSROUTINES | Yes | ROW_TYPE P, IN and INOUT parameters in overload/ordinal order |
| `routineColumns` | QSYS2.SYSPARMS joined to SYSROUTINES | Yes | ROW_TYPE R result columns of table functions in overload/ordinal order |

Schema is mandatory for every kind. The backend does not resolve CURRENT SCHEMA
or offer schema discovery. Callers must infer or supply the schema. `object` for
routine lookups is the routine name, not the specific name; results can include
multiple overloads. Their `specificName` and detail's specific schema/name identify
the overload. Unnamed parameters do not match the name-prefix predicate.

Identifiers and prefixes are catalog values, not SQL expressions or quoted SQL
tokens. Case is preserved; callers must fold unquoted identifiers themselves and
decode delimited identifiers before calling. Inputs are limited to 128 characters
and cannot contain NUL. Unsupported kinds, absent required names, and non-string
bridge inputs are rejected before opening a metadata connection. Prefix matching
is literal: `!`, `%`, and `_` are escaped using `ESCAPE '!'`.

Each session captures a copy of its JDBC URL and credentials at connect. Its
dedicated read-only, auto-commit JDBC connection opens only on the first valid
completion request and is reused until disconnect/shutdown. Only this auxiliary
connection forces `naming=sql` and Toolbox `access=read only`, replacing inherited
URL overrides as well as setting its private properties. The user connection and
caller properties are unchanged. `setReadOnly(true)` is also called before any
catalog statement; the installed JT400 21.0.7 setter updates a client-side flag,
so it must not be described as a server authorization boundary.

A temporary credential-property copy is cleared after every connection attempt.
The retained copy is cleared after successful connection setup or on close. A
failed connect/setup retains it only to support retry until close. Clearing the
maps releases references, not immutable String contents or driver-owned copies.
A connection whose setup fails is closed, with cleanup errors suppressed onto the
original setup exception. A separate metadata
monitor serializes lookups and closure; lookups never acquire the user-session
lock, inspect edited SQL, execute routines, or change user cursors or workspace.
Queries use fixed prepared SQL, a 200-row SQL/JDBC/application cap, and a five-second
JDBC query timeout. Login uses the existing bridge login-timeout configuration;
the query timeout does not bound connection establishment or monitor queue time.
The separate host job does not inherit QTEMP objects or session-local changes.

Catalog semantics verified against IBM i 7.3 documentation:

- [SYSPARMS](https://www.ibm.com/docs/en/i/7.3.0?topic=views-sysparms):
  PARAMETER_NAME, PARAMETER_MODE IN/INOUT/OUT, ORDINAL_POSITION, DATA_TYPE,
  SPECIFIC_SCHEMA and SPECIFIC_NAME. ROW_TYPE P identifies parameters; R identifies
  table-function result columns (or scalar results before casting); C identifies
  results after casting. Table-function result ordinals follow the input
  parameters, n+1 through n+m. PARAMETER_MODE OUT alone does not distinguish
  result-column metadata; routineColumns uses ROW_TYPE R and restricts routines
  to FUNCTION / FUNCTION_TYPE T. SYSPARMS has no ROUTINE_SCHEMA column; its join
  uses SPECIFIC_SCHEMA and SPECIFIC_NAME, then filters SYSROUTINES.ROUTINE_SCHEMA
  and ROUTINE_NAME.
- [SYSROUTINES](https://www.ibm.com/docs/en/i/7.3.0?topic=views-sysroutines):
  ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, FUNCTION_TYPE T, and specific names.
- [SYSTABLES](https://www.ibm.com/docs/en/i/7.3.0?topic=views-systables) and
  [SYSCOLUMNS](https://www.ibm.com/docs/en/i/7.3.0?topic=views-syscolumns):
  TABLE_SCHEMA is the SQL schema name; SYSTEM_TABLE_SCHEMA is the system name.
  These lookups use TABLE_SCHEMA, not a guessed schema-column synonym.
- [Toolbox JDBC properties](https://www.ibm.com/docs/en/i/7.3.0?topic=jdbc-toolbox-java-properties):
  URL properties take precedence over a supplied Properties object.

This is documentation-backed V7R3 compatibility, not a live-host certification.
The target host's PTF level, authorities, catalog contents and actual driver/server
behavior have not been tested. No edited SQL is prepared or executed for completion.

## Editor Integration

The frontend completion source uses CodeMirror's SQL syntax tree to identify the
current statement and omit comments, strings and CL commands. Qualified FROM/JOIN
names request tables; TABLE(schema.name) requests table functions; aliases and
simple SELECT lists request table/view columns or table-function result columns.
Ctrl+Space requests completion explicitly, including at a SELECT-list `*`.
Selecting a column there replaces only that star, without executing the query.
Inside routine calls, named parameter suggestions include catalog data types and
insert `name => ` only after selection. This is not a full signature-help panel.

Metadata requests are cached for two minutes with a 128-entry limit, share pending
requests, and are discarded if the active connection changes. Live results use
only catalog names, never the edited SQL. Popup navigation takes precedence over
statement-history arrow keys. Standard SQL keywords remain available without a
metadata connection. The app supplies the saved default schema or login user for
unqualified names; SET SCHEMA, library-list resolution, CTEs, nested query scopes,
and user-job QTEMP objects are not resolved in this first version. Routine
overloads are shown with their catalog specific-name identity, not automatically
selected based on argument types.

Proxy/fake tests do not contact IBM i. The embedded bridge JAR must be packaged
in the normal release workflow before an installed app can use this operation.