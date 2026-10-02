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
