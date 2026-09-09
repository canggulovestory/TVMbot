# Protected task/villa connector — 2026-09-10 checkpoint

Status: connector, isolated host dispatch and rollout scripts implemented.
Online cutover must be verified using the read-only probes below.
Finance remains disabled. Financial entries still require the planned signed-in
financial website confirmation; this connector has no financial actions.

## Boundary

`operations-connector.js` exposes one HTTP handler, POST `/v1/operations`.
Independent random credentials bind each channel and actor on the broker. Neither
the model nor request JSON can set an actor, permissions, collection or filesystem
path. The broker accepts only list_tasks, list_villas, create_task and complete_task.
Villa reads project explicit operational fields; rates, payment accounts, guest
records, deposits, ledger records and unstructured financial notes are excluded.
There are no generic record, shell, delete, payment or confirmation endpoints.

`operations-channel-client.js` is trusted-host code, not a model-side tool. Its
Telegram binding accepts the message supplied by the authenticated bot transport,
checks an explicit numeric sender binding and private DM identity. Its web binding
calls the existing private-auth authenticator, never body.userId or a model claim.
Credentials are independent across users/channels and must never enter prompts,
browser bundles, general-purpose model workers, logs or Git.

Mutation delivery IDs come from the transport: Telegram chat/message IDs; a web
run's server-owned persisted delivery ID. Tool indices come from the host loop,
not the model. Replays return a stored receipt; different arguments under the same
ID fail. A fsynced pending journal precedes an external write. Uncertain writes,
including a missing upstream receipt, remain blocked across restarts. Investigate
the upstream task before reconciling a pending entry; do not delete the journal
or retry under a new ID. This is retry safety, not distributed exactly-once.

One broker process owns a private 0700 durable journal directory. Task operations
use the existing TVM task source; they must be named as TVM tools in the personal
chat. Personal ClickUp tasks must not silently move into TVM's Notion task list.
Listing uses bounded pagination and reports when the legacy 100-task source cap
may truncate data. Completion requires an exact ID present in that task source.

## Verified

- Red/green tests: missing connector/client, actual Telegram message shape,
  UTF-8 characters split across network chunks, missing task receipt.
- HTTP authorization, actor injection rejection, financial/generic-action denial,
  read-only binding write rejection, validation before writes, concurrent retry,
  restart replay, changed-payload rejection and uncertain-outcome blocking.
- Shared synthetic reads through both channel adapters; missing/group/bot/unknown
  Telegram identities denied. Model-supplied owner IDs do not authenticate web.
- `integration/check-operations-web-auth.cjs` uses the **installed personal auth
  module** with a disposable auth store: signed-in owner read succeeds, forged
  identity fails, logout revokes access, and revocation survives auth reload.
  It does not test or modify the owner's real session/data.
- TVM online checks run under non-root `zuzu-gateway`; personal-host auth checks
  use synthetic data only. Existing services were not restarted.

## Live wiring

The trusted loopback broker runs as a separate service. Its credentials and
Notion token are never available to the non-root model worker. The previous root
Hermes service is disabled at cutover; the deploy synchronizer must not revive it.
Telegram carries the original bot message into the host; Admin supplies its real
HTTP request and session authenticator. Personal web uses its existing private-auth
owner session. Staff bindings are read-only; task writes are owner-only.

Durable chat runs complement the per-operation journal. Identical same-day task
requests replay their successful answer without repeating a write, even when a
user resends the text as a new message. A failed run that may have written remains
blocked for review. Failed read-only requests can retry, and repeated reads always
fetch fresh records. This deliberately favors duplicate safety: to request another
identical task intentionally, say explicitly that it is an additional task.

Installed Notion SDK 2.3.0 was checked with a retryable HTTP failure and makes one
write attempt. A runnable regression test protects that assumption; no unsupported
retry configuration was added.

Read-only production probe: `node integration/check-live-operations.cjs`. The
personal repository's `scripts/check-isolated-web.cjs` exercises its real auth
module with a disposable session and the live tunnel/connector. Neither probe
creates business tasks, changes financial records or sends Telegram messages.

## Original prerequisites (now implemented in the rollout)

1. Replace/isolate the personal web chat's root-level Claude/general-tool runner.
   Its current filesystem/code execution can reach server credentials. Do not
   install connector keys there and call that protected.
2. Add a trusted host-side model tool dispatcher for both real chat handlers.
   Hermes must not receive connector credentials or be asked to supply identity.
   The existing Hermes-internal CLI tool path is not that dispatcher.
3. Mount the broker with independent protected runtime credentials, source
   adapters and private journal; disable upstream task SDK automatic retries.
   The existing Notion SDK default retry policy has not been changed here.
4. Provision bindings from the actual Telegram owner and authenticated `u_afni`
   web identity; verify rejects for other users on the actual routes. Provide TLS
   for remote transport or a private tunnel; never expose a plaintext remote URL.
5. Preserve other personal tools and TVM operations during migration. After
   synthetic end-to-end chat checks, take fresh stopped-service backups, switch
   routes and verify live reads. Do not create financial entries as smoke tests.

Both the handler and client default to disabled. Tests of the adapters are not
evidence that Telegram or the website currently uses them. The remaining work is
runtime/host integration, not a DNS or GitHub deployment toggle.
