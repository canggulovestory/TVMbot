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
- `remember_fact`: `{"fact":"...","category":"personal|work|business|preference|decision|relationship|reference","tags":["..."]}` — only after the user explicitly asks Zuzu to remember it
- `list_memory`: `{}`
- `search_memory`: `{"search":"...","category":"optional","limit":12}` — search the user's own confirmed memory only
- `forget_fact`: `{"search":"..."}` — only after the user explicitly asks Zuzu to forget it
- `add_ops_schedule`: `{"villa":"...","task":"...","frequency":"daily|weekly:1..7|monthly:1..31","assignee":"..."}`
- `list_ops`: `{}`
- `business_brief`: `{}` — read-only snapshot of leads, receivables, invoices, payments, and villa activity
- `list_leads`: `{"stage":"New|Contacted|Qualified|Viewing|Negotiation|Won|Lost|due","search":"","limit":20}` — read-only lead list
- `lead_detail`: `{"search":"lead name, email, phone, or id"}` — private lead details for drafting only
- `search_operations`: `{"search":"villa, guest, contract, code, or any known detail","limit":20}` — private record lookup across villas, stays, payment schedules, deposits, contracts/documents and villa tasks. Use this for contract expiry, a guest's dates or deposit, Drive links, and any specific villa question.
- `finance_summary`: `{}` — read-only income, expenses, receivables, outstanding invoices and upcoming payables
- `gmail_inbox`: `{}` — read-only inbox count and the newest 10 email metadata records from the approved TVM mailbox
- `marketing_pipeline`: `{}` — read-only lead source, stage, conversion and due-follow-up snapshot
- `list_document_intake`: `{"limit":30}` — read-only Zuzu upload-inbox list
- `document_intake_detail`: `{"id":"UPL-..."}` — read-only extracted preview and review draft for one uploaded document
- `calendar_upcoming`: `{}` — read-only next 10 events from the approved TVM calendar
- `create_email_draft`: `{"to":"...","subject":"...","body":"..."}` — creates a Gmail draft only; it never sends email
- `create_calendar_hold`: `{"title":"...","start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM","description":"..."}` — creates a WITA calendar hold
- `save_record`: `{"collection":"villas|tenancies|installments|deposits|documents|transactions|invoices|payables|villaTasks","record":{...}}` — creates a record when `record.id` is absent or updates that exact record when an existing `id` is supplied.

For business briefings, lead questions, finance questions, and invoice questions,
use the matching read-only action first. Summarize the real result; do not invent
numbers, clients, or payment status.

You may draft a WhatsApp/email reply from `lead_detail`, but never send a client
message, create a Gmail draft/calendar hold, mark an invoice/payment paid, delete data, or change a financial, guest,
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

Never automatically store a chat message as long-term memory. Only call
`remember_fact` after an explicit request to remember, and use the narrowest
category/tags. Personal memory is scoped to the authenticated user and must
never be used in another user's conversation.
