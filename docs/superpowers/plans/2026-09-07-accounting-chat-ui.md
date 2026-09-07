# Accounting, chat, and operational layout repair plan

> Execute inline, task by task, with failing regressions before each fix and verification before deployment.

**Goal:** Repair the accounting and chat failures in the approved 7 September audit, then prioritize operational information in Admin.

**Architecture:** Keep the existing Node server, atomic JSON store, and HTML interfaces. Move financial invariants into the shared store mutation boundary so both Admin and Zuzu follow them. Preserve existing records and record financial corrections rather than silently losing history.

**Tech stack:** Node standard library, existing node:test suite, browser UI verification. No new production dependencies.

**Spec:** User-approved recommendations in `../TVM-UI-FUNCTION-AUDIT-2026-09-07.md` (workspace root).

## Constraints

- Do not regenerate or modify live booking/payment data during development.
- Do not commit passwords, data files, or the pre-existing `.DS_Store`.
- Settled payment sources, transactions, and associated booking history must remain traceable.
- Keep expected deposits separate from collected/refundable money.
- No external provider fallback, automatic retry of mutations, or tool-approval bypass.
- Keep personal and business conversation histories separate.

## 1. Accounting integrity

Files: `villa-data.js`, `index.js`, `agent-tools.js`, `test/accounting-integrity.test.js`, `test/finance-cockpit.test.js`.

- [x] Add failing temporary-store regressions: three monthly payments of 100 remain a total of 300 after January is paid and the schedule is regenerated; paid-source correction from 100 to 150 leaves exactly one current ledger entry of 150 with previous values retained; an uncollected 42 deposit has zero refundable balance and cannot transition to Refunded; deleting a stay with settled records is rejected.
- [x] Run `node --test test/accounting-integrity.test.js`, confirm each failure is the audited behavior.
- [x] Make bundle creation a single queued store mutation. Match generated installments by stable period/number and reject ambiguous changes to a settled schedule rather than guessing how to allocate custom reservation/balance payments. Preserve installment IDs where possible. Prorate final quarterly installment by remaining whole billing months.
- [x] Centralize financial upsert and ledger synchronization inside the same mutation. Preserve previous financial values in a correction history, reject Paid-to-unpaid regressions, and block direct edits/deletes of auto-generated ledger entries. Route payment helpers through this boundary.
- [x] Derive eligible refundable balances consistently; validate collection/refund transitions and deductions, including partial refunds. Exclude uncollected deposits from refund queues. Block deletion of linked financial history.
- [x] Reconcile a missing deposit or agreement when an existing stay is edited, without overwriting an existing collected deposit. Add regressions for repeat edits and zero-day refund window.
- [x] Run full `npm test` and inspect the diff before moving to chat.

## 2. Chat behavior

Files: `personal/index.html`, `brain.js`, `test/brain-conversation.test.js`, browser regression harness if needed.

- [x] Add a failing test that two web messages pass the previous user/assistant turn, while personal and business histories do not cross. Use a fake model only at the external provider boundary; do not make network calls in tests.
- [x] Reproduce three personal messages in the browser: completion must update the matching reply, never the first reply; no completed request may keep a thinking state.
- [x] Use a reply element local to each submitted request; block duplicate submits, preserve submitted text on errors, and retain visible chat when list data refreshes. Add explicit form labels and save-error messages.
- [x] Reuse bounded plain-text conversation context for each web scope. Keep tool transcripts out of context. Make current personal list context available only to the personal assistant.
- [x] Verify normal replies, follow-up, failure, and duplicate-submit behavior. Do not claim Telegram end-to-end readiness from web tests.

## 3. Operational layout and consistency

Files: `admin/index.html`, `villa-data.js` reminder text, existing tests plus browser checks.

- [x] Use held/refundable definitions from the backend in Overview, Deposits, and villa detail. Only show eligible refund actions and require confirmation.
- [x] Place current/upcoming stay and payment/deposit summary first. Move the full gallery below operational/financial sections in a collapsible section. Keep utilities and schedules readable, not removed.
- [x] Label monthly equivalent versus total upfront rent, and current occupancy versus upcoming reservations. Avoid calling every document expiry a contract renewal.
- [ ] Check narrow and wide layouts and relevant controls in browser. Do not submit production financial test records.

## 4. Release gate

- [x] Full tests, syntax checks, and `git diff --check`.
- [x] Review accounting failure paths, idempotency, history preservation, and conversation separation.
- [ ] Before production update, back up private store and deployed revision on the VPS; do not copy credentials into Git.
- [ ] Release through the established GitHub deployment path only after tests pass. Verify deployed commit, service health, authenticated screens, and unchanged live monetary records.
- [ ] Report exact completed scope, test results, and any remaining unverified Telegram/approval work.

## Verification results — 7 September 2026

- Full suite: 53 tests passed, zero failures. Both inline HTML scripts parse; git diff --check passes.
- Read-only independent review findings resolved with regressions, including manual transactions plus new payment sources and paid-payable source navigation.
- Synthetic browser preview: three consecutive personal messages (third deliberately failed); correct reply association, no stuck thinking rows, and conversation retained after creating a synthetic list item.
- Desktop Admin preview: expected deposit visible in sidebar but zero held/refundable, no premature refund action, 280m upfront schedule total distinct from monthly equivalent, upcoming arrival shown, paid payable accessible via Edit source, gallery collapsed below operational sections.
- No production records were written and nothing was deployed. Private backups and post-deployment checks remain pending integration choice under finishing-a-development-branch.
- Narrow-screen visual QA has not been completed. Responsive CSS is included but is not represented as browser-verified.

## Remaining audit work (not claimed fixed in this batch)

- Approval-aware web chat and independently restricted personal tool profile; real Telegram delivery/approval end-to-end verification; model readiness dashboard.
- Document intake linkage/preview and explicit deadline types (generic reminder wording corrected only).
- Session revocation/rate limiting/separate credentials, personal list edit/search and truncation protection, consistent WITA dates.
- No credential vault, password storage, model-provider change, data migration, or transfer of money.
