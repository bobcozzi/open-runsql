# IBM i SCS / Spooled File Rendering (open-runsql)

## Page-stream structure (JT400 getPageInputStream)
- `getPageInputStream()` passes SCS control codes through VERBATIM (does NOT strip `0x34`). Text is returned in the job CCSID (EBCDIC); decode control bytes as raw values, NOT through CCSID (CCSID decode corrupts the framing: raw `34 C0 2F` becomes `\u0094 { \x07` — the column byte 0x2F got mangled to 0x07).
- `getInputStream()` = raw untransformed; `getTransformedInputStream()` = explicit transform. No PDF transform exists on host (only GIF/TIFF/ASCII-printer WSCST). ATTR_SCS2ASCII exists (id 113) but did NOT convert for our *SCS files.

## SCS control codes (confirmed via Microsoft HIS + IBM Personal Communications docs)
- Presentation Position PP `0x34 <fn> <nn>`: AHPP `0xC0` absolute column nn (1-based); RHPP `0xC8` move nn cols right; AVPP `0xC4` absolute line nn; RVPP `0x4C` move nn lines down.
- SHF `0x2B C1 nn xxyyzz t1-tn`: max print pos, left/right margins, horizontal tab-stop table. SVF `0x2B C2`: vertical equiv. Skip these (length-delimited).
- Line ends: NL `0x15`, LF `0x25`, RNL `0x06`. Page eject: FF `0x0C`, RFF `0x3A`. CR `0x0D` = left margin (no advance). NUL `0x00` ignored.
- Transparent: TRN `0x35 <len>` skip len bytes; ATRN `0x03 <len>` (HPT ASCII).
- HT `0x05` / VT `0x0B` = next tab stop (needs SHF table).
- SCS codes all in 0x00-0x3F range; EBCDIC text above.
- IBM Host Print Guide SC31-7145 is the canonical SCS reference.

## The winning renderer (frontend/src/scsRender.ts)
- Bridge sends format="raw" (raw page bytes, base64, no decode) for View/Download/PDF/Print.
- renderScsBytes(): byte loop; AHPP pads to column parm-1 (forward) / 1 space (backward); RHPP adds parm spaces; AVPP pads blank lines to line parm; RVPP flush + parm-1 blanks; FF/RFF push "\f" page marker; LF/NL/RNL flush line; TRN/ATRN skip; SHF/SVF skip by length; other <0x40 dropped; else EBCDIC Cp037 decode via a lookup table.
- renderSpoolText(base64) decodes b64->bytes->renderScsBytes.
- PDF: textToPdfBase64 splits lines on "\f" markers into pages, landscape (792x612) when any line >80 cols, font auto-shrinks so longest line fits.

## UI (all committed, branch v3-migration, pushed)
- Spooled Files: list+filter+sort, click-select row, right-click context menu (View / Copy row / Download PDF / Download Text / Save Raw / Print locally / sep / Move... / Hold / Release / Delete). Double-click = View.
- Viewer overlay: 1100px wide (132-col, no wrap), white-space:pre, copy-to-clipboard button left of Close.
- Move dialog: read-only file name + "Spooled File Nbr", Output queue + Library prefilled with current (type-over, CHGSPLFA-style), Hold *YES/*NO dropdown (defaults from file's ATTR_HOLD; *YES first), F4=List opens filterable output-queue picker (ListOutputQueues, capped 500).
- Hold on move: must re-find the file on the DESTINATION queue then hold that fresh reference (hold-before-move doesn't survive; move() re-reads attributes).
- Status column strips leading `*` (*READY -> READY).
- Connect panel: green GO button (disabled until a saved profile is picked) left of Save password.

## Build commands
- Frontend+app: cd wails-app/frontend && npm run build && cd .. && go build -tags production -o ibmi-runsql . (then rm -rf ~/Library/Caches/ibmi-runsql to clear embedded-jar cache)
- Bridge jar: cd java-bridge && JAVA_HOME=/Users/cozzi/.jdk/jdk-25.0.2/.../Home mvn -q clean package -DskipTests && cp target/ibmi-jdbc-bridge.jar ../wails-app/embed/
- Bindings after adding Go methods: ~/go/bin/wails3 generate bindings
- Run: pkill -9 -f ibmi-runsql first (stale processes served OLD jars repeatedly); IBMI_JAVA=<jdk25>/bin/java ./ibmi-runsql
