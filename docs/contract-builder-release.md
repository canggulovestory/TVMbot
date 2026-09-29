# Contract Builder checkpoint — 29 September 2026

## Implemented, not deployed

The private `/contract` route is wired into the Node app and Nginx configuration. The editor supports any manually entered property, linked document/sidebar fields, revision-checked autosave, passport upload and explicit candidate review, and immutable downloadable PDF versions.

The source master is represented by `contracts/template-v1.json`. A character-frequency comparison against all thirteen source-PDF body pages matched exactly before field substitutions. Typography and signature columns are reconstructed in HTML/CSS; the original PDF itself is not a fillable form.

## Evidence

- Real HTTP tests deny anonymous, owner-role, other-staff and cross-origin access. Current roles are re-resolved from the user store in `index.js`.
- Private files use 0600 permissions under a 0700 contracts directory. Generated PDF hashes are checked when downloaded. Prior versions survive subsequent edits.
- Offline Tesseract processes the checked-in **synthetic** image fixture. Passport-number checksums are validated. Ambiguous MRZ dates and unreadable fields remain candidates requiring human entry/review; issue date and birthplace are not extracted from visual-zone labels yet.
- Browser test: create draft → edit tenant/property → upload synthetic image → approve only passport number → finish annual payment/date fields → generate revision 4 → protected download link appears. Desktop and 390px phone layouts inspected.
- Actual Chromium output has thirteen base pages. Signature-page layout visually inspected; long additional agreements continue across pages and pagination asserts that no body text changed.
- Slow-preview regression test prevents edits made during a preview refresh from being stranded unsaved.
- Missing Chromium produces an actionable failure and leaves the saved draft intact, with no generated version.

## Runtime requirements before rollout

- Node >=22.12 (pinned Puppeteer dependency requirement).
- Sandboxed Chromium, set through `CONTRACT_CHROME_PATH`; current Linux default is `/usr/bin/chromium`. **Do not add `--no-sandbox` to make a root-run service work.** Inspect the live service identity and provision a non-root renderer/service first.
- `pdfinfo` and `pdftoppm` (Poppler) for passport PDFs. Maximum three PDF pages, 10 MB uploads, 25-megapixel input images, bounded conversion/OCR deadlines.
- Offline OCR language data is installed from pinned `@tesseract.js-data/eng`; no runtime CDN or external vision API is used.
- Install/verify matching local fonts and visually recheck pagination on Linux. Current rendering QA used Chrome on macOS; fonts are not bundled yet.
- Verify a private backup of DATA_DIR before rollout. Contract data lives in `DATA_DIR/contracts`, outside the public web root; include JSON, PDF and passport source files in backup and restore checks.
- Verify current live revision, preserve newer changes, validate Nginx, then test signed-in and anonymous requests online with synthetic records. No live restart, push or deployment was performed for this checkpoint.

## Remaining acceptance items

- Add explicit removal of stored source passports (including reupload history/retention handling) before processing real passports in production.
- Move company/payment instructions from the source template into administrator-only configuration and snapshot that configuration per draft. The current version is locked to the supplied master; do not push its payment instructions to a public repository.
- Show the passport source page beside review candidates, rather than only providing the protected original download.
- Add the remaining workflow markers (READY/SENT/SIGNED/ARCHIVED) and optional-missing-field warnings; current persisted statuses are DRAFT/GENERATED.
- Full visual review of every Linux-rendered page, including long names/addresses and all table continuation cases. A single oversized table block fails safely instead of clipping.
- Template consistency review: Article 4 has an English/Indonesian inclusion mismatch; page 9 has both 72-hour and one-day access notices. These were preserved and are disclosed before PDF generation, not silently rewritten.
- `npm audit` reports an existing high-severity `sharp@0.35.3` advisory through Baileys, not the new OCR/PDF dependencies. Assess and patch separately before the release gate.

Run `node --test` after any change. Do not describe this checkpoint as live or the whole Phase 1 as finished.

## Release preparation — 29 September 2026

- Passport removal now deletes current and historical source files and extraction candidates while retaining approved fields and PDFs. Reupload removes superseded sources. Backups follow their own retention schedule.
- Administrator-only company settings live in private `DATA_DIR/contracts/company.json` (0600) and are snapshotted per new draft. The repository template contains placeholders instead of private payment details. Missing company names block final PDF generation.
- PDF generation uses `CONTRACT_RENDERER_DIR=/opt/tvm-contract-renderer` and `CONTRACT_CHROME_PATH=/usr/bin/google-chrome`. A non-root `tvm-renderer` worker receives a minimal environment without app credentials. Chromium sandboxing stays enabled. `ops/prepare-contract-renderer.sh` installs root-owned renderer code, dependencies, and Node outside `/root`.
- Poppler, Chrome, and Liberation fonts are installed on the VPS. Both Linux PDF tests pass. Local release suite: 113 passing tests. npm audit: zero vulnerabilities after the compatible sharp update.
- Private production data and environment were backed up and the archive listing verified before rollout. Prior revision: `64747a0`. Backups: `/root/tvm-backups/contract-release-*.tar.gz`.

Rollback: restore prior app revision and Nginx configuration, restart `tvmbot-v4`, and retain contract data. Do not overwrite new contract records with an older backup during a code-only rollback.

Private company settings must be entered by the administrator or copied from the supplied template with explicit transfer approval before creating real contracts. Source-page comparison, expanded workflow markers, optional-field warnings, and oversized table continuation remain follow-up work. Preserved bilingual wording inconsistencies are disclosed before generation.
