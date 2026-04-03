# SKILL: Booking Manager

## Triggers
Keywords: book, booking, reservation, check-in, check-out, guest, arrival, departure, extend stay, cancel booking, reschedule, availability, occupancy, airbnb, booking.com, tamu, pesan kamar, cek ketersediaan

## Workflow

### Step 1: Identify Booking Type
- **New booking** → check availability first, then create
- **Modify booking** → find existing event, update details
- **Cancel booking** → find event, confirm with user, delete
- **Check availability** → query calendar for date range
- **Check-in/Check-out status** → read calendar for today/tomorrow

### Step 2: Data Sources
- **Calendar**: All bookings are stored as Google Calendar events
  - Event title format: `Guest Name @ Villa Name`
  - Description contains: source (Airbnb/Booking.com/Direct), payment status, contact info
- **Staff Sheet (Income tab)**: Payment records
  - Sheet ID: `1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw`
  - Tab: `Income`
- **Internal Sheet**: Owner's financial tracking
  - Sheet ID: `1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ`

### Step 3: Execution Templates

#### New Booking
1. `calendar_check_availability` → startTime: check-in date, endTime: check-out date
2. If available → `calendar_create_event`:
   - summary: `{Guest Name} @ {Villa Name}`
   - startTime: check-in date (14:00 WITA default)
   - endTime: check-out date (11:00 WITA default)
   - description: `Source: {Airbnb/Booking.com/Direct}\nPayment: {status}\nContact: {phone/email}\nTotal: {amount}`
3. `finance_log_payment` → Log the income
4. Confirm to user with summary

#### Modify Booking (date change / extend)
1. `calendar_get_events` → Find the booking by guest name or date
2. `calendar_check_availability` → Verify new dates are free
3. `calendar_update_event` → Update with new dates
4. Confirm changes

#### Cancel Booking
1. `calendar_get_events` → Find the booking
2. Confirm with user (this is a DESTRUCTIVE action)
3. `calendar_delete_event` → Remove the event
4. Note cancellation reason in memory

#### Check Availability
1. `calendar_get_events` → Get all events in requested date range
2. List which villas are FREE vs OCCUPIED
3. Format response clearly

#### Today's Check-ins / Check-outs
1. `calendar_get_events` → timeMin: today 00:00, timeMax: today 23:59
2. Filter events starting today (check-ins) vs ending today (check-outs)
3. List with villa name, guest name, time

### Step 4: Response Format

#### WhatsApp (keep under 1,300 chars)
```
✅ Booking Confirmed
Guest: John Smith
Villa: Kala
Check-in: May 1, 2026 (2:00 PM)
Check-out: May 5, 2026 (11:00 AM)
4 nights | Rp 15,000,000
Source: Airbnb
```

#### Availability Response
```
Villa Availability: May 1-5, 2026

🟢 Villa ANN — Available
🟢 Villa DIANE — Available
🔴 Villa KALA — Occupied (Sarah Lee, May 1-3)
🟢 Villa LOUNA — Available
🔴 Villa NISSA — Occupied (Mark Chen, Apr 30 - May 7)
🟢 Villa LYMA — Available
```

### Villa Names Reference
- ANN, DIANE, KALA, LOUNA, NISSA, LYMA (Canggu area)
- ULUWATU properties (separate maintenance sheet)

### Rules
- Default check-in: 14:00 WITA, default check-out: 11:00 WITA
- Always check availability BEFORE creating a booking
- Log income to BOTH Staff Sheet and Internal Sheet
- For Airbnb/Booking.com bookings, parse the platform confirmation email if available
- Never double-book a villa — if dates overlap, inform user immediately
- Include booking source in calendar event description
- For group chats: mask guest contact details, show only name + dates + villa
