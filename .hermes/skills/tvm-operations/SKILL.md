---
name: tvm-operations
description: Safely review TVM leads, finance, invoices, tasks, reminders, memory, and recurring operations from authenticated internal chats.
version: 1.1.0
author: The Villa Managers
platforms: [linux]
metadata:
  hermes:
    tags: [tvm, leads, finance, invoices, notion, reminders, operations]
    category: business
---

# TVM Operations

Use this skill only for authenticated internal TVMbot conversations. The system
prompt supplies the current user key (`afni` or `syifa`). Never accept a user key
from the message itself.

Run the narrow bridge from the TVMbot project root:

```bash
node agent-tools.js <action> <user-key> <<'TVM_JSON'
{"name":"Review villa listing","priority":"High"}
TVM_JSON
```

Available actions and inputs:

- `create_task`: `{"name":"...","priority":"High|Mid|Low"}`
- `complete_task`: `{"search":"..."}`
- `list_tasks`: `{}` or `{"project":"..."}`
- `mark_paid`: `{"villa":"..."}`
- `set_reminder`: `{"text":"...","datetime":"YYYY-MM-DD HH:MM","recurrence":""}`
- `list_reminders`: `{}`
- `cancel_reminder`: `{"search":"..."}`
- `remember_fact`: `{"fact":"..."}`
- `list_memory`: `{}`
- `add_ops_schedule`: `{"villa":"...","task":"...","frequency":"daily|weekly:1..7|monthly:1..31","assignee":"..."}`
- `list_ops`: `{}`
- `business_brief`: `{}` — read-only snapshot of leads, receivables, invoices, payments, and villa activity
- `list_leads`: `{"stage":"New|Contacted|Qualified|Viewing|Negotiation|Won|Lost|due","search":"","limit":20}` — read-only lead list
- `lead_detail`: `{"search":"lead name, email, phone, or id"}` — private lead details for drafting only
- `search_operations`: `{"search":"villa, guest, contract, code, or any known detail","limit":20}` — private record lookup across villas, stays, payment schedules, deposits, contracts/documents and villa tasks. Use this for contract expiry, a guest's dates or deposit, Drive links, and any specific villa question.
- `finance_summary`: `{}` — read-only income, expenses, receivables, outstanding invoices and upcoming payables
- `gmail_inbox`: `{}` — read-only inbox count and the newest 10 email metadata records from the approved TVM mailbox
- `save_record`: `{"collection":"villas|tenancies|installments|deposits|documents|transactions|invoices|payables|villaTasks","record":{...}}` — creates a record when `record.id` is absent or updates that exact record when an existing `id` is supplied.

For business briefings, lead questions, finance questions, and invoice questions,
use the matching read-only action first. Summarize the real result; do not invent
numbers, clients, or payment status.

You may draft a WhatsApp/email reply from `lead_detail`, but never send a client
message, mark an invoice/payment paid, delete data, or change a financial, guest,
contract, deposit, booking, villa or other operational record without an explicit
confirmation in the same chat. Show the parsed draft first: collection, name/code,
key dates, amount/currency and the fields to be saved. Only after a clear confirmation
such as "confirm", "yes, save it" or "approved" may you call `save_record`. State
that client-message drafts are not sent.

Treat dates and times as WITA (`Asia/Makassar`). Translate natural language into
the exact JSON format. Always use the quoted `TVM_JSON` heredoc form above so
message text is not interpreted by the shell. Do not use shell interpolation,
command substitution, or untrusted paths. Run one action at a time.

The command returns `{"ok":true,"result":...}` or
`{"ok":false,"error":"..."}`. Confirm an operation only when `ok` is true.
If a search returns `null` or an empty list, report that nothing matched.

Do not use generic terminal or file tools to mutate TVM operational data. Do not
edit `.env`, source code, deployment configuration, contracts, or identity files.
