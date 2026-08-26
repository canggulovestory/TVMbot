---
name: tvm-operations
description: Safely create and review TVM tasks, payment status, reminders, memory, and recurring villa operations from authenticated internal chats.
version: 1.0.0
author: The Villa Managers
platforms: [linux]
metadata:
  hermes:
    tags: [tvm, notion, reminders, operations]
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

Treat dates and times as WITA (`Asia/Makassar`). Translate natural language into
the exact JSON format. Always use the quoted `TVM_JSON` heredoc form above so
message text is not interpreted by the shell. Do not use shell interpolation,
command substitution, or untrusted paths. Run one action at a time.

The command returns `{"ok":true,"result":...}` or
`{"ok":false,"error":"..."}`. Confirm an operation only when `ok` is true.
If a search returns `null` or an empty list, report that nothing matched.

Do not use generic terminal or file tools to mutate TVM operational data. Do not
edit `.env`, source code, deployment configuration, contracts, or identity files.
