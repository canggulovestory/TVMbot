# SKILL: Guest Communications

## Triggers
Keywords: guest message, guest communication, check-in instructions, welcome, checkout reminder, review request, complaint, feedback, template, send to guest, guest info, tamu, pesan tamu, instruksi, sambutan

## Architecture (replicated from crewAI agent role pattern + AutoGPT CRM blocks)
This skill acts as a specialized "Guest Relations Agent" (crewAI pattern):
- Role: Professional guest communication specialist
- Goal: Handle all guest-facing messages with warmth and clarity
- Backstory: Expert in Bali villa hospitality with multilingual ability

## Communication Templates

### Pre-Arrival (Send 1 day before check-in)
```
Subject: Welcome to {Villa Name} — Check-in Details

Dear {Guest Name},

Welcome! We're excited to host you at {Villa Name}.

CHECK-IN DETAILS:
📍 Address: {Villa Address}
🕐 Check-in: {Date} at 2:00 PM
📞 Contact: +62 821-1511-1211 (WhatsApp)

WHAT TO EXPECT:
- Our staff will meet you at the villa
- Fresh towels, toiletries, and welcome amenities provided
- WiFi password will be on the welcome card
- Pool is cleaned daily

GETTING HERE:
- From airport: ~45 min to Canggu (we can arrange transport)
- Google Maps pin: [villa maps link]

If you need anything before arrival, just reply to this email or WhatsApp us.

Warm regards,
The Villa Managers Team
```

### Check-in Day (Send morning of check-in)
```
Good morning {Guest Name}! 🌴

Your villa {Villa Name} is ready for you.
Check-in time: 2:00 PM today.

Our team member {Staff Name} will be there to welcome you.
WiFi: {SSID} / Password: {Password}

Need early check-in or have questions? Just message us!

— TVMbot for The Villa Managers
```

### Mid-Stay Check (Send day 2 of stay)
```
Hi {Guest Name}! 👋

How's everything at {Villa Name}? Just checking in to make sure you're comfortable.

Need anything? Pool issue? AC not cold enough? Restaurant recommendations?

Just reply here — we're happy to help! 🙏

— The Villa Managers Team
```

### Pre-Checkout Reminder (Send day before checkout)
```
Hi {Guest Name},

Quick reminder — checkout is tomorrow at 11:00 AM.

CHECKOUT CHECKLIST:
✅ Leave keys on the kitchen counter
✅ Close all windows and doors
✅ Turn off AC units
✅ No need to strip beds (our team handles cleaning)

We hope you had an amazing stay at {Villa Name}! 🌺

If you enjoyed your stay, we'd love a review on {Airbnb/Google}.

Safe travels!
— The Villa Managers Team
```

### Post-Stay Review Request (Send 2 days after checkout)
```
Hi {Guest Name}! 🌟

Thank you for staying at {Villa Name}! We hope you had a wonderful time in Bali.

If you have a moment, we'd really appreciate a review:
⭐ {Review Link}

Your feedback helps us improve and helps other travelers find us.

We'd love to welcome you back anytime — returning guests get 10% off!

Warm regards,
The Villa Managers Team
```

### Complaint Response
```
Hi {Guest Name},

Thank you for letting us know about {Issue}. I sincerely apologize for the inconvenience.

{ACTION TAKEN}:
- {Step 1 taken to fix}
- {Step 2 if applicable}
- {Expected resolution time}

{If compensation offered}: As a gesture, we'd like to {compensation}.

Your comfort is our priority. Please don't hesitate to reach out if there's anything else.

Best regards,
{Owner Name}
The Villa Managers
```

### Payment Reminder
```
Hi {Guest Name},

This is a friendly reminder about your upcoming payment:

🏠 Villa: {Villa Name}
📅 Period: {Dates}
💰 Amount: {Amount}
📋 Status: {Pending/Overdue}

Payment methods:
- Bank Transfer (BCA): {Account Details}
- Wise: {Account Details}
- PayPal: {Email}

Please send confirmation once transferred.

Thank you!
— The Villa Managers
```

## Workflow

### Send Guest Communication
1. Identify communication type (pre-arrival, check-in, mid-stay, checkout, review, complaint, payment)
2. Pull guest details from calendar event or Sheets
3. Fill template with real data
4. Choose channel: email (gmail_send_message) or WhatsApp
5. Log communication to memory

### Handle Guest Inquiry
1. Identify what the guest is asking about
2. Check relevant data (calendar for dates, Sheets for pricing, maintenance for issues)
3. Compose response using appropriate tone
4. If complaint → escalate importance, notify owner

## Language Rules
- Match guest's language (English default)
- If guest writes in Indonesian → respond in Indonesian
- Keep WhatsApp messages under 1,300 chars
- Use emojis sparingly in professional emails
- Always sign as "The Villa Managers Team" or owner name

## Privacy Rules
- Never share guest details in group chats
- Mask phone numbers and emails in group WhatsApp
- Payment details only in private messages to owner
- Passport info never shared outside Drive
