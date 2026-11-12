# macOS releases

Direct distribution requires a Developer ID Application signing identity and
Apple notarization credentials stored in a Keychain profile. The profile defaults
to `ibmi-runsql-notary`; set `NOTARY_PROFILE` to use another profile. Keep the
private key and app-specific password out of the repository.

From the repository root, build a release with:

```sh
make -C wails-app release-dmg \
  SIGN_IDENTITY='Developer ID Application: Robert Cozzi (D3W8253385)'
```

The target builds the frontend and app, signs and notarizes the app, staples its
ticket, then signs and notarizes the DMG and staples its ticket. The output is
`wails-app/build/ibmi-runsql-notarized.dmg`. The target refuses to overwrite an
existing release; set `RELEASE_DMG` to a new absolute path for another build.

The current build is for the build Mac's architecture and does not bundle Java.
Recipients need Java 17 or newer and network access to their IBM i system.