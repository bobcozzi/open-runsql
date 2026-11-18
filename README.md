# IBM i RunSQL

A desktop SQL and CL client for IBM i by Bob Cozzi.

This public repository contains release downloads, user information, and the
changelog. Application source code and ongoing development are maintained in a
private repository.

## Downloads

Download installers and executables from
[GitHub Releases](https://github.com/bobcozzi/open-runsql/releases).

### 2.0.4 Native Release

The native application connects to IBM i using Go and does not require Java.
Host feature availability depends on IBM i release, PTF levels, configuration,
and authority.

| Platform             | Release                                                                              | Download                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, Apple Silicon | [2.0.4 macOS](https://github.com/bobcozzi/open-runsql/releases/tag/v2.0.4-macos)     | [IBMi-RUNSQL-2.0.4-macos-arm64.dmg](https://github.com/bobcozzi/open-runsql/releases/download/v2.0.4-macos/IBMi-RUNSQL-2.0.4-macos-arm64.dmg) |
| Windows, x64         | [2.0.4 Windows](https://github.com/bobcozzi/open-runsql/releases/tag/v2.0.4-windows) | [IBMi-RUNSQL.zip](https://github.com/bobcozzi/open-runsql/releases/download/v2.0.4-windows/IBMi-RUNSQL.zip)                                   |

The macOS application and DMG are signed and notarized. The Windows ZIP contains
an unsigned, cross-compiled executable that has **not been runtime-tested on
Windows**. Extract the ZIP before launching the executable; Microsoft Edge
WebView2 Runtime is required.

The native app includes message queues, inquiry replies, queue descriptions,
cancellable IFS/spool downloads and views, IFS list exports, and status-based
spool filtering. IFS Text/Hex viewing, extended attributes on IBM i 7.3 and
newer with native attribute retrieval on older hosts, SCS/AFPDS spooled-file
viewing, CL choice popups, and Auto theme selection remain available. Connection
loss does not automatically replay SQL or CL commands.

Version 2.0.4 adds native SQL catalog completion, per-connection statement
history, Reconnect, grouped settings, and selected-row clipboard export.
See the [changelog](CHANGELOG.md) for details.

iPad support remains private development only. No public iPad asset is provided.

### Legacy Java-Based Releases

| Platform             | Latest published release                                                             |
| -------------------- | ------------------------------------------------------------------------------------ |
| macOS, Apple Silicon | [0.1.2 macOS](https://github.com/bobcozzi/open-runsql/releases/tag/v0.1.2-macos)     |
| Windows, x64         | [0.1.2 Windows](https://github.com/bobcozzi/open-runsql/releases/tag/v0.1.2-windows) |

Choose the `.dmg` or `.exe` under the release's **Assets** section. Where supplied,
the `.sha256` file contains a checksum for the corresponding download. GitHub's
automatically generated "Source code" archives contain this repository's
documentation, not the application source.

## Requirements

- The native 2.0.4 release does not require Java.
- Windows 2.0.4 requires Microsoft Edge WebView2 Runtime.
- The legacy 0.1.x releases require Java 17 or newer on your PATH.
- An IBM i user profile and network access to the IBM i host servers are required.
- IBM i release and PTF levels gate host-dependent features. Consult each
	release's notes.

## Installation

### macOS

Open the downloaded DMG and drag the application into Applications. Launch the
application from Applications or Finder; Terminal is not required. The published
Mac releases are signed and notarized.

### Windows

For 2.0.4, download `IBMi-RUNSQL.zip`, extract it to a local folder, and launch the
executable from the extracted folder. Microsoft Edge WebView2 Runtime must be
installed. This executable is unsigned and cross-compiled; Windows runtime behavior
has not been tested. Review the release notes before deployment.

For legacy 0.1.x releases, download the Windows executable and launch it with
Java 17 or newer available on your PATH.

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