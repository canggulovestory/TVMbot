# Telegram response verification

Run `npm test` for deterministic regressions. On the trusted host, run
`node integration/check-chat-quality.cjs` for the real model and Telegram response
handler with synthetic input. This probe sends no Telegram messages and performs
no record writes. It covers greetings, supplied payment figures, follow-up
arithmetic, unavailable financial access and failed task reads.

Record reads retry once on a temporary failure. Model requests retry once on a
network error, 429 or 5xx. Neither retries a host write. One malformed model reply
can be regenerated; after a completed write, the correction cannot call another
tool. Failed writes retain the existing durable uncertainty guard.

Failures log only an allowlisted error code and whether a write may have happened,
never the question, records, credentials or raw provider error.

The Financial Telegram connection remains inactive until the dedicated bridge is
provisioned as described in FINANCE-CHANNEL.md. Signing into the Financial website
does not activate this server connection. Calculation from user-provided figures
works independently; it must not be presented as a verified live financial record.

Additional checks: `node integration/check-everyday-quality.cjs` exercises task
and villa retrieval with synthetic records, corrections and multi-step amounts.
`node integration/check-reminder-quality.cjs` checks the real model asks for a
missing time, then uses exactly one synthetic reminder receipt. Neither probe
creates real reminders or sends Telegram messages.

Telegram now exposes personal reminder creation/listing through the existing
host reminder store, bound to the authenticated user. Missing/invalid/past times
are rejected before a write. Creation uses the existing durable write guard.
Voice/audio transcription remains unavailable; these messages now receive an
explicit request to type the question instead of being silently ignored.

Conversation deduplication includes the preceding distinct user request, so a
short reply such as “9 AM” is not reused for a different reminder. An immediate
repeat within the same context still replays the existing write receipt.
