# Bank mails → TVM financial (Zuzu)

Built by Binky for Afni, 21-11-2026. Read this before changing anything in `bank-gmail.js` or `bank-parsers.js`.

## What it does
1. `bank-gmail.js` connects Afni's **private Gmail** (harfiyanafni@gmail.com) **read-only** (`gmail.readonly` only).
   - Connect link (admin only): `/api/admin/integrations/bank-gmail/connect`. Token is encrypted in `data/bank-gmail.json`.
   - Every search is forced to the bank sender list (`BANK_SENDERS`). Zuzu never reads other private mail.
   - Each mail must pass DKIM for the bank's own domain, otherwise it is rejected (fake "bank" mails exist).
   - Mail bodies are only held in memory. Never store bodies, account numbers or full names.
2. `bank-parsers.js` turns one bank mail into `{bank, accountHint, direction, amount, currency, date, counterparty, reference, kind, confidence}`.
   - Unknown layout → `unknown_template`. Never guess an amount.

## Afni's booking rules (source of truth)
- Accounts in the financial app: **CIMB Niaga, BCA, Permata** only. Do **not** add new accounts.
- Money normally flows **CIMB → BCA → others**.
- **All spending is funded CIMB → BCA** (Afni 21-11). So BCA, BCA credit card, Jago, OVO, GoPay, ShopeePay and any other wallet → book on **CIMB Niaga**, with the route in the note, e.g. `CIMB Niaga (via BCA)`, `CIMB Niaga (via Jago)`. Permata stays Permata.
- Labels per counterparty/category: `data/bank-rules.json` (+ one-off `data/bank-overrides.json`), from Afni's answers.
- Moves between Afni's own accounts (e.g. Permata → Jago, BCA paying the BCA credit card) are **internal transfers**, never income or cost.
- Jago "Shared Pocket" mails duplicate the normal Jago mail → `secondary`, never counted.
- Nothing is booked without Afni's tap: parsed items go to a **To review** list first; on ✅ the app books them.

## Coverage (checked 21-11-2026, last 90 days)
- BCA: credit card + internet banking (outgoing), cash withdrawal. No mails for incoming money.
- Jago: transfers, debit card, e-wallet top-ups, payments, fees, reversals.
- Permata: outgoing BI-FAST, QR Pay, incoming transfers.
- CIMB: monthly statement only (not parsed yet).
- OVO / GoPay / ShopeePay: no mails.

## Still to build
- Staging table + "To review" page in the financial app (canggulovestory/financial), booking through the app's own `postTransaction()`.
- Daily run 03:00 WITA with a Gmail history cursor + 3-day lookback, hard dedupe on Gmail message id + bank reference.
- Telegram summary to Afni: counts + totals + review link only.

## Tests
`npm test` → `test/bank-parsers.test.js` (synthetic fixtures in `test/fixtures/bank/`, no real data) and `test/bank-gmail.test.js`.
