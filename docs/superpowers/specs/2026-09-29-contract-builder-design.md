# VillaManagers Contract Builder — Phase 1

## Purpose and source

Private contract creation at `https://thevillamanagers.cloud/contract`, for any property, not only saved TVM villas. Source of truth for wording and appearance: user-supplied `LEASE_AGREEMENT_TEMPLATE.pdf` (13 A4 pages). User's detailed September 29 brief is the functional specification. No passport has been uploaded or processed during design.

## Architecture and inspected evidence

The existing app is CommonJS Node.js using the native HTTP server in `index.js`, plain HTML/JS Admin pages, signed `tvm_admin` cookies and `auth-users.js`. Records are stored on the private VPS filesystem, not in the separate Financial Supabase database. Nginx proxies selected protected paths to port 3000. `ops/sync-and-deploy.sh` describes the main-branch deployment process; current live state must be rechecked before deployment.

Use these existing facilities, with a separately mounted contract module. Do not replace the app framework, alter Telegram, or write into Financial. Existing `zuzu-intake.js` is unsuitable for contract storage: it truncates its intake index to 200 entries, does not extract image text, and can copy uploads into Drive. Contract uploads must not use that path.

Recommended rendering: semantic, escaped HTML with fixed base-template page breaks and print CSS; server-side Chromium generates searchable PDFs. Use the same renderer for browser preview and PDF. Pin renderer and bundled fonts. Preserve the baseline 13-page structure; long values and appendices may add pages rather than clip text. PDF background overlays are rejected because dynamic text can overflow fixed boxes. A general-purpose rich text editor is unnecessary and would make locked-text enforcement harder.

## Workflow

1. Authenticate with the existing TVM login; return safely to `/contract` after sign-in.
2. Create a blank draft from the published, versioned master.
3. Display the full document centrally and a compact right sidebar. On small screens the sidebar becomes a drawer. Inline fields remain keyboard-accessible.
4. Optionally drop a JPEG, PNG or PDF passport in the uploader. Validate real content, byte size and page/pixel limits before parsing; reject encrypted, malformed or unsupported files with an actionable error.
5. Show extraction candidates next to their source page. Nothing replaces confirmed data before explicit approval. Missing/unreadable values remain blank.
6. Enter property, dates and payment data directly in the document or through the linked sidebar. Every occurrence references the same typed field.
7. Autosave acknowledged revisions to server storage. Display Saving, Saved, or Save failed truthfully; block final generation if changes are unsaved. Conflicting browser edits return a conflict rather than overwriting another revision.
8. Review errors and warnings; generate an immutable PDF snapshot only from the reviewed server revision.
9. Retain prior generated versions. Later edits return the working draft to DRAFT without modifying older PDFs.

## Field mapping

| Group | Editable fields | Repeated locations |
| --- | --- | --- |
| Tenant | Full name, birth place/date, nationality, ID number, phone, sex, residence, passport issue/expiry | Opening paragraph, tenant table, signature |
| Property | Optional code, name, address, bedrooms, bathrooms, map URL | Summary, English and Indonesian premises paragraphs, map line |
| Lease | Agreement date, duration, check-in date/time, check-out date/time | Opening, summary, duration article, rental-rate article |
| Payment | Annual rent, total rent, currency, deposit percentage/amount, first-payment amount/date, method | Summary, rental-rate and payment articles in both languages |
| Appendix | Optional additional agreements | After the base contract, with page numbering continued |
| Company configuration | Company name, NIB, header and registered addresses, representative, contact, bank details | Header, lessor table, bank block, signature |

Keep company configuration administrator-only. Snapshot configuration with each contract so subsequent company changes cannot rewrite existing contracts. Do not automatically import old phone numbers or company details from chat over the new source template.

Phase 1 is annual rent paid upfront. Do not expose monthly/instalment choices while fixed clauses say annual/upfront. Lease-duration suggestions are calendar-based, with explicit manual override and a mismatch warning. Deposit percentage and amount must agree or be explicitly resolved; money uses fixed decimal/integer minor units rather than floating-point arithmetic. Date and amount formatting must update both language versions consistently.

Passport mapping includes only values actually present: full name, birth place/date, nationality, document number, sex and issue/expiry dates. Never infer phone or residential address. Keep raw candidates separately from approved values. Each candidate has source page/evidence, extraction method, confidence (nullable when unsupported), and verification status. Never invent calibrated confidence percentages from model self-assessment. Require human approval even when OCR confidence is high.

## Extraction and privacy boundary

Use a narrow document-extraction adapter returning structured candidates, never an autonomous chat tool with financial or operational access. Passport contents are untrusted data, not executable instructions. No fallback provider, analytics payload, public URL, Git commit or chat-memory storage may receive passports.

Server-side OCR is the private default. Any external vision provider requires a separate explicit approval naming the provider and passport data transmitted before activation. Existing Hermes text connectivity alone is not proof that reliable vision extraction is configured. A provider outage leaves the draft available for manual entry and never fabricates successful extraction.

Uploads, raw extraction, approved contract data and PDFs reside outside the public web root with restrictive file permissions. All downloads pass authenticated object-level access checks and return no-store headers. Staff can access their own drafts; administrators can access team drafts. Tenant/owner-portal accounts have no access. Recheck current user role from the user store, rather than trusting a potentially stale role embedded in a cookie. Do not include passport numbers, OCR text or file contents in logs.

State-changing endpoints require same-origin/CSRF protection. File identifiers are server-generated and never interpreted as arbitrary filesystem paths. PDF generation must prohibit external network fetches and browser JavaScript from contract data; map URLs are validated text hyperlinks, not fetched resources.

Retain drafts and generated versions until an authorized archival/retention action. No fixed-count truncation. Provide explicit removal of source uploads while retaining approved contract fields, with an audit event and clear disclosure that retained backups follow their own retention schedule. Do not claim deletion from every backup after only deleting the active file.

## Validation and status

Required before final output: tenant name, ID number, nationality, property name/address, valid check-in/out order, positive rent and coherent upfront payment terms. Highlight blank template fields and prohibit unresolved required extraction candidates. Do not require an arbitrary TVM property ID for external properties.

Warnings: passport already expired or expiring before lease end, date/duration override, optional missing tenant details, long text requiring extra pages, and reviewed template inconsistencies. No guessed dates or silent truncation.

Statuses: DRAFT, READY, GENERATED, SENT, SIGNED, ARCHIVED. READY is derived from validation; GENERATED requires a stored successful PDF snapshot. SENT/SIGNED are manually recorded with timestamp and actor in Phase 1, not automatic email or e-signature actions. No signing or sending service is in scope.

## Template review findings

Preserve clauses pending explicit approval. The PDF is not a fillable AcroForm. It embeds Hidden Padi, November 2026–October 2027 dates and rent/deposit amounts in multiple paragraphs; replace intended variables at all occurrences, not only table cells.

Article 4's English statement says services are excluded while the Indonesian introductory sentence says the following costs are included. Page 9 contains both 72-hour notice and one-day notice provisions. These are document-consistency findings, not a legal enforceability assessment. Record them visibly in template review. No automatic wording repair.

The baseline appendix is referenced but not present as a populated appendix. Append additional agreements after the existing base pages. Do not allow a normal employee to edit the locked base through this mechanism unnoticed: identify additions clearly in the final review and snapshot.

## Phased implementation and acceptance

1. Central schema and validation tests: calendar edges, money/deposit calculations, blank defaults, all property values editable, shared replacements, and HTML injection.
2. Private draft store and API tests: atomic writes, revision conflicts, restart persistence, access denial, no count cap, immutable version history and idempotent generation requests.
3. Template reconstruction and editor: compare all 13 base pages against the source; test inline/sidebar synchronization, keyboard controls, small screens, autosave failures and refresh recovery. Use synthetic tenant data only in tests.
4. Upload/extraction/review: test malformed content, bounds, uncertainty, approval, conflicting reuploads, provider failure and absence of unauthorized external traffic.
5. Deterministic PDF: correct headers/tables/bilingual text, selectable text, page counts, no browser URL headers, no clipping, long-name/address cases and multi-page appendices. Generation must fail visibly rather than save a broken PDF.
6. Release: inspect current remote/live revisions, preserve unrelated updates, take and verify private backups, validate Nginx configuration, deploy additive routes, run authenticated and signed-out live checks with synthetic records, and document rollback. Do not call Phase 1 complete while extraction or PDF generation is unconfigured.

## Out of scope for Phase 1

Visual template designer, additional contract types, KTP/booking/owner-ID classifiers, automatic legal rewriting, email sending, e-signature, finance entries, public passport sharing and unrelated website redesign. Keep template versions and extraction adapters separable so later support does not require replacing the data model.
