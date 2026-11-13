# CMD_RUN Handoff - 2026-11-12

## Context

- The app runs SQL through a JDBC host job and CL through JT400 `CommandCall`
  in a separate remote-command job. Job-scoped state such as `OVRDBF` from
  that CL job is not visible to SQL in the JDBC job.
- The user authored the `CMD_RUN` C++ UDTF. It invokes QCAPCMD and returns CL
  messages, including first- and second-level text. An existing installation
  in `SQLTOOLS` was exercised from the VS Code SQL job; it returned useful
  diagnostic and escape messages. It was not replaced or rebuilt.
- Mapepire's `rccl` uses `CommandCall` in a remote-command job by default;
  its same-SQL-job `cl` path uses `QSYS2.QCMDEXC` and `QSYS2.JOBLOG_INFO`.
  The user does not want to rely on SQL job-log interfaces for this feature.
- A host-side Java routine using JT400's native on-thread CommandCall is an
  unverified research possibility, not a proven replacement for CMD_RUN.

## Current Files

- `src/cmd_run/CMD_RUN.CPP` and `src/cmd_run/CMD_RUN.SQL` were copied from
  `../open-UDTF/src/CMD_RUN/`. The original files were not edited.
- Review fixes in the copies address qualified prohibited command names,
  NULL/empty and invalid modes, SQL output-indicator order, message storage
  and API failure handling, receiver bounds, and the 256-message limit.
  Exceeding that limit raises an SQL error warning that the command may have
  run; do not retry an already attempted command automatically.
- `src/cmd_run/tests/cmd_run_test.mjs` compiles selected C++ functions with
  mocked IBM i APIs. It is not host code and does not compile the whole UDTF.
- The user may have made subsequent edits to the C++ file. Read the current
  file before making any more changes; do not revert those edits.
- Both source files must fit source-member data records of at most 100 bytes.
  As of this handoff, C++ max is 98 bytes, SQL max is 78 bytes, excluding line
  endings. Both files are ASCII.

## Verification

Portable tests passed against actual QMH structure definitions:

```sh
IBMI_QSYSINC_H=/Users/cozzi/Downloads/projects/open-UDTF/src/QSYSINC/H \
  node src/cmd_run/tests/cmd_run_test.mjs
```

No full IBM i C++ compile or host-side test of the revised source has been
performed. The tests mock host behavior, including the end-of-messages and
error paths; verify these against the real QMH APIs on IBM i.

## Next Steps

1. Upload and compile the revised source on IBM i. The app does not currently
   have the Code for IBM i extension's upload-and-compile workflow.
2. Use a separate test library and routine name. The copied SQL currently uses
   `CREATE OR REPLACE` for `SQLTOOLS.CMD_RUN` and points to
   `SQLTOOLS/CMD_RUN`; do not overwrite the user's existing installation.
3. Test successful and failing commands, message contents and NULL fields,
   qualified prohibited names, mode validation, no-message behavior, message
   limits and cleanup. Verify job-scoped overrides are visible to later SQL
   on the same connection, including the desired override scope.
4. Consider app integration after validation: use an existing configured
   CMD_RUN when available, otherwise CommandCall with its separate-job
   limitation clearly indicated. Select the path before executing a command;
   never retry a failed CMD_RUN execution automatically in another job.
5. Installation support is future work: source upload and compile where a C++
   compiler is available, or a V7R3-compatible save file with restore by an
   authorized user. RPG is not a universal compiler-free alternative.

## Worktree

The new `src/` files are untracked. `CHANGELOG.md` is modified, and there are
other unrelated untracked handoff and spreadsheet/DMG files. Preserve all user
changes; nothing was committed. No application integration was implemented.