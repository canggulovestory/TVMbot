# SKILL: Calendar Operations

## Triggers
Keywords: calendar, event, schedule, appointment, meeting, availability, reschedule, cancel event, delete event, move event, create event, block dates, jadwal, hapus jadwal, pindah jadwal, umrah, holiday, day off, cuti

## Architecture (replicated from AutoGPT calendar.py block)
This skill follows the AutoGPT block pattern:
- Input validation → Execution → Status-based output routing
- Every operation yields either SUCCESS or ERROR with structured data
- All calendar operations go through Google Calendar API via calendar.js integration

## Workflow

### Check Events (READ)
Input: date range (optional), search query (optional)
1. `calendar_get_events` with timeMin/timeMax
2. Format results: title, date/time, description
3. Group by day if multiple days
Output: Formatted event list or "no events found"

### Create Event (CREATE)
Input: title, start, end, description (optional), attendees (optional)
Validation:
- start must be before end
- check for overlapping events first
1. `calendar_check_availability` → confirm no conflicts
2. `calendar_create_event` with all fields
3. Return event ID + confirmation
Output: Event created confirmation with details

### Update Event (UPDATE)
Input: event identifier (name or ID), fields to change
1. `calendar_get_events` → find matching event
2. If multiple matches → ask user to clarify
3. `calendar_update_event` with eventId + changed fields
Output: Updated confirmation with old → new values

### Delete Event (DELETE — DESTRUCTIVE)
Input: event identifier (name or ID)
1. `calendar_get_events` → find matching event
2. Confirm with user before deleting (DESTRUCTIVE action)
3. `calendar_delete_event` with eventId
Output: Deletion confirmation

### Check Availability (QUERY)
Input: date range, villa name (optional)
1. `calendar_get_events` for the range
2. Map events to villas
3. Return available/occupied status per villa
Output: Villa availability matrix

## Time Rules
- Default timezone: WITA (UTC+8, Bali)
- Default check-in time: 14:00
- Default check-out time: 11:00
- All-day events: use date without time
- When user says "tomorrow" → calculate from WITA timezone
- When user says "next week" → Monday to Sunday of next week

## Event Title Conventions
- Booking: `{Guest Name} @ {Villa Name}`
- Maintenance: `🔧 {Villa} - {Issue}`
- Cleaning: `🧹 {Villa} - Cleaning`
- Meeting: `📅 {Meeting Title}`
- Holiday/Block: `🚫 {Villa} - Blocked`
- Staff event: `👤 {Staff Name} - {Event}`

## Error Handling (AutoGPT pattern)
- Event not found → suggest similar events or date range search
- Double booking → show conflicting event details, ask how to proceed
- Past date → warn user, still create if they confirm
- Missing required field → ask for specific missing info
- API error → report clearly, suggest retry

## Response Templates

### Event Created
```
📅 Event Created
Title: John Smith @ Villa Kala
Date: May 1-5, 2026
Time: 2:00 PM → 11:00 AM
Status: Confirmed ✅
```

### Daily Schedule
```
📅 Today's Schedule — Mar 27, 2026

09:00 — 🧹 Villa ANN - Cleaning
14:00 — John Smith @ Villa KALA (check-in)
11:00 — Sarah Lee @ Villa NISSA (check-out)

3 events today
```

### Availability Check
```
📅 May 1-5, 2026 — Villa Availability

🟢 ANN — Free
🟢 DIANE — Free
🔴 KALA — John Smith (May 1-5)
🟢 LOUNA — Free
🔴 NISSA — Mike Chen (Apr 30 - May 7)
🟢 LYMA — Free

4 villas available
```
