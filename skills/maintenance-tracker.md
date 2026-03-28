# SKILL: Maintenance Tracker

## Triggers
Keywords: maintenance, repair, fix, broken, issue, problem, pool, ac, wifi, leak, damage, plumber, electrician, urgent, pending task, rusak, bocor, perbaikan, kerusakan, teknisi, tukang

## Data Source
- **Maintenance Spreadsheet**: `1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE`
- **Tabs**:
  - `MAINTENANCE ` — Current maintenance tasks (Canggu villas)
  - `2025 MAINTENANCE` — 2025 archive
  - `MAINTENANCE ULUWATU` — Uluwatu properties (different column layout, NO status column)
- **Column Layout (Canggu tabs)**: B=Description, C=Day, D=Month, E=PIC (person in charge), F=Villa, G=Location, H=Issue, I=Photos Before, J=Notes, K=Status, L=Photos After
- **Column Layout (Uluwatu)**: Same as above BUT K=Photos After, L=Cost (NO status column — status inferred from whether Photos After exists)

## Workflow

### Report New Issue
1. Gather info: which villa, what's the issue, location in villa, urgency
2. `maintenance_add_task`:
   - villa_name: ANN / DIANE / KALA / LOUNA / NISSA / LYMA / ULUWATU
   - issue: clear description
   - location: specific area (e.g., "master bedroom", "pool area", "kitchen")
   - priority: URGENT / HIGH / NORMAL / LOW
   - pic: assigned person (if known)
3. Confirm task logged with row number

### Check Pending Tasks
1. `maintenance_get_tasks` → filter by status (PENDING, URGENT, blank)
2. Group results by villa
3. Highlight URGENT items first
4. Format for easy reading

### Update Task Status
1. `maintenance_get_tasks` → find the specific task
2. `maintenance_update_task`:
   - row: the row number
   - status: DONE / IN PROGRESS / PENDING / URGENT / CANCELLED
   - notes: what was done, cost if applicable
3. Confirm update

### Get Summary / Report
1. `maintenance_get_summary` → overview of all pending items
2. Group by villa, then by priority
3. Include counts: total pending, urgent, in progress

## Priority Definitions
- **URGENT**: Safety hazard, guest-impacting, water/electrical emergency (pool pump failure, AC broken during guest stay, water leak, electrical issue)
- **HIGH**: Will become urgent if not addressed within 48 hours (slow drain, flickering lights, damaged furniture in occupied villa)
- **NORMAL**: Routine maintenance, not guest-impacting right now (paint touch-up, garden work, equipment servicing)
- **LOW**: Cosmetic or future improvement (wall crack non-structural, upgrade requests, general cleaning deep-clean)

## Common Issue Categories
- **Pool**: pump, filter, chemical balance, tiles, leak, green water
- **AC/HVAC**: not cooling, leaking water, remote broken, strange noise
- **Plumbing**: leak, clogged drain, water heater, toilet, faucet
- **Electrical**: power outage, socket not working, light fixture, breaker
- **Structural**: roof leak, wall crack, door/window, floor tiles
- **Garden/Exterior**: landscaping, fence, gate, parking, pathway
- **Appliances**: washing machine, fridge, oven, TV, WiFi router
- **Furniture**: bed frame, mattress, table, chair, sofa damage
- **Pest Control**: ants, mosquitoes, termites, rats

## Response Templates

### WhatsApp — New Issue Logged
```
🔧 Maintenance Logged
Villa: KALA
Issue: AC not cooling in master bedroom
Priority: URGENT
PIC: Komang
Status: PENDING

Will follow up for resolution.
```

### WhatsApp — Pending Summary
```
🔧 Maintenance Summary

URGENT (2):
• KALA — AC master bedroom (Komang)
• NISSA — Pool pump failure (Wayan)

PENDING (3):
• ANN — Garden fence repair
• DIANE — Bathroom drain slow
• LOUNA — Paint touch-up living room

Total: 5 open tasks
```

### WhatsApp — Task Updated
```
✅ Maintenance Updated
Villa: KALA
Issue: AC master bedroom
Status: DONE ✅
Notes: Replaced compressor, cost Rp 2,500,000
```

## Rules
- URGENT tasks: always notify immediately, don't batch
- When logging costs, also create a finance_log_expense entry for the villa
- For Uluwatu tab: remember there's NO status column — check Photos After to determine if done
- Always include villa name and specific location in the issue description
- If the reporter mentions a photo, note "photo provided" but don't try to process images
- Cross-reference with calendar: if a guest is arriving soon at the villa with an issue, flag it
- Staff in group chats can report issues — extract villa name, issue, and location from their message
- Indonesian messages: "rusak" = broken, "bocor" = leak, "mati" = dead/not working, "bunyi" = making noise
