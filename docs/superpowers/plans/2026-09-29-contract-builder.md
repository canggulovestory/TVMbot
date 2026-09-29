# Contract Builder Implementation Plan

> **For agentic workers:** Use executing-plans inline, as requested by the user. Run a failing test before each implementation change.

**Goal:** Build the approved private passport-to-contract workflow at `/contract`.

**Architecture:** Isolated CommonJS contract module, existing staff authentication, private revisioned filesystem storage, centralized typed fields and a shared HTML document renderer. Server OCR stays private; a bounded PDF worker prints the approved template.

**Tech Stack:** Existing Node.js HTTP server and vanilla browser JavaScript; pinned Chromium PDF renderer and server OCR selected and verified before installing dependencies.

**Spec:** `docs/superpowers/specs/2026-09-29-contract-builder-design.md`

## Global constraints

- No passport, extraction, contract instance or credential committed to Git or placed in the public web root.
- Base legal text remains locked; annual/upfront terms only in Phase 1.
- All villas, including manually entered external properties, are supported.
- 13 base A4 pages; additional pages are allowed to prevent clipping.
- No production rollout until extraction, persistence, access checks and PDF tests pass.
- Preserve current Telegram, Financial and unrelated website behavior.

## 1. Central fields and validation

Checkpoint: core schema implemented and six tests pass. Additional renderer escaping tests remain with task 3.

Files: `contracts/schema.js`, `test/contracts-schema.test.js`.

- [ ] Write real tests using `blankContract()`, `applyFields(data, patch)`, `validate(data, today)` and `suggestCheckout(date, months)`; verify they fail before implementing.
- [ ] `applyFields` accepts only known dotted field keys and string values, rejects unknown fields/oversize text without truncation, and returns a new object. Server configuration and template text cannot arrive through this API.
- [ ] Implement strict calendar dates, bounded money represented in minor units, valid times, HTTPS/HTTP map links, required fields and deposit/upfront consistency checks. Hand-check leap-year and end-of-month cases.
- [ ] Run `node --test test/contracts-schema.test.js`; check that a script-looking name remains plain data and is escaped by the later renderer rather than evaluated.

Example independent assertion:
```js
assert.equal(suggestCheckout('2026-11-01',12),'2027-10-31');
assert.throws(()=>applyFields(blankContract(),{'template.html':'<script>'}));
```

## 2. Private draft persistence

Checkpoint: draft create/read/list/update, permissions, revision conflicts and restart persistence implemented; four tests pass. Immutable generated PDF snapshots remain with task 5.

Files: `contracts/store.js`, `test/contracts-store.test.js`.

- [ ] Test a real temporary directory: create/reopen, edit conflict, unauthorized access, immutable generated versions, malformed storage and more than 200 records.
- [ ] Implement `createStore(root)` exposing `create(actor)`, `get(actor,id)`, `list(actor)`, `update(actor,id,revision,patch)`. Actor is trusted server session data, never request JSON. Staff access their own records; admins access team records. Unknown roles are denied.
- [ ] Serialize mutations, write through exclusive temporary files followed by rename, use directory 0700/file 0600, UUID identifiers, and compare revisions. Corrupt data must throw, never reset to an empty store.
- [ ] Run `node --test test/contracts-store.test.js`; independently open saved JSON and verify revision/history and permissions.

## 3. Template and editor

Files: `contracts/template.js`, `contracts/template-v1.json`, `admin/contract.html`, `admin/contract.js`, `admin/contract.css`, `test/contracts-render.test.js`.

- [ ] Extract all source text and visually compare every page. Identify replacements in both language versions and signature names. Keep a source checksum and field occurrence inventory.
- [ ] Test `renderContract(data,{editable:false})`: all occurrences update, legal text does not accept client replacements, malicious values are escaped, no unresolved required tokens remain in final mode.
- [ ] Add inline inputs with a synchronized sidebar, extraction review, warnings, draft list and revision-aware autosave. Use textContent/escaped rendering for user values.
- [ ] Exercise keyboard navigation, mobile drawer, unsaved changes, conflict/error recovery and reload against the real module API.

## 4. Protected HTTP, uploads and extraction

Checkpoint: isolated draft HTTP handler tested with real localhost requests; session, role, origin, per-record access and revision guards pass. It is not yet mounted in the production entry point. Upload/extraction work remains.

Files: `contracts/routes.js`, `contracts/extract.js`, `index.js`, `admin/login.html`, `ops/nginx-tvmbot.conf`, `test/contracts-http.test.js`, `test/contracts-extract.test.js`.

- [ ] Start a real ephemeral HTTP server in tests with trusted-session lookup injection; assert signed-out, owner-role, cross-origin and other-staff reads/writes fail.
- [ ] Mount `/contract` and `/api/admin/contracts` without changing other routers. Resolve current user role and bind every object/file request to the authorized actor.
- [ ] Reject mismatched file signatures, oversized/page-heavy uploads and unsupported types. Use subprocess argument arrays, deadlines and bounded output. No shell interpolation or remote document URL fetches.
- [ ] Store raw extraction separately; approve selected candidate values through a revision-checked operation. Source evidence and nullable confidence are retained. Test unreadable pages, wrong dates and conflicting reuploads using synthetic documents.

## 5. PDF snapshots and release

Files: `contracts/pdf.js`, `test/contracts-pdf.test.js`, `docs/contract-builder-release.md`.

- [ ] Test final generation against a saved reviewed revision; reject stale data and validation errors before invoking the renderer.
- [ ] Print locally bundled HTML/fonts with external requests blocked; persist the completed PDF plus exact input/template/configuration snapshot before reporting GENERATED. Duplicate request identity must return the existing version.
- [ ] Render all generated pages as images and inspect against the source, including long names/addresses and appendices. Assert searchable text and no clipping or browser headers.
- [ ] Run all existing and new tests. Inspect live deployment revision, verified private backup, Nginx syntax and renderer/OCR readiness before rollout; do not overwrite newer changes.
- [ ] Verify authenticated end-to-end creation with synthetic data online and denied public downloads. Record exact release and rollback steps and any remaining limitations.
