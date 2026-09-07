# Retention, financial calculations and web chat repairs

Status: implemented and verified locally on `fix/retention-finance-chat`. Not deployed.

## Scope completed

- Removed destructive pruning when the personal store reaches 1,000 items. No migration or deletion is required.
- Personal overview supports owner-scoped search, offset and limit. The UI displays 40 records per page, searches the entire saved collection, and restores the last successful page after a failed load.
- Shared currency calculations keep IDR and USD separate in Admin finance summaries, charts, villa statements, copy/print output, and the owner portal. Active-lease totals no longer combine currencies. Comparison against listing rates is only made for one matching currency.
- Amounts and commission use minor-unit rounding, including decimal half boundaries and negative adjustments. No exchange-rate conversion is assumed.
- Admin and Life web chat use asynchronous run polling with explicit Approve once, Deny and Cancel controls. Approval requests are bound to the original app and signed login session, expire, and can only be answered once.
- Abandoned browser runs and whole-run deadlines cancel the underlying work. Cancellation during an approval POST aborts that request and requests Hermes stop; buffered completion cannot override cancellation.
- TVM mobile header wraps without overlap. Life provides separate Chat and My records navigation on phones.

## Verification

- Full Node test suite: 72 tests passed, zero failures.
- Regression tests cover retention beyond 1,000, cross-user search isolation, pagination, mixed currencies, rounding, statement copy/print, route session binding, approval expiry/replay, abandoned runs and cancellation during approval.
- Independent read-only review found three issues (mixed lease total, decimal boundary rounding, cancellation race); each was reproduced by a failing test, fixed and re-reviewed successfully.
- Actual HTML and scripts were exercised in a localhost preview with synthetic records and synthetic model replies. No production data or model credentials were used.
- Personal browser checks: all 125 fixture records reachable across four pages; full-library search; approve, deny and cancel outcomes; mobile Chat/My records navigation.
- Admin browser checks: separate currency summaries and USD chart selection; owner statement; approve-once completion; mobile header and approval controls at 390px width.
- Owner portal browser check: IDR payout 600,000 and USD payout 90.07, independently calculated from the fixture.
- Copied and printable statement payloads are regression-tested against the same grouped calculation helper. The browser copy action reported success, but browser clipboard retrieval was unavailable; no claim of a separately inspected system clipboard is made.

## Release constraints and remaining work

- Do not equate localhost UI tests with a live provider or Telegram reliability test. Verify the deployed Hermes runs endpoint and real approval delivery during a separately approved release.
- The existing synchronous chat endpoints remain for compatibility; the updated web UIs use the new run endpoints.
- Runs and approval state are in-memory and short-lived, not permanent chat history. A restart expires them. Cancellation cannot undo an action already completed; the UI asks users to inspect records before repeating actions.
- Personal tool isolation, login throttling/session revocation, broader UI audit findings and CSV formula hardening remain outside this change.
- No production deployment, financial record rewrite, credential change or external message was performed.
- Before a later deployment: back up private data, deploy shared scripts and backend together, verify authenticated run routes, exercise one harmless live approval/cancel flow, and confirm existing data is unchanged.
