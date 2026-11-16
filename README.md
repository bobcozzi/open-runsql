# IBM i RunSQL

A desktop SQL and CL client for IBM i by Bob Cozzi.

This public repository contains release downloads, user information, and the
changelog. Application source code and ongoing development are maintained in a
private repository.

## Downloads

Download installers and executables from
[GitHub Releases](https://github.com/bobcozzi/open-runsql/releases).

| Platform | Latest published release |
| --- | --- |
| macOS, Apple Silicon | [0.1.2 macOS](https://github.com/bobcozzi/open-runsql/releases/tag/v0.1.2-macos) |
| Windows, x64 | [0.1.2 Windows](https://github.com/bobcozzi/open-runsql/releases/tag/v0.1.2-windows) |

Choose the `.dmg` or `.exe` under the release's **Assets** section. Where supplied,
the `.sha256` file contains a checksum for the corresponding download. GitHub's
automatically generated "Source code" archives contain this repository's
documentation, not the application source.

## Requirements

- The published 0.1.x releases require Java 17 or newer on your PATH.
- An IBM i user profile and network access to the IBM i host servers are required.
- Later releases may have different requirements; consult their release notes.

## Installation

### macOS

Open the downloaded DMG and drag the application into Applications. Launch the
application from Applications or Finder; Terminal is not required. The published
Mac releases are signed and notarized.

### Windows

Download the Windows executable and launch it. Windows runtime behavior has not
yet been fully validated; review the release notes before deployment.

## Connecting

Enter the IBM i host, user, and password, select SQL or system naming, and enable
TLS as appropriate for your host. Connect to open a SQL/CL work session. Saved
connections can be managed in the Connections panel.

The application supports SQL scripts and results, CL commands and prompting,
connection profiles, and result exports. Features vary by release and host
capabilities.

## Release History

See [CHANGELOG.md](CHANGELOG.md) and each release's notes for changes and known
limitations. Binaries are distributed as release assets, not committed to the
repository's Git tree.

## Source Availability

Current application source code is private. The public Git history and release
tags now contain distribution documentation only. Copies of source code obtained
before this change are not affected by the repository migration.