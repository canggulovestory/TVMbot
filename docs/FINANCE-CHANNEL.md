# Financial chat connection

Telegram finance is loaded only from private `/etc/zuzu-finance/telegram.json` by the trusted host. Missing configuration leaves it off. The isolated Hermes runtime has no credential or native filesystem access.

The pinned package in `vendor/finance` comes from one inspected Financial artifact, shared with Zuzu Life. Its provenance includes the source revision and archive digest. Do not edit the extracted package by hand.

Configuration uses `enabled`, `prepareEnabled`, `channel: "telegram"`, `externalOwnerId` (verified numeric sender ID), `publicKey`, `email`, `password`, and `bridgeUserId`. The last three identify a dedicated Supabase Auth bridge, never the owner. Keep the file root-owned mode 0600. Never commit credentials. The bridge belongs only in `finance_assistant_bindings`, not `finance_members`.

Only read, prepare and receipt tools exist. Preparation returns a website preview, not a saved entry. Posting requires the owner session on the Financial website. Telegram adds a fixed-origin review button; its button does not confirm the proposal. Admin chat remains unchanged in this release.

Checks: `node --test` covers channel identity, group/other-user rejection in the shared package, missing configuration, absence of confirmation tools and review-button delivery. `node integration/check-finance-model.cjs` uses the actual isolated model with synthetic financial RPCs only. It does not send Telegram messages or modify financial records. Optional argument 1, 2 or 3 selects Indonesian, Dutch or typo-English.

2026-09-10 verification: 83 TVM tests passed. All three real-model synthetic transcripts resolved exact IDs, IDR amount and Bali date and returned an owner confirmation link. SSH was intermittent during the checks; the third case was independently rerun successfully. No live finance activation is claimed. The one-time Supabase setup key, fresh database backup, additive migrations and read-first activation remain required.
