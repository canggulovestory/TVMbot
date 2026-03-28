# SKILL: Email Operations

## Triggers
Keywords: email, gmail, inbox, mail, send email, unread, message from, reply, forward, draft, compose, kirim email, baca email, cek email

## Architecture (replicated from AutoGPT email_block.py)
Follows AutoGPT block pattern:
- Input validation → Execution → Status routing (sent/failed/draft)
- Supports: read, send, search, flag operations
- All operations through Gmail API via gmail.js integration

## Workflow

### Read Emails (READ)
Input: count (default 5), search query (optional)
1. `gmail_list_messages` with maxResults and query
2. For important emails, `gmail_read_message` to get full content
3. Summarize: sender, subject, date, preview
Output: Formatted email list

### Send Email (SEND — CONFIRM FIRST)
Input: to, subject, body
Validation:
- Valid email address format
- Subject not empty
- If sending to external (non-@thevillamanagers.com), confirm with user
1. Compose email content
2. Confirm with user for external recipients
3. `gmail_send_message` with to, subject, body
4. Return send confirmation
Output: Sent confirmation with recipient + subject
IMPORTANT: Always use info@thevillamanagers.com as sender

### Search Emails (SEARCH)
Input: search query, date range
1. `gmail_list_messages` with query (Gmail search syntax)
2. Format matching results
Output: Matching emails with highlights

### Check Flagged (PRIORITY)
1. `gmail_get_flagged` → starred/important emails
2. Sort by date, highlight unread
Output: Priority email list

## Email Search Patterns
- From specific sender: `from:email@example.com`
- Subject contains: `subject:booking confirmation`
- Date range: `after:2026/03/01 before:2026/03/31`
- Unread only: `is:unread`
- With attachment: `has:attachment`
- Airbnb emails: `from:airbnb.com`
- Booking.com: `from:booking.com`

## Auto-Detection (from email-watcher)
The email watcher automatically detects:
- Airbnb booking confirmations → auto-log to Sheets
- Bank payment notifications (BCA, Mandiri, BNI, Wise, PayPal) → auto-log
- These are logged to MONEY FLOW WhatsApp group automatically

## Response Templates

### Email List
```
📧 Recent Emails (5)

1. Airbnb <automated@airbnb.com>
   "Reservation Confirmed — Villa Kala"
   Mar 27, 2026 | ⭐ Important

2. John Smith <john@email.com>
   "Re: Check-in Details"
   Mar 26, 2026

3. BCA <notification@bca.co.id>
   "Transfer Notification Rp 15,000,000"
   Mar 26, 2026
```

### Email Sent
```
✅ Email Sent
From: info@thevillamanagers.com
To: john@email.com
Subject: Check-in Instructions — Villa Kala
Status: Delivered
```

## Rules
- ALWAYS send from info@thevillamanagers.com
- Confirm before sending to external addresses
- Never expose full email content in WhatsApp group chats
- Summarize long emails (keep under 500 chars for WhatsApp)
- Flag Airbnb/Booking.com emails as high priority
- If email contains booking details, offer to create calendar event
