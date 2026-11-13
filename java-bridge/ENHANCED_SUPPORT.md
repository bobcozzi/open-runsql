# CMD_RUN enhanced support

The Go settings binding `SetAppSetting("clExecutionMode", value)` accepts
`standard` (the default, using the separate CommandCall job), `sqlJob`
(using a prepared `CALL QSYS2.QCMDEXC(?)` in the connection's JDBC job), or
`enhanced` (using CMD_RUN in that JDBC job). `GetAppSettings` returns the
persisted value as `clExecutionMode`. Switching modes does not require a
capability check and applies to existing connections on their next CL run.
Enhanced execution requires a successful check or installation for the current
`enhancedSupportLibrary` on that connection; otherwise it returns an error
without falling back. Both SQL-job modes close the current JDBC cursor. SQL-job
execution reports failures without retrying: the command may already have run.
Successful QCMDEXC calls return an empty CL message list; they do not capture
the command's job-log messages.

These operations use an existing connection and run in its JDBC SQL job under the
connection's session lock. Requests and responses are JSON lines:

```json
{"id":"1","op":"checkEnhancedSupport","connectionId":"CONNECTION_ID","library":"MYLIB"}
{"id":"1","ok":true,"result":{"library":"OTHERLIB","programExists":true,"routineExists":true,"routineMatches":true,"installed":true,"installedVersion":"0.2.1","bundledVersion":"0.2.1","versionStatus":"current","configuredTarget":{"library":"MYLIB","programExists":false,"routineExists":false,"routineMatches":false,"installed":false,"installedVersion":null,"bundledVersion":"0.2.1","versionStatus":"unknown"},"installations":[{"library":"OTHERLIB","programExists":true,"routineExists":true,"routineMatches":true,"installed":true,"installedVersion":"0.2.1","bundledVersion":"0.2.1","versionStatus":"current"}]}}
{"id":"2","op":"installEnhancedSupport","connectionId":"CONNECTION_ID","library":"MYLIB"}
{"id":"2","ok":true,"result":{"library":"MYLIB","programExists":true,"routineExists":true,"routineMatches":true,"installed":true,"installedVersion":"0.2.1","bundledVersion":"0.2.1","versionStatus":"current","version":"0.2.1"}}
{"id":"3","op":"upgradeEnhancedSupport","connectionId":"CONNECTION_ID","library":"MYLIB","expectedInstalledVersion":"0.1.0"}
{"id":"3","ok":true,"result":{"library":"MYLIB","programExists":true,"routineExists":true,"routineMatches":true,"installed":true,"installedVersion":"0.2.1","bundledVersion":"0.2.1","versionStatus":"current","version":"0.2.1","previousVersion":"0.1.0","cppMember":"C123456789","sqlMember":"S123456789","module":"M123456789"}}
{"id":"4","op":"repairEnhancedSupport","connectionId":"CONNECTION_ID","library":"MYLIB","expectedState":{"programExists":true,"routineExists":false}}
{"id":"4","ok":true,"result":{"library":"MYLIB","programExists":true,"routineExists":true,"routineMatches":true,"installed":true,"installedVersion":"0.2.1","bundledVersion":"0.2.1","versionStatus":"current","version":"0.2.1","cppMember":"C123456789","sqlMember":"S123456789","module":"M123456789"}}
```

`library` is normalized to uppercase and must be a simple IBM i name of at most
10 characters. Install, upgrade and repair targets must not begin with `Q` except
`QGPL`, case-insensitively. `QTEMP`, `QSYS`, special names and qualified names
are also rejected for discovery and execution.
Errors use the bridge's usual `{ "id": ..., "ok": false, "error": ... }`
envelope. Installation fails on a collision, including an already installed
instance; upgrading is a separate explicit operation.

`checkEnhancedSupport` searches visible schemas in `QSYS2.SYSROUTINES`. A
candidate must have SQL routine name and specific name `CMD_RUN`, routine type
`FUNCTION`, function type `T` (table), parameter style `DB2SQL`, both routine
and specific schemas equal to the candidate library, external name
`library/CMD_RUN`, and a visible `*PGM` named `CMD_RUN` in that library. The
library must be a supported simple name; unsupported schema names, `QTEMP`
and `QSYS` are ignored. Other Q-prefixed schemas remain discoverable, but
cannot be installation, upgrade or repair targets. An older installation in such a
schema is not automatically upgraded and remains unavailable for enhanced CL.

`installations` is always an array of the distinct valid installed candidates,
including the configured target if it passes the same check, even if the catalog
discovery query omitted it. Each entry has the target-check fields `library`,
`programExists`, `routineExists`, `routineMatches`, `installed`,
`installedVersion`, `bundledVersion`, and `versionStatus`; the boolean fields
are true for entries in this array. `installedVersion` is a numeric dotted
version string or `null`, not a JSON number. Entries are sorted by descending
numeric version, with unknown versions last, then lexicographically by library
for equal versions (including unknown versions). Numerically equivalent versions
such as `1.10` and `1.10.0` tie. The array is empty when no candidate passes the
installed check. Unsupported schemas, mismatched routines and missing programs
are excluded; duplicate schema rows do not create duplicate entries.

An installed matching routine in the configured `library` always wins, even
when its version is unknown or another schema contains a newer version. If it
is absent, the highest numeric installed version wins; numeric versions rank
above unknown versions, and ties use the lexicographically smallest schema. The
top-level `library` is the selected routine schema, and consumers should pass
that value to `executeEnhancedCL` for schema-qualified invocation. When both
versions are known and the best alternative is strictly newer, `newerAvailable`
contains its target-check status, including `library` and `installedVersion`.
It is omitted for unknown or equal versions. This information does not change
the selected routine or its upgrade eligibility.

`configuredTarget` always contains the target-only check for the requested
library, including `programExists`, `routineExists`, `routineMatches`, and
`installed`. When no candidate is found, the top-level result is also that
target-only check, with `installed=false`, so target collisions remain visible
without being confused with a discovered installation. `programExists`
indicates a visible `*PGM` named `CMD_RUN`; `routineExists` indicates any visible
routine named or specifically named `CMD_RUN` in the checked schema.
`routineMatches` indicates a candidate-shaped routine; `installed` means that
program and matching routine were found. Neither verifies the program's
implementation, signature, execute authority, or functional behavior. Catalog
and object visibility depend on the user's authorities, so a negative check is
not proof of absence when the user cannot list all objects.

`bundledVersion` identifies the bundled CMD_RUN sources independently of the
bridge version. It is `0.2.1` because existing `0.1.0` installations were built
with `ACTGRP(*NEW)`, while this installer uses `ACTGRP(*CALLER)`. The installer
places this version in the SQL routine label and comment and in the program's
ASCII text, which is at most 50 bytes. The existing installation response's
`version` field remains available and contains the bundled CMD_RUN version.

`installedVersion` is derived from the first whitespace-delimited token of the
nonblank `QSYS2.SYSROUTINES` `LONG_COMMENT` and `ROUTINE_TEXT` fields for the
matching routine. Tokens must contain only numeric components separated by dots.
Unversioned descriptive text is ignored; malformed tokens starting with a digit,
conflicting numeric fields, an ambiguous routine, no numeric token, or an
absent matching visible program or routine produce a null version and
`versionStatus` of `unknown`. Otherwise `versionStatus` is
`older`, `current`, or `newer` relative to the bundled version. Components are
compared numerically with missing trailing components treated as zero. These
fields report catalog metadata, not proof of the program's actual contents;
they do not trigger installation or replacement.

Installation requires `autoCommit=true`, an existing writable library, access to
`QSYS2.QCMDEXC`, SQL catalog services and commands, the IBM i C++ compiler and
the SQL tooling needed by `RUNSQLSTM`. Installation occurs only in response to
the explicit `installEnhancedSupport` request; `checkEnhancedSupport` never
installs anything. The installer creates `MYLIB/QCOZZISRC` as a source physical
file with `RCDLEN(142)` and no initial member when the file is absent. If the
file already exists, the installer verifies that it is a source physical file
with a non-binary `CHAR` SRCDTA field of at least 100 characters. An incompatible
file stops installation before any member is added. For a new file, members
`CMDRUNCPP` (type CPP) and `CMDRUNSQL` (type SQL) are used; when reusing an
existing file, unique member names are chosen so existing members are not
overwritten. The installer adds the C++ member, uploads its bundled source using
batched JDBC inserts, then adds and uploads the library-rewritten SQL member.
It compiles `CMD_RUN` with `CRTCPPMOD`, binds the
program using `CRTPGM ACTGRP(*CALLER)`, and registers the SQL member with
create-only SQL. The module and program both use `REPLACE(*NO)` and
`AUT(*ALL)`; the module is retained in the target library. Both members and the file
remain in the selected library for inspection. The original source files are
read at Maven build time; none are written back.

Because CMD_RUN's implementation is C++, discovery checks for library `QCPPLE`
with `QSYS2.OBJECT_STATISTICS` before offering installation, upgrade or repair.
If the library is not visible, no CMD_RUN source members are added or uploaded
and no module build or replacement is attempted. For an Enhanced profile, the
application uses the SQL-job `QSYS2.QCMDEXC` function for that connection and
asks the user to reconnect after the C++ compiler is installed. This check is
specific to the C++ component; an RPG IV source component does not need it.

Installation checks only the configured target library, not other discovered
schemas. Discovery never installs, drops, replaces, or modifies anything.

## Explicit Repair

Repair is a separate bridge operation, not an automatic installation, upgrade,
or fallback. The caller must obtain explicit user confirmation before sending it.
The confirmation must identify the configured target library and clearly state
that the existing `CMD_RUN` program will be replaced, even if it is unrelated
to this project. The bridge cannot verify confirmation or establish program
ownership, implementation, or safety to replace. The Go and frontend clients
do not currently expose this operation.

Send the target library and `expectedState` with the exact JSON booleans
`programExists: true` and `routineExists: false`, based on the configured-target
check. The bridge independently checks that a visible `*PGM` named `CMD_RUN`
exists and no visible routine has the name or specific name `CMD_RUN` in that
library. Missing programs, routine-only targets, matching or mismatched routines,
and ambiguous routines are refused; this operation never replaces a routine.
These checks depend on object and catalog visibility and are not proof that
hidden objects are absent. Repair requires `autoCommit=true`, the same host
facilities and authorities as installation, and closes the current JDBC cursor.

If `QCOZZISRC` exists, repair verifies it with the same source-file metadata
checks as upgrade before adding anything. If it is not visible, repair attempts
create-only `CRTSRCPF` with `RCDLEN(142)` and verifies the resulting file. An
existing inaccessible, incompatible, or concurrently created file causes a
failure, not reuse without verification or replacement. Repair adds random,
create-only CPP and SQL members and writes bundled sources through create-only
QTEMP aliases. It compiles a random module with `REPLACE(*NO)`; it then checks
the program-only state again immediately before `CRTPGM REPLACE(*YES)`, using
that module, `ACTGRP(*CALLER)`, `AUT(*ALL)` and versioned program text. It checks
the program-only state again immediately before `RUNSQLSTM` executes `CREATE
FUNCTION` and the bundled labels and comments, then checks the target and
version. Successful responses include `version`, `cppMember`, `sqlMember` and
`module`, identifying retained artifacts.

Program replacement moves the prior program to `QRPLOBJ`; existing activations
may continue, and the new program has public authority `*ALL`. This can affect
other users and applications, including when the existing program is unrelated.
The checks are not atomic and the connection lock does not exclude other jobs.
Another job can change or replace the program after a check, including with an
unrelated program, and the bridge cannot distinguish identical-looking changes.
Create-only function registration prevents replacing a routine that appears
after the check, but can fail after program replacement. Coordinate exclusive
administrative access for the entire operation and ensure sufficient catalog
and object authority; the checks cannot eliminate races or visibility gaps.

There is no transaction, rollback, automatic retry, or deletion of the source
file, members, module, program, or routine. Only aliases created by the request
are dropped. A failure reports the stage and generated names: the file and
artifacts may be pre-existing, absent, retained or incomplete, the program may
already have been replaced, and the routine may be absent or partially
registered. Inspect the objects, source, module and host job log before manual
recovery; do not blindly retry. No host validation is implied by unit tests.

## Explicit Upgrade

The caller must show the user the target library, installed and bundled versions,
and the risks below, and send `upgradeEnhancedSupport` only after explicit user
confirmation. The bridge cannot verify that a UI has obtained confirmation. Pass
the exact `installedVersion` string from the target-only check, not a numerically
equivalent spelling. The target must still have one matching CMD_RUN table
function and program, with an unambiguous numeric version strictly older than
the bundled version. Unknown, changed, current, newer, missing or conflicting
targets are refused. Checks are target-only, even if discovery selected another
library. The connection must have `autoCommit=true`; the current cursor is closed.

Unlike installation, upgrade requires an existing `QCOZZISRC` that can be
verified through `QSYS2.SYSTABLES` and `QSYS2.SYSCOLUMNS` as a physical source
file with a non-binary `CHAR` SRCDTA field of at least 100 characters. Missing,
inaccessible or incompatible metadata stops the operation. Two randomly named
members are added with the substituted SQL routine label in their text, including
the bundled version. Existing members are never overwritten, reused or removed. Source is
inserted into the new members through create-only QTEMP aliases; a member or
alias collision fails without retry. A randomly named target-library module is
compiled with `REPLACE(*NO)` and retained. The target is checked again immediately
before `CRTPGM` replaces `CMD_RUN` using the explicit new module and entry module,
`ACTGRP(*CALLER)`, `AUT(*ALL)` and versioned program text.

The target is checked once more before `RUNSQLSTM` executes the bundled SQL
definition as `CREATE OR REPLACE FUNCTION`, followed by its label and comments.
There is no explicit `DROP FUNCTION`. However, IBM documents that `OR REPLACE`
effectively drops the old definition before replacement, while retaining function
grants. Dependent objects or references can be affected, and existing routine
labels and comments are replaced. Review dependencies and authorities before
confirming; this is not a metadata-only update. Program replacement moves the
old program to `QRPLOBJ`, and its old activations can continue. The new program
uses public authority `*ALL`; review the security implications before confirming.
See IBM's [external table function documentation](https://www.ibm.com/docs/en/i/7.5.0?topic=statements-create-function-external-table)
and [CRTPGM documentation](https://www.ibm.com/docs/en/i/7.5.0?topic=ssw_ibm_i_75/cl/crtpgm.htm).

The checks and replacements are not atomic and do not lock out other jobs. A
concurrent change between a check and a command can cause an unintended program
or routine replacement, including a downgrade, or create a missing function.
Catalog identity and version tags do not establish the program's implementation
or detect replacement by an identically tagged object. Coordinate exclusive
administrative access for the entire upgrade; the session lock protects only
this bridge connection, not other jobs or clients.

On failure, no retry or rollback is attempted and the bridge issues no explicit
source, module or target deletion. The error identifies the stage and generated
names; some may not exist, may have collided with pre-existing objects, or may
be incomplete. The program and function can already have changed independently,
and a failed registration can leave metadata missing or partially updated.
Inspect the target objects, retained source and module, dependencies and host job
log before any manual recovery; do not blindly repeat the request. Successful
responses return `previousVersion`, `version`, `cppMember`, `sqlMember` and
`module` in addition to the target check. These identify retained artifacts, not
proof of functional behavior.

For a fresh install, `QCOZZISRC` is created only when absent. An existing file is
reused only after its source-file type and SRCDTA width are verified; existing
members are left untouched, and unique members are added for this install. Each
member is added and uploaded before the next member is added. Member-specific
SQL inserts use randomly named, create-only aliases in the SQL job's `QTEMP`;
only an alias successfully created by this request is dropped. An alias creation
collision never causes the existing object to be dropped. Alias cleanup failure
is reported; a lost connection can leave an alias until the job ends.

The compiler can produce a listing in the job's output queue. SQL registration
uses `COMMIT(*NONE)` and can leave the module, program or routine in place if a later
step fails. There is no automatic retry or rollback of source or target objects.
An error identifies the stage and warns that `QCOZZISRC` may contain incomplete
retained members. Inspect the file, target objects and host job log before
manually resolving a partial installation; do not delete anything without
confirming its ownership and contents.

The prechecks do not lock out other jobs. Create-only program and routine
creation prevent replacement, but concurrent administrators should not modify
the same file, members or target while installation runs. The bridge has not been
validated against an IBM i host; source-file and member commands, SQL aliases,
compiler options, CCSID conversion, SQL job commitment, catalog visibility and
command behavior require host testing.