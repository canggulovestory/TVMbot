// server.js — TVMbot PEMS Orchestration Server
// Architecture: Memory → Planner → Executor → Supervisor → Memory Store → Response
// Built on Anthropic Tool Use (claude-sonnet-4-5-20250929)

require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const session  = require('express-session');

// ─── PEMS Modules ──────────────────────────────────────────────────────────────
const memory = require('./memory');
const { formatDatetimeInjection, serverNow } = require('./datetime-context');
const telegram = require('./telegram');
const voiceHandler = require('./voice-handler');
const { createPlan, revisePlan, classifyIntent } = require('./planner');
const { validatePlan, validateResult, deepValidate, formatApprovalRequest, RISK } = require('./supervisor');
const { executeTool, SENSITIVE_TOOLS } = require('./executor');
const TOOLS = require('./tools');
const audit = require('./audit');

// ─── Integration Imports ───────────────────────────────────────────────────────
let gmail, calendar;
try { gmail    = require('./integrations/gmail');    } catch(e) {}
try { calendar = require('./integrations/calendar'); } catch(e) {}

// WhatsApp Integration via Baileys (direct WA Web connection, no Meta API)
let whatsapp;
try { whatsapp = require('./whatsapp'); } catch(e) { console.warn('[WhatsApp] Module load failed:', e.message); }

// Maintenance Reminder System
let maintenance;
try { maintenance = require('./integrations/maintenance'); } catch(e) { console.warn('[Maintenance] Module load failed:', e.message); }

// Periodic Maintenance Schedule (calendar sync + due date reminders)
let periodicSchedule;
try { periodicSchedule = require('./integrations/periodic-schedule'); } catch(e) { console.warn('[PeriodicSchedule] Module load failed:', e.message); }

// Email Watcher — auto-logs Airbnb bookings & bank payments from Gmail
let emailWatcher;
try {
  const EmailWatcher = require('./integrations/email-watcher');
  emailWatcher = new EmailWatcher();
} catch(e) { console.warn('[EmailWatcher] Module load failed:', e.message); }

// Skill Loader — progressive domain skill injection
let skillLoader;
try {
  skillLoader = require('./skills/skill-loader');
  skillLoader.preloadSkills();
} catch(e) { console.warn('[SkillLoader] Module load failed:', e.message); }

// Memory Manager — unified memory with compaction, state tracking, execution logging
let memoryManager;
try {
  memoryManager = require('./memory-manager');
  console.log('[MemoryManager] Loaded: short-term + long-term + entity + compaction + execution log');
} catch(e) { console.warn('[MemoryManager] Module load failed:', e.message); }

// Proactive Monitor — autonomous problem detection + alerts
const { getTokenOptimizer } = require('./token-optimizer');

let proactiveMonitor;
try {
  const { ProactiveMonitor } = require('./proactive-monitor');
  proactiveMonitor = new ProactiveMonitor();
  console.log('[Monitor] Loaded: autonomous problem detection + alerts');
} catch(e) { console.warn('[Monitor] Module load failed:', e.message); }

// Knowledge Graph — entity linking + relationship tracking
let knowledgeGraph;
try {
  knowledgeGraph = require('./knowledge-graph');
  const stats = knowledgeGraph.getStats();
  console.log(`[KnowledgeGraph] Loaded: ${stats.totalEntities} entities, ${stats.totalRelations} relations`);
} catch(e) { console.warn('[KnowledgeGraph] Module load failed:', e.message); }

// Ruflo Intelligence Layer — Smart Router + Swarm + Learning + Defence + Memory
let ruflo;
try {
  ruflo = require('./ruflo-integration');
  const stats = ruflo.getStats();
  const modules = ['router', 'swarm', 'reasoning', 'defence', 'memory', 'policy', 'events', 'hooks', 'drift', 'gossip', 'gates', 'circuit', 'context', 'escalation', 'workflow', 'cache', 'feedback', 'templates', 'metrics'].filter(m => stats[m]);
  console.log(`[Ruflo] Loaded: ${modules.length}/22 modules (${modules.join(', ')})`);
} catch(e) { console.warn('[Ruflo] Module load failed:', e.message); }

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── File Upload (multer) ──────────────────────────────────────────────────────
const multer  = require('multer');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const XLSX     = require('xlsx');
const fs       = require('fs');

const upload = multer({
  dest: '/tmp/tvm_uploads/',
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel','text/csv','text/plain','image/jpeg','image/png','image/webp'];
    cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(pdf|docx|xlsx|xls|csv|txt|jpg|jpeg|png|webp)$/i));
  }
});
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── Input Sanitization (XSS Protection) ───────────────────────────────────────
function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}
function sanitizeObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') clean[k] = sanitizeInput(v);
    else if (typeof v === 'object' && v !== null) clean[k] = sanitizeObj(v);
    else clean[k] = v;
  }
  return clean;
}
// Middleware: sanitize body on all POST requests (except chat — Claude needs raw input)
app.use((req, res, next) => {
  if (req.method === 'POST' && req.body && req.path !== '/chat') {
    // Sanitize form fields but not chat messages (Claude needs original text)
    if (typeof req.body === 'object') {
      for (const [k, v] of Object.entries(req.body)) {
        if (typeof v === 'string' && k !== 'message' && k !== '_csrf') {
          req.body[k] = v.replace(/<script[^>]*>.*?<\/script>/gi, '').replace(/<[^>]+>/g, '');
        }
      }
    }
  }
  next();
});


// ─── Session & Auth ────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'tvmbot_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware — protects everything except /auth/* and /login.html
function requireAuth(req, res, next) {
  const open = ['/auth/login', '/auth/logout', '/login.html', '/webhook/gmail', '/status', '/whatsapp/status', '/telegram/status'];
  if (open.includes(req.path)) return next();
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api') || req.method === 'POST') {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  res.redirect('/login.html');
}
app.use(requireAuth);
// ─── CSRF Protection ───────────────────────────────────────────────────────────
const crypto = require('crypto');
function generateCsrfToken(session) {
  if (!session._csrf) session._csrf = crypto.randomBytes(32).toString('hex');
  return session._csrf;
}
function verifyCsrf(req, res, next) {
  // Skip for webhook, login (pre-auth), and GET requests
  if (req.method !== 'POST') return next();
  const skip = ['/auth/login', '/webhook/gmail', '/api/email-watcher/poll', '/api/email-watcher/start-watch'];
  if (skip.includes(req.path)) return next();
  if (!req.session || !req.session.loggedIn) return next(); // Auth middleware will catch
  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  if (!token || token !== req.session._csrf) {
    return res.status(403).json({ error: 'Invalid CSRF token. Please refresh the page.' });
  }
  next();
}

app.use(verifyCsrf);


// ─── Rate Limiting (Login) ─────────────────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, lastAttempt, blocked }
const RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.blocked && (now - entry.blockedAt) < RATE_LIMIT.blockMs) {
    const remaining = Math.ceil((RATE_LIMIT.blockMs - (now - entry.blockedAt)) / 60000);
    return { allowed: false, message: 'Too many attempts. Try again in ' + remaining + ' minutes.' };
  }
  if (entry.blocked && (now - entry.blockedAt) >= RATE_LIMIT.blockMs) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if ((now - entry.firstAttempt) > RATE_LIMIT.windowMs) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT.maxAttempts) {
    entry.blocked = true;
    entry.blockedAt = now;
    return { allowed: false, message: 'Too many attempts. Try again in 30 minutes.' };
  }
  return { allowed: true };
}

function recordLoginAttempt(ip, success) {
  if (success) { loginAttempts.delete(ip); return; }
  const entry = loginAttempts.get(ip) || { count: 0, firstAttempt: Date.now() };
  entry.count++;
  loginAttempts.set(ip, entry);
}

// Login route
app.post('/auth/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const rateCheck = checkLoginRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ success: false, message: rateCheck.message });
  }

  const { username, password } = req.body;
  const validUser = process.env.LOGIN_USER || 'admin';
  const validPass = process.env.LOGIN_PASSWORD || 'tvmbot2026';
  if (username === validUser && password === validPass) {
    recordLoginAttempt(ip, true);
    req.session.loggedIn = true;
    req.session.username = username;
    return res.json({ success: true });
  }
  recordLoginAttempt(ip, false);
  res.status(401).json({ success: false, message: 'Invalid username or password.' });
});

// Logout route
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});


// Serve CSRF token to authenticated clients
app.get('/api/csrf-token', (req, res) => {
  if (!req.session || !req.session.loggedIn) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ token: generateCsrfToken(req.session) });
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Session Store ────────────────────────────────────────────────────────────
const sessions = new Map();
const pendingApprovals = new Map(); // sessionId → { plan, resolve, reject, timestamp }

// Session limits to prevent memory leaks on long-running PM2 processes
const SESSION_MAX_COUNT = 100;
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours TTL
const SESSION_MAX_HISTORY = 20;

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    // Evict oldest session if at capacity
    if (sessions.size >= SESSION_MAX_COUNT) {
      let oldestKey = null, oldestTime = Infinity;
      for (const [k, v] of sessions) {
        if (v.createdAt < oldestTime) { oldestKey = k; oldestTime = v.createdAt; }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    sessions.set(sessionId, { history: [], userEmail: 'unknown', createdAt: Date.now() });
  }
  const s = sessions.get(sessionId);
  // Trim history if it exceeds max (keep recent messages)
  if (s.history.length > SESSION_MAX_HISTORY * 2) {
    s.history = s.history.slice(-SESSION_MAX_HISTORY * 2);
  }
  return s;
}

// Cleanup expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > SESSION_MAX_AGE_MS) sessions.delete(k);
  }
  for (const [k, v] of pendingApprovals) {
    if (v.timestamp && now - v.timestamp > 10 * 60 * 1000) {
      try { v.reject(new Error('Approval timed out')); } catch(e) {}
      pendingApprovals.delete(k);
    }
  }
}, 10 * 60 * 1000);

// ─── Build System Prompt ───────────────────────────────────────────────────────
function buildSystemPrompt(memoryCtx) {
  const ownerProfile = memory.getOwnerProfile();
  const ownerName = ownerProfile.name || ownerProfile.owner_name || 'the owner';
  const company = ownerProfile.company || 'The Villa Managers';

  return `You are TVMbot, the autonomous AI agent for ${company}, managed by ${ownerName}.

You are an expert villa management agent with full access to Gmail, Google Calendar, Drive, Docs, Sheets, and business intelligence tools. You execute tasks autonomously — reading emails, creating contracts, managing bookings, building reports, and coordinating operations.

PERSONALITY & BEHAVIOR (adapted from production AI system best practices):
- Professional, warm, and highly capable villa management expert
- You are a FULL-CAPABILITY assistant. You can help with ANY topic — not just villa management. If staff ask about weather, translations, cooking, travel advice, math, general knowledge, health tips, or anything else — help them fully and competently. You are not limited to business topics.
- Proactive: suggest improvements, flag upcoming tasks, notice patterns
- Concise in confirmations, thorough in reports. Keep WhatsApp messages UNDER 1,300 characters — longer messages may fail to deliver on WhatsApp.
- Execute tasks DIRECTLY when instructions are clear. Do NOT ask "would you like me to..." for standard operations. Only ask for confirmation before DESTRUCTIVE actions (deleting data, sending emails to external contacts, modifying financial records).
- Apply memory and context silently — never say "Based on my memory..." or "I remember that..." Just use the context naturally.
- Never expose internal tool names, error codes, API details, or spreadsheet IDs in user-facing WhatsApp messages. Keep technical details internal.
- When something fails, report clearly what happened and suggest a solution. Do NOT retry failed API calls more than once.
- Respond in the SAME LANGUAGE the user writes in. If they write Indonesian, reply in Indonesian. If English, reply in English. Mix if they mix.

BUSINESS CONTEXT:
${memoryCtx || '(no prior context loaded)'}

EXECUTION RULES:
1. Use tools to get REAL data — never guess or make up emails, names, dates
2. ALWAYS read before write: check target cells/data before modifying anything in Google Sheets. If a cell has a formula, SKIP it.
3. For SENSITIVE actions (send email to external contacts, delete events, modify financial records): state what you will do, then do it. For routine operations (reading data, checking status, logging entries) — just execute directly.
4. Chain tools when needed: first read, then write; first check availability, then book
5. After completing tasks, confirm briefly what was done. Keep confirmations SHORT on WhatsApp.
6. Save important discoveries to memory using save_note
7. If a task is unclear, ask ONE short clarifying question before proceeding
8. ALWAYS use info@thevillamanagers.com for everything — emails, calendar, payment reminders, contracts, maintenance, schedules. NEVER use any personal email address.
9. For scheduled/cron tasks: check what was already processed. Do NOT send duplicate notifications for the same item.
10. Check Google Sheets and internal data FIRST before using general knowledge. Local data is always more authoritative.
11. Mask sensitive data in group chats — never share guest phone numbers, emails, passport details, or exact payment amounts unless specifically asked by an admin in a private chat.
12. When checking status across multiple villas or tabs, read them ALL in parallel — don't wait for one to finish before starting the next.

CALENDAR MANAGEMENT:
- You have FULL calendar access: create, read, update, and DELETE events
- To delete an event: first use calendar_get_events to find it, get the event ID, then use calendar_delete_event
- To update an event: use calendar_update_event with the event ID and the fields to change
- When user says "delete", "remove", "cancel" an event — use calendar_delete_event
- When user says "move", "reschedule", "change time" — use calendar_update_event
- You CAN do this yourself. Never tell users to "go to Google Calendar" or "ask the developer" — you have the tools.

GENERAL ASSISTANT CAPABILITIES:
You are not just a villa management bot. You are a full AI assistant. You can:
- Answer ANY question on ANY topic (science, math, history, cooking, travel, health, technology, etc.)
- Translate between languages (Indonesian, English, and others)
- Help with writing (emails, messages, documents, social media posts)
- Do calculations, unit conversions, currency conversions
- Give travel advice, restaurant recommendations, local tips for Bali
- Help with personal tasks (reminders, to-do lists, planning)
- Explain complex topics in simple terms
- Help troubleshoot technical issues
- Give business advice and operational suggestions
When villa/business tools are not needed, respond directly from your knowledge. No tools required for general questions.

Today's date and time: Injected fresh per message (see [Current datetime:] prefix in user messages). ALWAYS use that datetime — it is the most accurate.
Timezone: WITA (Bali, Indonesia — UTC+8). All times and dates you work with are in Bali time.

GOOGLE DRIVE FILE MANAGEMENT:
You have FULL control over Google Drive. You can:
- Search, list, and browse folders (drive_search_files, drive_list_folder, drive_get_recent)
- Rename any file or folder (drive_rename_file)
- Move files between folders (drive_move_file)
- Copy files (drive_copy_file)
- Delete / trash files (drive_delete_file) — use trash by default, permanent only if asked
- Restore trashed files (drive_restore_file)
- Convert Google Docs/Sheets/Slides to PDF, DOCX, XLSX, PPTX, CSV, TXT (drive_convert_file)
- Merge multiple PDFs into one (drive_merge_pdfs)
- Read PDF and DOCX content (drive_read_contract)
- Get file details (drive_get_file_info)
When user says "organize my Drive", "rename files", "move to folder", "convert to PDF", "merge these", "delete old files" — use the appropriate drive tools.

CONTRACTS: Use https://villa-contract.vercel.app to generate rental contracts. Contract data auto-saves to TVMbot memory via /contract/save endpoint.

MASTER EXPENSES & OPERATIONS SPREADSHEET:
- Spreadsheet ID: 1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4
- Google Sheet Name: "The Villa Managers - Expenses, Suppliers and Payment"
- URL: https://docs.google.com/spreadsheets/d/1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4
- Use tools: sheets_read_data, sheets_write_data, sheets_append_row with this spreadsheet ID

TAB STRUCTURE:
1. EXPENSES — All expense records (from Google Form + manual entries)
   Columns: Timestamp | Date | PIC (Person In Charge) | Villa Name | Description | Qty | Unit Price (in IDR) | TOTAL | Payment Method | Invoice (link) | Notes
   → Use this tab when asked about expenses, spending, costs, or financial records
   → To add an expense: append a row with the columns above
   → Staff submit expenses via Google Form which auto-populates this tab
   
2. VILLAS_MASTER — Villa directory with full details (18 columns)
   Columns: VILLA_CODE | VILLA_NAME | ADDRESS | AREA | BANJAR | BEDROOMS | INTERNET_ACCOUNT | INTERNET_PLAN | INTERNET_COST | INTERNET_MANDIRI_VA | INTERNET_BCA_VA | ELECTRICITY_NUMBER | DAYA_VA | POOL_GUY | TRASH_COLLECTOR | LAUNDRY | STATUS | NOTES
   → Use this when asked about villa info, addresses, internet accounts, electricity, assigned suppliers, or any villa details
   → Internet accounts include GlobalXtreme account IDs, plans, costs, and payment VA numbers
   → Some villas share internet (Ann, Diane, Luna share afnih9G43A)

3. SUPPLIERS_MASTER — All supplier/vendor contacts and bank details
   Columns: SUPPLIER_ID | COMPANY_NAME | CONTACT_NAME | CATEGORY | SERVICE_TYPE | AREA | PHONE | EMAIL | BANK_NAME | BANK_ACCOUNT_NAME | BANK_ACCOUNT_NUMBER | PAYMENT_TYPE | DEFAULT_AMOUNT | NOTES | ACTIVE
   → Use when asked about suppliers, vendor contacts, bank details, service providers
   → Categories: electricity, internet, trash, banjar, cleaning, pool, etc.

4. RECURRING_SETUP — Recurring monthly bills config
   Columns: VILLA_CODE | CATEGORY | SUPPLIER_NAME | DUE_DAY | DEFAULT_AMOUNT | ACTIVE | NOTES
   
5. BILLS_DB — Monthly bills tracker
   Columns: BILL_ID | YEAR | MONTH_NUM | MONTH_NAME | VILLA_CODE | CATEGORY | SUPPLIER_NAME | DUE_DATE | AMOUNT | STATUS | PAID_DATE | PAYMENT_METHOD | PAID_BY_PIC | NOTES | CALENDAR_EVENT_ID
   → Use when asked about bills, payments due, what's been paid/unpaid

6. DASHBOARD_2026 — Summary dashboard data
7. LISTS — Dropdown values (categories, statuses, payment methods, areas)
8. CONTROL — Settings (year, month, calendar_id)

IMPORTANT RULES for Sheets:
- ALWAYS use spreadsheet ID '1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4' when reading/writing
- When searching expenses: read EXPENSES tab, filter by date/villa/PIC/description
- When asked "how much did we spend on X": read EXPENSES, sum the TOTAL column for matching rows
- When asked about a supplier: read SUPPLIERS_MASTER and filter
- When asked to add an expense: append to EXPENSES tab
- When asked about bills: read BILLS_DB, filter by status/villa/month
- Google Form link for staff expense submission: https://docs.google.com/forms/d/e/1FAIpQLSchP5OG1T4ZtTi54V0SRqs0A0BDD-Nqwz_098mzf6H1JkQe1A/viewform

COMPANY LEGAL DOCS: NPWP 1091031211183290 (THE VILLA MANAGERS), NIB 0702250138139 (PT THE VILLA MANAGERS). Files in Google Drive. Use drive_search_files to find them when asked.

MAINTENANCE TRACKING SPREADSHEET:
- Spreadsheet ID: 1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE
- Name: "Villa Maintenance Tracker"
- URL: https://docs.google.com/spreadsheets/d/1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE

MAINTENANCE TABS: MAINTENANCE (main), 2025 MAINTENANCE, MAINTENANCE ULUWATU (has COST col), PERIODICAL MAINTENANCE SCHEDULE, villa tabs (ANN, DIANE, LUNA, LOURINKA, ALYSAA, NISSA, LYSA, LIAN, INDUSTRIAL, LYMA, OCEAN DRIVE), CLEANING CHECKLIST.
COLUMNS: DESCRIPTION | DAY | MONTH | PIC | VILLA | LOCATION | ISSUE | PHOTOS BEFORE | NOTES | STATUS | PHOTOS AFTER. Status: PENDING/URGENT/DONE/IN PROGRESS.

MAINTENANCE TOOLS:
- maintenance_get_pending: Read all pending/urgent items across all tabs
- maintenance_update_status: Update status, notes, or after-photo URL for a specific item
- Use sheets_read_data/sheets_write_data with spreadsheet ID above for direct sheet access

MAINTENANCE WORKFLOW:
1. Daily 9 AM: Bot sends morning reminder to WhatsApp maintenance group with all PENDING/URGENT items
2. Daily 9:02 AM: Bot asks team to update items with blank status (5 at a time)
3. Daily 3 PM: Bot sends follow-up on old items asking for after-photos, solution, and who fixed it
4. When team reports a fix in the group chat, use maintenance_update_status to mark DONE with notes
5. When team sends after-photo, save to Drive and update PHOTOS AFTER column

WHATSAPP MAINTENANCE GROUP: Staff write in Indonesian/mixed. Parse slang (udh=sudah, blm=belum, gk=tidak, sm=sama, bs=bisa). Match villa names to sheet items. Update sheet immediately on status changes. Reply in same language. Ask if ambiguous ("Villa mana?").
CRITICAL RULES FOR MAINTENANCE GROUP:
- NEW issue reported → ALWAYS use sheets_append_row with spreadsheetId "1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE" and sheetName "Sheet1". Values format: ["", description, day, month, pic, villa, location, issue, "", notes, "PENDING", ""]
- Status update (fixed/done) → use maintenance_update_status with the correct tab and row number
- NEVER just acknowledge — ALWAYS write to the Google Sheet
- When staff say something is fixed: update status to DONE and add fix details to NOTES column

LANGUAGE: Reply in same language user writes (Indonesian/English). ALL sheet data, docs, calendar in ENGLISH only.

PERIODIC SCHEDULE: Villa tabs have recurring tasks. Cols: CATEGORY|ITEM|TASK|LAST TIME|DUE DATE|STATUS|COST|PIC. Categories: Bi-Weekly/Weekly/Monthly/Quarterly/Semi-Annual/Annual. Auto-syncs to calendar, sends reminders 2 days before, overdue alerts Mondays.

## PERSONAL FINANCE (DUAL-SHEET SYSTEM)

TWO Google Sheets work together:

### 1. STAFF SHEET (shared with team) — detailed operational data
Sheet ID: 1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw
Tabs & Columns (headers at row 7, data from row 8):
- Variable Expenses: B:DATE | C:PROPERTY | D:CATEGORY | E:DESCRIPTION | F:AMOUNT | G:NOTES
- Recurring Expenses: B:PROPERTY | C:CATEGORY | D:FREQUENCY | E:1ST PAYMENT DATE | F:END DATE | G:AMOUNT | H:NOTES
- Income: B:CANCELLED | C:CATEGORY | D:DATE | E:GUEST NAME | F:NUM GUESTS | G:PROPERTY | H:CHECK-IN | I:CHECK-OUT | J:NIGHTS | K:RENTAL INCOME | L:OTHER FEES | M:TOTAL | N:NOTES

### 2. INTERNAL SHEET (owner only) — personal budget planner
Sheet ID: 1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ
⚠️ This is a template with formulas — ONLY write to:
- Transactions (Variable): J:DESCRIPTION | R:AMOUNT | U:DATE | Y:SPENDER | AS:CATEGORY
- Transactions (Recurring): K:DESCRIPTION | R:FREQUENCY | W:AMOUNT | Z:DATE | AF:MEMBER
⛔ NEVER write to: Monthly tabs (Jan-Dec), Dashboards, Payment Tracker, Expense/Income Distribution, 50/30/20, Debt Calculator, Savings Tracker, Net Worth, Annual Report — ALL auto-calculated!

### AUTOMATION RULES:
1. INCOME → use finance_log_income → writes to BOTH sheets automatically
   - Staff Sheet: full booking details (property, guest, dates, amount)
   - Internal Sheet: summary line in Transactions (Variable) with CATEGORY="Income"
2. EXPENSES → use finance_log_variable or finance_log_recurring → Staff Sheet ONLY
   - Detailed line items stay in Staff Sheet for team visibility
3. EXPENSE SUMMARY → use finance_sync_expenses → syncs monthly villa totals to Internal Sheet
   - Reads all Staff Sheet expenses for a month, groups by villa
   - Writes summary lines to Internal Sheet Transactions (Variable) with CATEGORY="Expense"
4. MONTHLY OVERVIEW → use finance_monthly_overview → combined income/expense report

### RULES:
- Currency IDR. Write amounts as plain numbers.
- Date format: DD/MM/YYYY for Staff Sheet, YYYY-MM-DD for Internal Sheet
- PROPERTY = villa name (e.g. Villa Ann, Villa Diane)
- Always confirm before writing financial data
- If amount or date is missing, ask before logging
- Financial data is PRIVATE — never share with anyone
- Internal Sheet is STRICTLY OWNER ONLY`;
}



// ─── Input Sanitization (reduce tool result tokens) ────────────────────────────
function sanitizeToolResult(toolName, result) {
  try {
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    switch (toolName) {
      case 'gmail_list_messages':
        // Strip threadId, labelIds — Claude doesn't need them
        if (data.emails) {
          data.emails = data.emails.map(e => ({
            id: e.id,
            from: e.from,
            subject: e.subject,
            date: e.date,
            snippet: (e.snippet || '').slice(0, 150),
            isUnread: e.isUnread
          }));
        }
        break;

      case 'gmail_read_message':
        // Trim body to 3000 chars, strip labels/threadId
        if (data.body && data.body.length > 3000) data.body = data.body.slice(0, 3000) + '... [trimmed]';
        delete data.threadId;
        delete data.labels;
        break;

      case 'calendar_get_events':
        // Strip creator/organizer/attendees detail, keep only essential fields
        if (data.events) {
          data.events = data.events.map(e => ({
            id: e.id,
            summary: e.summary,
            start: e.start?.dateTime || e.start?.date || e.start,
            end: e.end?.dateTime || e.end?.date || e.end,
            location: e.location,
            description: (e.description || '').slice(0, 200),
            status: e.status
          }));
        }
        break;

      case 'sheets_read_data':
        // Limit rows returned (prevent massive sheet dumps)
        if (Array.isArray(data) && data.length > 50) {
          const trimmed = data.slice(0, 50);
          return JSON.stringify({ rows: trimmed, total: data.length, note: 'Showing first 50 rows of ' + data.length });
        }
        break;

      case 'drive_search_files':
      case 'drive_get_recent':
        // Strip permissions, owners, full metadata
        if (data.files) {
          data.files = data.files.map(f => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
            webViewLink: f.webViewLink
          }));
        }
        break;

      case 'finance_get_transactions':
        // Limit transaction list
        if (data.transactions && data.transactions.length > 30) {
          data.transactions = data.transactions.slice(0, 30);
          data.note = 'Showing 30 most recent transactions';
        }
        break;

      case 'maintenance_get_tasks':
        // Trim photo URLs and long descriptions
        if (data.tasks) {
          data.tasks = data.tasks.map(t => ({
            ...t,
            photos_before: t.photos_before ? '[has photo]' : null,
            photos_after: t.photos_after ? '[has photo]' : null,
            notes: (t.notes || '').slice(0, 200)
          }));
        }
        break;
    }
    
    return JSON.stringify(data);
  } catch (e) {
    // If sanitization fails, return original
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
}


// ─── Token Metering (track usage per request/day) ──────────────────────────────
const tokenMeter = {
  daily: {},  // { 'YYYY-MM-DD': { input: 0, output: 0, cached: 0, requests: 0 } }
  recent: [], // Last 50 requests with details
  
  log(requestData) {
    const today = new Date().toISOString().slice(0, 10);
    if (!this.daily[today]) {
      this.daily[today] = { input: 0, output: 0, cached: 0, requests: 0, tools_called: 0, cache_hits: 0 };
    }
    const d = this.daily[today];
    d.input += requestData.input_tokens || 0;
    d.output += requestData.output_tokens || 0;
    d.cached += requestData.cache_read_tokens || 0;
    d.requests++;
    d.tools_called += requestData.tools_called || 0;
    d.cache_hits += requestData.cache_hits || 0;
    
    this.recent.push({ ...requestData, timestamp: new Date().toISOString() });
    if (this.recent.length > 50) this.recent.shift();
    
    // Clean old daily entries (keep 30 days)
    const keys = Object.keys(this.daily).sort();
    while (keys.length > 30) {
      delete this.daily[keys.shift()];
    }
  },
  
  getStats() {
    const today = new Date().toISOString().slice(0, 10);
    return {
      today: this.daily[today] || { input: 0, output: 0, cached: 0, requests: 0 },
      daily: this.daily,
      recent: this.recent.slice(-20),
      estimated_cost_today: this._estimateCost(this.daily[today])
    };
  },
  
  _estimateCost(day) {
    if (!day) return '$0.00';
    // Sonnet pricing: $3/M input, $15/M output, cached input at $0.30/M
    const inputCost = (day.input / 1000000) * 3;
    const outputCost = (day.output / 1000000) * 15;
    const cachedCost = (day.cached / 1000000) * 0.30;
    return '$' + (inputCost + outputCost + cachedCost).toFixed(4);
  }
};



// ─── Response Cache (avoid duplicate API calls) ────────────────────────────────
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  console.log('[Cache] HIT for: ' + key.slice(0, 60));
  return entry.data;
}

function setCachedResponse(key, data) {
  // Limit cache size
  if (responseCache.size > 100) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { data, timestamp: Date.now() });
}

// Read-only tools that are safe to cache
const CACHEABLE_TOOLS = new Set([
  'gmail_list_messages', 'gmail_read_message', 'gmail_get_flagged',
  'calendar_get_events', 'calendar_check_availability',
  'drive_search_files', 'drive_find_passport', 'drive_get_recent',
  'docs_read_document', 'drive_read_contract', 'drive_scan_folder',
  'sheets_read_data',
  'get_owner_profile',
  'finance_get_report', 'finance_get_outstanding', 'finance_get_bank_balances',
  'finance_get_transactions',
  'maintenance_get_tasks', 'maintenance_get_summary',
  'notion_get_pages'
]);


// ─── Smart Tool Filter (reduce token usage per request) ────────────────────────
function filterToolsForQuery(userMessage) {
  // Strip WhatsApp context tags like [WhatsApp Group msg from +xxx]
  const cleanMsg = userMessage.replace(/\[WhatsApp.*?\]\s*/gi, '').toLowerCase();
  const msg = cleanMsg;
  
  // Tool groups with their keywords
  const toolGroups = {
    gmail: {
      keywords: ['email', 'gmail', 'inbox', 'mail', 'send email', 'unread', 'message from', 'airbnb email', 'booking email', 'kirim email'],
      tools: ['gmail_list_messages', 'gmail_read_message', 'gmail_send_message', 'gmail_get_flagged']
    },
    calendar: {
      keywords: ['calendar', 'event', 'schedule', 'appointment', 'meeting', 'availability', 'reschedule', 'cancel', 'delete', 'remove', 'move event', 'hapus', 'jadwal', 'umrah'],
      tools: ['calendar_get_events', 'calendar_check_availability', 'calendar_create_event', 'calendar_delete_event', 'calendar_update_event']
    },
    drive: {
      keywords: ['drive', 'file', 'folder', 'document', 'passport', 'upload', 'download', 'pdf', 'contract file', 'scan'],
      tools: ['drive_search_files', 'drive_find_passport', 'drive_get_recent', 'drive_create_folder', 'drive_read_contract', 'drive_scan_folder']
    },
    docs: {
      keywords: ['doc', 'document', 'google doc', 'create doc', 'write doc', 'contract', 'agreement'],
      tools: ['docs_create_document', 'docs_read_document', 'docs_update_document', 'docs_create_contract']
    },
    sheets: {
      keywords: ['sheet', 'spreadsheet', 'data', 'expense', 'income', 'payment', 'bill', 'supplier', 'villa info', 'tab', 'row', 'column', 'balance', 'bank', 'financial', 'report', 'revenue', 'cost', 'budget'],
      tools: ['sheets_read_data', 'sheets_write_data', 'sheets_append_row']
    },
    finance: {
      keywords: ['payment', 'invoice', 'expense', 'income', 'revenue', 'bank', 'balance', 'transaction', 'money', 'price', 'cost', 'fee', 'earning', 'bill', 'outstanding', 'paid', 'bayar', 'uang', 'biaya', 'tagihan'],
      tools: ['finance_log_payment', 'finance_log_expense', 'finance_get_report', 'finance_get_outstanding', 'finance_generate_invoice', 'finance_update_bank_balance', 'finance_get_bank_balances', 'finance_get_transactions', 'finance_mark_invoice_paid']
    },
    maintenance: {
      keywords: ['maintenance', 'repair', 'fix', 'broken', 'issue', 'problem', 'pool', 'ac', 'wifi', 'leak', 'damage', 'pending task', 'urgent', 'rusak', 'bocor', 'perbaikan'],
      tools: ['maintenance_add_task', 'maintenance_update_task', 'maintenance_get_tasks', 'maintenance_get_summary']
    },
    cleaning: {
      keywords: ['clean', 'cleaning', 'housekeeping', 'maid', 'turnover'],
      tools: ['cleaning_generate_schedule']
    },
    marketing: {
      keywords: ['marketing', 'post', 'instagram', 'content', 'caption', 'social media', 'promotion'],
      tools: ['marketing_generate_content']
    },
    memory: {
      keywords: ['remember', 'note', 'save', 'profile', 'owner'],
      tools: ['get_owner_profile', 'save_note']
    },
    notion: {
      keywords: ['notion', 'page', 'database'],
      tools: ['notion_get_pages', 'notion_create_page']
    }
  };

  // Always include these core tools (tiny overhead)
  const selectedTools = new Set(['get_owner_profile', 'save_note']);

  // Match tool groups based on keywords
  let matched = false;
  for (const [group, config] of Object.entries(toolGroups)) {
    if (config.keywords.some(kw => msg.includes(kw))) {
      config.tools.forEach(t => selectedTools.add(t));
      matched = true;
    }
  }

  // If no specific match, include sheets + finance + memory (most common)
  if (!matched) {
    toolGroups.sheets.tools.forEach(t => selectedTools.add(t));
    toolGroups.finance.tools.forEach(t => selectedTools.add(t));
    toolGroups.memory.tools.forEach(t => selectedTools.add(t));
  }

  // Filter the full TOOLS array
  const filtered = TOOLS.filter(t => selectedTools.has(t.name));
  
  console.log('[ToolFilter] Query matched ' + filtered.length + '/' + TOOLS.length + ' tools');
  return filtered;
}

// ─── Check if request needs the planner or can go direct ───────────────────────
function needsPlanner(userMessage) {
  const msg = userMessage.replace(/\[WhatsApp.*?\]\s*/gi, '').toLowerCase();
  
  // Simple queries that DON'T need planning:
  const simplePatterns = [
    /^(hi|hello|hey|good morning|good evening|selamat)/i,
    /^(thanks|thank you|ok|okay|great|got it)/i,
    /^(what is|who is|how do|explain|tell me about)/i,
    /^(help|what can you do)/i,
    /weather|temperature|time|date/i,
    /translate|terjemah/i,
    /calculate|convert|berapa/i
  ];
  
  if (simplePatterns.some(p => p.test(msg))) return false;
  
  // Complex queries that NEED planning (multi-step):
  const complexPatterns = [
    /and (then|also|after that)/i,
    /check .+ (then|and) .+ (then|and)/i,
    /create .+ send/i,
    /read .+ update/i,
    /compare|analyze|report on|summarize all/i
  ];
  
  if (complexPatterns.some(p => p.test(msg))) return true;
  
  // Default: skip planner for most single-intent queries
  return false;
}


// ─── Core PEMS Agent Loop ──────────────────────────────────────────────────────
async function runPEMSAgent(userMessage, sessionId, userEmail = 'unknown') {
  const session = getSession(sessionId);
  const startTime = Date.now();

  // ── P: Plan (skip for simple queries to save tokens) ─────────────────────────
  const memoryCtx = memory.buildContextSummary();
  let plan, validation;
  
  if (needsPlanner(userMessage)) {
    const convSummary = session.history.slice(-4).map(m =>
      `${m.role === 'user' ? 'User' : 'TVMbot'}: ${typeof m.content === 'string' ? m.content.slice(0, 100) : '[tool call]'}`
    ).join('\n');

    plan = await createPlan(userMessage, memoryCtx, convSummary);
    console.log(`[PEMS] Plan: ${plan.strategy} | ${plan.steps.length} steps`);

    // ── S: Supervisor pre-validation ───────────────────────────────────────────
    validation = validatePlan(plan, memoryCtx);
    console.log(`[PEMS] Validation: ${validation.approved ? 'APPROVED' : 'REJECTED'} [${validation.risk}]`);

    if (!validation.approved) {
      const revisedPlan = await revisePlan(plan, validation.issues.join('; '), userMessage);
      const revalidation = validatePlan(revisedPlan, memoryCtx);
      if (!revalidation.approved) {
        return {
          reply: `I can't safely complete this request. Issues found:\n${validation.issues.map(i => `• ${i}`).join('\n')}\n\nPlease provide more details or clarify your request.`,
          plan: revisedPlan,
          validation: revalidation,
          toolsUsed: [],
          elapsed: Date.now() - startTime
        };
      }
    }

    if (plan.clarification_needed && plan.missing_info?.length > 0) {
      return {
        reply: `Before I proceed, I need a bit more info:\n${plan.missing_info.map(i => `• ${i}`).join('\n')}`,
        plan,
        validation,
        toolsUsed: [],
        elapsed: Date.now() - startTime
      };
    }
  } else {
    console.log('[PEMS] Simple query — skipping planner to save tokens');
    plan = { strategy: 'direct', steps: [{ step: 1, action: 'respond' }] };
    validation = { approved: true, risk: 'LOW' };
  }

  // ── E: Execute (Claude Agentic Loop) ─────────────────────────────────────────
  // UPGRADE #5: Intent-based selective context — only load what's relevant
  let contextParts = [buildSystemPrompt(memoryCtx)];

  // Always include: skill context (lightweight) and ruflo additions
  if (skillLoader) contextParts.push(skillLoader.buildSkillContext(userMessage));
  if (rufloResult && rufloResult.systemPromptAddition) contextParts.push(rufloResult.systemPromptAddition);

  // Determine intent from ruflo routing or simple keyword check
  const detectedIntent = (rufloResult && rufloResult.metadata && rufloResult.metadata.intent) || '';
  const msgLower = userMessage.toLowerCase();

  // Memory context: only for complex queries (not greetings, status, simple lookups)
  const isSimple = /^(hi|hello|hey|ok|thanks|good morning|selamat|status|who are you)/i.test(msgLower);
  if (!isSimple && memoryManager) {
    contextParts.push(memoryManager.buildMemoryContext(sessionId, userMessage));
  }

  // Knowledge graph: only when entities are mentioned (villa names, guest names, contracts)
  const hasEntities = /villa|guest|booking|contract|passport|\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(userMessage);
  if (hasEntities && knowledgeGraph) {
    contextParts.push(knowledgeGraph.buildKnowledgeContext(userMessage));
  }

  const systemPrompt = contextParts.filter(Boolean).join('\n');
  // ── Context Budget: dynamically size history to fit token budget ─────────────
  // Budget: ~3.4K system + ~2K tools (filtered) + history + user message
  // Target: keep total under 15K tokens to leave room for response + safety margin
  const TOKEN_BUDGET_HISTORY = 4000; // ~4K tokens for history (rest goes to system+tools)
  let historySlice = session.history;
  
  // Estimate tokens: ~4 chars per token
  let historyTokens = JSON.stringify(historySlice).length / 4;
  while (historyTokens > TOKEN_BUDGET_HISTORY && historySlice.length > 2) {
    historySlice = historySlice.slice(2); // Drop oldest user+assistant pair
    historyTokens = JSON.stringify(historySlice).length / 4;
  }
  
  // Trim individual messages if they're still too long (e.g., huge tool results in history)
  historySlice = historySlice.map(m => {
    if (typeof m.content === 'string' && m.content.length > 2000) {
      return { ...m, content: m.content.slice(0, 2000) + '... [trimmed]' };
    }
    return m;
  });
  
  console.log('[Budget] History: ' + historySlice.length + ' msgs, ~' + Math.round(historyTokens) + ' tokens');

  const messages = [
    ...historySlice,
    { role: 'user', content: userMessage }
  ];

  // Smart tool filtering — only send relevant tools
  const filteredTools = filterToolsForQuery(userMessage);

  const toolsUsed = [];
  const toolResults = [];
  let finalReply = '';
  let iterations = 0;
  let cacheHits = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Rate limit retry with exponential backoff
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await claude.messages.create({
          model: (rufloResult && rufloResult.modelId) || 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: filteredTools.map((tool, i) => 
            i === filteredTools.length - 1 
              ? { ...tool, cache_control: { type: 'ephemeral' } }
              : tool
          ),
          messages: messages
        });
        break; // success
              // Log which model was used
              const rufloModel = (rufloResult && rufloResult.modelId) || 'claude-sonnet-4-5-20250929';
              if (rufloResult && rufloResult.modelName) {
                console.log(`[PEMS] Using model: ${rufloResult.modelName} (${rufloResult.metadata?.modelDecision?.reason || 'default'})`);
              }
      } catch (apiErr) {
        if (apiErr.status === 429 && attempt < 2) {
          const wait = (attempt + 1) * 30; // 30s, 60s
          console.log(`[PEMS] Rate limited, waiting ${wait}s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, wait * 1000));
        } else {
          throw apiErr;
        }
      }
    }

    // Log token usage from response
    if (response.usage) {
      tokenMeter.log({
        input_tokens: response.usage.input_tokens || 0,
        output_tokens: response.usage.output_tokens || 0,
        cache_read_tokens: response.usage.cache_read_input_tokens || 0,
        cache_creation_tokens: response.usage.cache_creation_input_tokens || 0,
        tools_sent: filteredTools.length,
        tools_called: 0,
        cache_hits: 0,
        query: userMessage.slice(0, 80),
        iteration: iterations
      });
    }
    console.log(`[PEMS] Claude iteration ${iterations}: stop_reason=${response.stop_reason}` + 
      (response.usage ? ` | in=${response.usage.input_tokens} out=${response.usage.output_tokens}` + 
        (response.usage.cache_read_input_tokens ? ` cached=${response.usage.cache_read_input_tokens}` : '') : ''));

    if (response.stop_reason === 'end_turn') {
      finalReply = response.content.find(b => b.type === 'text')?.text || '';
      break;
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const batchResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        console.log(`[PEMS] Tool call: ${block.name}`);
        toolsUsed.push(block.name);

        // Check response cache first (for read-only tools)
        let result;
        const cacheKey = block.name + ':' + JSON.stringify(block.input);
        const cached = CACHEABLE_TOOLS.has(block.name) ? getCachedResponse(cacheKey) : null;
        
        if (cached) {
          result = cached;
          cacheHits++;
        } else {
          result = await executeTool(block.name, block.input, userEmail);
          // Cache read-only tool results
          if (CACHEABLE_TOOLS.has(block.name)) {
            setCachedResponse(cacheKey, result);
          }
        }

        // Auto-learn from tool results
        if (block.name === 'get_owner_profile' && result.profile) {
          // Profile already in memory
        }
        if (block.name === 'docs_create_contract' && result.success) {
          memory.setFact('contracts', `contract_${Date.now()}`,
            `Contract for ${block.input.guestName} at ${block.input.villaName}`, userEmail);
        }

        batchResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: sanitizeToolResult(block.name, result)
        });
      }

      messages.push({ role: 'user', content: batchResults });
    } else {
      // Unexpected stop reason
      finalReply = response.content.find(b => b.type === 'text')?.text || 'Task completed.';
      break;
    }
  }

  if (iterations >= MAX_ITERATIONS && !finalReply) {
    finalReply = 'I completed as many steps as possible. Some parts of the request may need follow-up.';
  }

  // ── S: Supervisor post-validation ────────────────────────────────────────────
  const resultValidation = validateResult(toolsUsed, finalReply, userMessage);
  if (!resultValidation.passed) {
    console.warn('[PEMS] Result validation issues:', resultValidation.issues);
  }

  // ── M: Memory Store ───────────────────────────────────────────────────────────
  const elapsed = Date.now() - startTime;
  memory.logDecision({
    session_id: sessionId,
    user_message: userMessage.slice(0, 500),
    plan_used: plan.strategy,
    tools_called: toolsUsed.join(', '),
    outcome: finalReply.slice(0, 500),
    supervisor_notes: resultValidation.warnings.join('; ') || null
  });

  // Update session history (keep last 20 messages)
  session.history.push({ role: 'user', content: userMessage });
  session.history.push({ role: 'assistant', content: finalReply });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  return {
    reply: finalReply,
    plan,
    validation,
    toolsUsed,
    iterations,
    elapsed,
    cacheHits
  };
}

// ─── API Routes ────────────────────────────────────────────────────────────────

// ─── Chat Rate Limiting (prevents API cost abuse) ──────────────────────────────
// Each /chat call triggers 1-5 LLM calls. Limit to 20 msgs/min per session.
const chatRateMap = new Map(); // ip → { count, windowStart }
const CHAT_RATE_LIMIT = { maxPerMinute: 20, windowMs: 60 * 1000 };

function checkChatRateLimit(ip) {
  const now = Date.now();
  const entry = chatRateMap.get(ip);
  if (!entry || (now - entry.windowStart) > CHAT_RATE_LIMIT.windowMs) {
    chatRateMap.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > CHAT_RATE_LIMIT.maxPerMinute) {
    const remaining = Math.ceil((CHAT_RATE_LIMIT.windowMs - (now - entry.windowStart)) / 1000);
    return { allowed: false, message: `Rate limited. Please wait ${remaining}s before sending more messages.` };
  }
  return { allowed: true };
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - CHAT_RATE_LIMIT.windowMs * 2;
  for (const [ip, entry] of chatRateMap) {
    if (entry.windowStart < cutoff) chatRateMap.delete(ip);
  }
}, 5 * 60 * 1000);

// Main chat endpoint
app.post('/chat', async (req, res) => {
  // Rate limit check — protect Anthropic/OpenAI API costs
  const chatIp = req.ip || req.connection.remoteAddress;
  const rateCheck = checkChatRateLimit(chatIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.message });
  }

  const { message, sessionId, userEmail } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (typeof message !== 'string') return res.status(400).json({ error: 'Message must be a string' });
  if (message.trim().length === 0) return res.status(400).json({ error: 'Message cannot be empty' });
  if (message.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 characters)' });

  const sid = sessionId || `session_${Date.now()}`;
  const email = userEmail || req.ip || 'unknown';

  try {
    // Check for pending approval confirmation
    if (pendingApprovals.has(sid)) {
      const lower = message.toLowerCase().trim();
      const { resolve, reject, plan } = pendingApprovals.get(sid);
      pendingApprovals.delete(sid);

      if (['yes', 'confirm', 'ok', 'proceed', 'go ahead', 'do it', 'yes please'].some(w => lower.includes(w))) {
        resolve(true);
        return res.json({ reply: '✅ Confirmed! Proceeding now...', sessionId: sid, awaitingConfirmation: false });
      } else {
        reject(new Error('User cancelled'));
        return res.json({ reply: '❌ Cancelled. Let me know if you\'d like to try something else.', sessionId: sid, awaitingConfirmation: false });
      }
    }

    // Handle image vision (file upload with base64 image)
    const { imageBase64, imageMediaType, imageName } = req.body;
    if (imageBase64) {
      const villas = memory.getAllVillas().map(v => v.name).join(', ');
      const prompt = message || `Analyze this image. If it shows a document, receipt, invoice, utility bill, or any property-related content: identify what type it is, which villa it relates to (managed: ${villas}), any amounts, dates, names, or reference numbers. Then ask what the user wants to do with this information.`;
      const visionResult = await claude.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
      const visionReply = visionResult.content[0]?.text || 'Could not analyze image';
      return res.json({ reply: visionReply, sessionId: sid, meta: { toolsUsed: ['vision'], iterations: 1 } });
    }

    // Inject fresh datetime per message (RULE 01)
    const datetimePrefix = formatDatetimeInjection(email, memory.getDb());
    const enrichedMessage = `${datetimePrefix} [Web Chat from ${email}] ${message}`;
    const result = await runPEMSAgent(enrichedMessage, sid, email);

    res.json({
      reply: result.reply,
      sessionId: sid,
      meta: {
        plan: result.plan?.strategy,
        toolsUsed: result.toolsUsed,
        iterations: result.iterations,
        elapsed: result.elapsed,
        risk: result.validation?.risk
      }
    });
  } catch (err) {
    console.error('[Server] Chat error:', err);
    let userReply = 'Something went wrong. Please try again.';
    if (err.status === 429 || (err.message && err.message.includes('rate_limit'))) {
      userReply = 'I\'m processing too many requests right now. Please wait 30 seconds and try again.';
    } else if (err.message && err.message.includes('overloaded')) {
      userReply = 'The AI service is temporarily busy. Please try again in a minute.';
    } else if (err.message && err.message.includes('timeout')) {
      userReply = 'The request took too long. Try a simpler question or break it into smaller steps.';
    }
    res.status(err.status === 429 ? 429 : 500).json({ error: err.message, reply: userReply });
  }
});

// Owner interview / onboarding
app.post('/onboard', async (req, res) => {
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error: 'Profile data required' });

  try {
    memory.saveOwnerProfileBulk(profile);

    // Save key villas if provided
    if (profile.villas && Array.isArray(profile.villas)) {
      for (const villa of profile.villas) {
        memory.upsertVilla(villa);
      }
    }

    // Set facts from profile
    if (profile.name)     memory.setFact('owner', 'name', profile.name, 'onboarding');
    if (profile.company)  memory.setFact('owner', 'company', profile.company, 'onboarding');
    if (profile.email)    memory.setFact('owner', 'email', profile.email, 'onboarding');
    if (profile.phone)    memory.setFact('owner', 'phone', profile.phone, 'onboarding');
    if (profile.role)     memory.setFact('owner', 'role', profile.role, 'onboarding');
    if (profile.currency) memory.setFact('business', 'currency', profile.currency, 'onboarding');
    if (profile.checkin_time)  memory.setFact('business', 'checkin_time', profile.checkin_time, 'onboarding');
    if (profile.checkout_time) memory.setFact('business', 'checkout_time', profile.checkout_time, 'onboarding');
    if (profile.min_stay)      memory.setFact('business', 'min_stay_nights', profile.min_stay, 'onboarding');
    if (profile.languages)     memory.setFact('business', 'languages', profile.languages, 'onboarding');
    if (profile.other_businesses) memory.setFact('business', 'other_businesses', profile.other_businesses, 'onboarding');
    if (profile.house_rules)   memory.setFact('business', 'house_rules', profile.house_rules, 'onboarding');
    if (profile.notes)         memory.setFact('business', 'notes', profile.notes, 'onboarding');
    if (profile.sheets_booking_id)     memory.setFact('integrations', 'sheets_booking_id', profile.sheets_booking_id, 'onboarding');
    if (profile.drive_guests_folder)   memory.setFact('integrations', 'drive_guests_folder', profile.drive_guests_folder, 'onboarding');
    if (profile.sheets_maintenance_id) memory.setFact('integrations', 'sheets_maintenance_id', profile.sheets_maintenance_id, 'onboarding');
    if (profile.sheets_expenses_id)    memory.setFact('integrations', 'sheets_expenses_id', profile.sheets_expenses_id, 'onboarding');

    // Save bank accounts if provided
    if (profile.bank_accounts && Array.isArray(profile.bank_accounts)) {
      for (const account of profile.bank_accounts) {
        if (account.name) memory.upsertBankAccount(account);
      }
    }

    res.json({ success: true, message: 'Profile saved to memory', villas: profile.villas?.length || 0, banks: profile.bank_accounts?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Memory API
app.get('/memory/villas', (req, res) => {
  try {
    const villas = memory.getAllVillas();
    res.json({ villas });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/memory/profile', (req, res) => {
  res.json({ profile: memory.getOwnerProfile(), villas: memory.getAllVillas() });
});

app.get('/memory/bookings', (req, res) => {
  const bookings = memory.getBookings();
  const upcoming = memory.getUpcomingBookings(30);
  res.json({ bookings, upcoming });
});

app.get('/memory/notes', (req, res) => {
  res.json({ notes: memory.getAllNotes() });
});

app.get('/memory/decisions', (req, res) => {
  res.json({ decisions: memory.getRecentDecisions(20) });
});


// ─── Long-Term Rental Endpoints ───────────────────────────────────────────────
// Save / update a rental
app.post('/rental/save', (req, res) => {
  try {
    const data = req.body;
    if (!data.villa_name || !data.tenant_name || !data.check_in || !data.check_out) {
      return res.status(400).json({ error: 'villa_name, tenant_name, check_in, check_out required' });
    }

    // Compute total_amount if not provided
    if (!data.total_amount && data.monthly_amount && data.check_in && data.check_out) {
      const months = Math.round((new Date(data.check_out) - new Date(data.check_in)) / (1000*60*60*24*30));
      data.total_amount = parseFloat(data.monthly_amount) * months;
    }

    // Compute next_payment: find next occurrence of payment_day from today
    if (!data.next_payment && data.payment_day) {
      const today = new Date();
      const pd = parseInt(data.payment_day);
      let next = new Date(today.getFullYear(), today.getMonth(), pd);
      if (next <= today) next = new Date(today.getFullYear(), today.getMonth() + 1, pd);
      data.next_payment = next.toISOString().slice(0, 10);
    }

    const id = memory.saveLongTermRental(data);

    // Generate Google Calendar add-event links for each payment
    const calLinks = [];
    if (data.monthly_amount && data.check_in && data.check_out && data.payment_day) {
      const start = new Date(data.check_in);
      const end   = new Date(data.check_out);
      const pd    = parseInt(data.payment_day);
      let current = new Date(start.getFullYear(), start.getMonth(), pd);
      if (current < start) current = new Date(start.getFullYear(), start.getMonth() + 1, pd);

      while (current <= end && calLinks.length < 36) {
        const dateStr = current.toISOString().slice(0,10).replace(/-/g,'');
        const title   = encodeURIComponent(`💰 Rent Due: ${data.villa_name} – ${data.tenant_name}`);
        const details = encodeURIComponent(
          `Monthly rent: IDR ${Number(data.monthly_amount).toLocaleString()}\n` +
          `Villa: ${data.villa_name}\nTenant: ${data.tenant_name}\n` +
          `Contract: ${data.check_in} – ${data.check_out}`
        );
        calLinks.push({
          date: current.toISOString().slice(0,10),
          link: `https://calendar.google.com/calendar/r/eventedit?text=${title}&dates=${dateStr}/${dateStr}&details=${details}&sf=true`
        });
        current = new Date(current.getFullYear(), current.getMonth() + 1, pd);
      }
    }

    // Also save as business fact for TVMbot context
    memory.setFact('rentals', `rental_${data.villa_name.toLowerCase().replace(/ /g,'_')}`,
      `${data.tenant_name} | ${data.rental_type || 'monthly'} | ${data.check_in} – ${data.check_out} | IDR ${data.monthly_amount}/mo`, 'rental');

    res.json({ success: true, id, calLinks, next_payment: data.next_payment });
  } catch(err) {
    console.error('[Rental] Save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all active rentals (for payments panel) — MUST be before /rental/:villa
app.get('/rental/all/active', (req, res) => {
  try {
    const rentals   = memory.getAllLongTermRentals();
    const upcoming  = memory.getUpcomingRentalPayments(30);
    res.json({ rentals, upcoming });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Get rental for a specific villa
app.get('/rental/:villa', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.villa);
    const rental = memory.getLongTermRental(name);
    res.json({ rental: rental || null });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// End a rental
app.post('/rental/end/:id', (req, res) => {
  try {
    memory.endRental(parseInt(req.params.id));
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Advance next_payment by one period
app.post('/rental/paid/:id', (req, res) => {
  try {
    const rental = memory.db.prepare('SELECT * FROM long_term_rentals WHERE id=?').get(parseInt(req.params.id));
    if (!rental) return res.status(404).json({ error: 'Not found' });
    const cur = new Date(rental.next_payment);
    const next = new Date(cur.getFullYear(), cur.getMonth() + 1, rental.payment_day);
    const nextStr = next.toISOString().slice(0,10);
    memory.updateRentalNextPayment(rental.id, nextStr);
    // Log transaction
    memory.logTransaction({
      type: 'income', category: 'rent', villa_name: rental.villa_name,
      guest_name: rental.tenant_name, amount: rental.monthly_amount,
      currency: 'IDR', description: `Monthly rent – ${rental.tenant_name} @ ${rental.villa_name}`,
      status: 'paid', date: rental.next_payment
    });
    res.json({ success: true, next_payment: nextStr });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});



// ─── File Upload & Analysis ────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.session?.loggedIn) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const { originalname, mimetype, path: tmpPath, size } = req.file;
  let extractedText = '';
  let fileType = 'document';

  try {
    if (mimetype === 'application/pdf' || originalname.match(/\.pdf$/i)) {
      fileType = 'pdf';
      const data = await pdfParse(fs.readFileSync(tmpPath));
      extractedText = data.text?.slice(0, 8000) || '';
    } else if (mimetype.includes('wordprocessingml') || originalname.match(/\.docx$/i)) {
      fileType = 'word';
      const result = await mammoth.extractRawText({ path: tmpPath });
      extractedText = result.value?.slice(0, 8000) || '';
    } else if (mimetype.includes('spreadsheetml') || originalname.match(/\.(xlsx|xls)$/i)) {
      fileType = 'excel';
      const wb = XLSX.readFile(tmpPath);
      const rows = [];
      wb.SheetNames.slice(0,3).forEach(name => {
        const sheet = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        rows.push(`Sheet: ${name}\n${sheet.slice(0,3000)}`);
      });
      extractedText = rows.join('\n---\n');
    } else if (originalname.match(/\.csv$/i)) {
      fileType = 'csv';
      extractedText = fs.readFileSync(tmpPath, 'utf8').slice(0, 8000);
    } else if (originalname.match(/\.txt$/i)) {
      fileType = 'text';
      extractedText = fs.readFileSync(tmpPath, 'utf8').slice(0, 8000);
    } else if (mimetype.startsWith('image/')) {
      fileType = 'image';
      // Convert image to base64 for Claude vision
      const imgBuffer = fs.readFileSync(tmpPath);
      const base64 = imgBuffer.toString('base64');
      const ext = originalname.split('.').pop().toLowerCase();
      const mediaMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
      res.json({ 
        success: true, fileType, filename: originalname, size,
        isImage: true, base64, mediaType: mediaMap[ext] || 'image/jpeg'
      });
      fs.unlink(tmpPath, () => {});
      return;
    }
  } catch (e) {
    extractedText = `[Could not extract text: ${e.message}]`;
  }

  // Cleanup temp file
  fs.unlink(tmpPath, () => {});

  res.json({ success: true, fileType, filename: originalname, size, text: extractedText });
});

// Save WiFi details for a villa
app.post('/villa/wifi', (req, res) => {
  try {
    const { villa_name, wifi_name, wifi_password, wifi_payment_id, wifi_mbps } = req.body;
    if (!villa_name) return res.status(400).json({ error: 'villa_name required' });
    const key = villa_name.replace('Villa ','').toLowerCase().replace(/ /g,'_');
    if (wifi_name)       memory.setFact('wifi', `wifi_name_${key}`, wifi_name, 'villa');
    if (wifi_password)   memory.setFact('wifi', `wifi_pass_${key}`, wifi_password, 'villa');
    if (wifi_payment_id) memory.setFact('wifi', `wifi_payment_id_${key}`, wifi_payment_id, 'villa');
    if (wifi_mbps)       memory.setFact('wifi', `wifi_mbps_${key}`, wifi_mbps, 'villa');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─── Villa Contract App Integration ────────────────────────────────────────────
// Receives contract data from villa-contract.vercel.app and saves to memory
app.post('/contract/save', (req, res) => {
  try {
    const d = req.body;
    if (!d.villaName || !d.checkInDate || !d.checkOutDate) {
      return res.status(400).json({ error: 'villaName, checkInDate, checkOutDate required' });
    }

    // Save as a booking for each guest
    const bookingIds = [];
    const guests = d.guests || [{ name: d.guestName || 'Unknown' }];
    for (const g of guests) {
      if (!g.name) continue;
      // Upsert guest
      if (g.passportNumber || g.phone) {
        try {
          memory.upsertGuest({
            name: g.name, email: null, phone: g.phone || null,
            nationality: g.nationality || null,
            passport_file_id: g.passportNumber ? 'passport:' + g.passportNumber : null,
            notes: g.birthday ? 'DOB: ' + g.birthday : null
          });
        } catch(e) { /* guest upsert is best-effort */ }
      }
    }

    // Save main booking (primary guest)
    const primaryGuest = guests[0] || {};
    const bookingId = memory.saveBooking({
      guest_name: primaryGuest.name || 'Unknown',
      guest_email: null,
      villa_name: d.villaName,
      check_in: d.checkInDate,
      check_out: d.checkOutDate,
      price: d.totalPrice || null,
      status: 'confirmed',
      contract_doc_id: null,
      calendar_event_id: null,
      notes: [
        guests.length > 1 ? `All guests: ${guests.map(g=>g.name).join(', ')}` : '',
        d.inclusions ? `Inclusions: ${Object.entries(d.inclusions).filter(([,v])=>v).map(([k])=>k).join(', ')}` : '',
        d.otherInclusions ? `Other: ${d.otherInclusions}` : ''
      ].filter(Boolean).join(' | ')
    });
    bookingIds.push(bookingId);

    // Save financial transaction
    if (d.totalPrice) {
      memory.logTransaction({
        type: 'income', category: 'booking',
        description: `Contract: ${primaryGuest.name} @ ${d.villaName} (${d.checkInDate}→${d.checkOutDate})`,
        amount: d.totalPrice, currency: 'IDR',
        villa_name: d.villaName, guest_name: primaryGuest.name,
        booking_id: bookingId, status: 'pending',
        date: d.checkInDate
      });
    }

    // Save inclusions as villa facts
    if (d.inclusions) {
      const key = d.villaName.replace('Villa ','').toLowerCase().replace(/ /g,'_');
      const activeInclusions = Object.entries(d.inclusions).filter(([,v])=>v).map(([k])=>k).join(',');
      if (activeInclusions) memory.setFact('villa', `inclusions_${key}`, activeInclusions, 'contract');
    }

    // Store contract context as business fact for TVMbot
    memory.setFact('contracts', `contract_${d.villaName.toLowerCase().replace(/ /g,'_')}_${Date.now()}`,
      `${primaryGuest.name} @ ${d.villaName}: ${d.checkInDate}–${d.checkOutDate} | IDR ${d.totalPrice || d.monthlyPrice}/mo | ${guests.length} guest(s)`,
      'villa-contract-app');

    res.json({ success: true, bookingIds, message: `Contract saved — booking #${bookingId} created for ${d.villaName}` });
  } catch(err) {
    console.error('[Contract] Save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get contract app info
app.get('/contract/info', (req, res) => {
  res.json({
    url: 'https://villa-contract.vercel.app',
    description: 'Villa Contract Generator — creates PDF/DOC rental contracts with guest details, pricing, and inclusions. Saves to Google Drive.',
    fields: ['villaName','villaAddress','bedrooms','guests(name,birthday,nationality,phone,passport)','checkInDate','checkOutDate','monthlyPrice','totalPrice','paymentDueDate','inclusions(cleaning,pool,internet,banjarFee,rubbish,laundry,electricity)','otherInclusions']
  });
});

// Villa detail endpoint — everything about one villa
app.get('/memory/villa/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const villa = memory.getVilla(name);
  if (!villa) return res.status(404).json({ error: 'Villa not found' });

  const bookings      = memory.getBookings({ villa: name });
  const upcoming      = memory.getUpcomingBookings(60).filter(b => b.villa_name === name);
  const maintenance   = memory.getMaintenanceTasks({ villa_name: name });
  const transactions  = memory.getTransactions({ villa: name });

  // Pull lock code + electricity + wifi from business_facts
  const key = name.replace('Villa ','').toLowerCase().replace(/ /g,'_');
  const lockCode     = memory.getFact(`lock_${key}`);
  const elecMeter    = memory.getFact(`meter_${key}`);
  const elecKwh      = memory.getFact(`kwh_${key}`);
  const wifiName     = memory.getFact(`wifi_name_${key}`);
  const wifiPassword = memory.getFact(`wifi_pass_${key}`);
  const wifiPaymentId= memory.getFact(`wifi_payment_id_${key}`);
  const wifiMbps     = memory.getFact(`wifi_mbps_${key}`);

  // Active long-term rental for tenant banner
  const activeRental = memory.getLongTermRental(name);

  res.json({ villa, bookings, upcoming, maintenance, transactions, lockCode, elecMeter, elecKwh,
             wifiName, wifiPassword, wifiPaymentId, wifiMbps, activeRental: activeRental || null });
});

// Status endpoint
app.get('/status', (req, res) => {
  const profile = memory.getOwnerProfile();
  const villas = memory.getAllVillas();
  const upcoming = memory.getUpcomingBookings(7);
  res.json({
    status: 'online',
    version: '2.0-PEMS',
    owner: profile.name || 'Not configured',
    villas: villas.length,
    upcomingBookings: upcoming.length,
    activeSessions: sessions.size,
    model: 'claude-sonnet-4-5-20250929',
    uptime: process.uptime()
  });
});

// Dashboard (serves index.html)

// ── Telegram Status & Config ────────────────────────────────────────────────
app.get('/telegram/status', (req, res) => {
  res.json(telegram.getStatus());
});

app.post('/telegram/configure', requireAuth, (req, res) => {
  const { bot_token } = req.body;
  if (!bot_token) return res.status(400).json({ error: 'bot_token required' });
  
  // Save to .env
  const envPath = require('path').join(__dirname, '.env');
  let env = require('fs').readFileSync(envPath, 'utf8');
  if (env.includes('TELEGRAM_BOT_TOKEN=')) {
    env = env.replace(/TELEGRAM_BOT_TOKEN=.*/g, `TELEGRAM_BOT_TOKEN=${bot_token}`);
  } else {
    env += `\nTELEGRAM_BOT_TOKEN=${bot_token}\n`;
  }
  require('fs').writeFileSync(envPath, env);
  process.env.TELEGRAM_BOT_TOKEN = bot_token;
  
  // Initialize and connect
  telegram.init(bot_token);
  telegram.connect().then(connected => {
    const status = telegram.getStatus();
    res.json({ success: connected, ...status });
  }).catch(e => res.status(500).json({ error: e.message }));
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Scheduled Tasks ───────────────────────────────────────────────────────────

// Daily morning briefing (9 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Running morning briefing...');
  try {
    if (!gmail || typeof gmail.getEmails !== 'function') return;
    if (!calendar || typeof calendar.getEvents !== 'function') return;
    const emails = await gmail.getEmails(5);
    const events = await calendar.getEvents(5);
    const upcoming = memory.getUpcomingBookings(3);

    memory.setFact('briefing', 'last_run', new Date().toISOString(), 'cron');
    console.log(`[Cron] Briefing: ${emails.length} emails, ${events.length} events, ${upcoming.length} upcoming bookings`);
  } catch (err) {
    console.error('[Cron] Briefing error:', err.message);
  }
}, { timezone: 'Asia/Makassar' });

// Hourly email check
cron.schedule('0 * * * *', async () => {
  if (!gmail || typeof gmail.getUnreadEmails !== 'function') return;
  try {
    const unread = await gmail.getUnreadEmails(5);
    if (unread && unread.length > 0) {
      memory.setFact('email', 'flagged_count', unread.length, 'cron');
    }
  } catch (err) {
    // Gmail not configured — suppress noise
  }
}, { timezone: 'Asia/Makassar' });

// Daily maintenance reminder — 9:00 AM Bali time (WITA, UTC+8)
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Running maintenance reminder...');
  try {
    if (!maintenance || !whatsapp) {
      console.log('[Cron] Maintenance or WhatsApp not available — skipping');
      return;
    }

    const status = whatsapp.getStatus();
    if (!status.connected) {
      console.log('[Cron] WhatsApp not connected — skipping maintenance reminder');
      return;
    }

    // Read maintenance group JID from whatsapp-config
    const waCfg = whatsapp.loadConfig();
    const maintGroup = (waCfg.groups || []).find(g =>
      g.type === 'maintenance' || (g.name || '').toLowerCase().includes('maintenance')
    );

    if (!maintGroup || !maintGroup.jid) {
      console.log('[Cron] No maintenance group configured — skipping reminder');
      return;
    }

    const pending = await maintenance.getPendingItems();
    const message = maintenance.formatMorningReminder(pending);

    await whatsapp.sendMessage(maintGroup.jid, message);
    console.log('[Cron] Maintenance reminder sent to ' + maintGroup.name + ' (' + pending.length + ' items)');

    memory.setFact('maintenance', 'last_reminder', new Date().toISOString(), 'cron');
    memory.setFact('maintenance', 'pending_count', pending.length, 'cron');

    // After 2 min delay, send blank-status check (ask team to update uncategorized items)
    setTimeout(async () => {
      try {
        const blankItems = await maintenance.getBlankStatusItems();
        if (blankItems.length > 0) {
          const statusMsg = maintenance.formatStatusCheck(blankItems);
          if (statusMsg) {
            await whatsapp.sendMessage(maintGroup.jid, statusMsg);
            console.log('[Cron] Blank status check sent (' + blankItems.length + ' items need status)');
          }
        }
      } catch (e) {
        console.error('[Cron] Blank status check error:', e.message);
      }
    }, 120000); // 2 minutes after main reminder
  } catch (err) {
    console.error('[Cron] Maintenance reminder error:', err.message);
  }
}, { timezone: 'Asia/Makassar' });

// Follow-up check — 3:00 PM Bali time (ask for after-photos on items reported 3+ days ago)
cron.schedule('0 15 * * *', async () => {
  console.log('[Cron] Running maintenance follow-up check...');
  try {
    if (!maintenance || !whatsapp) return;

    const status = whatsapp.getStatus();
    if (!status.connected) return;

    const waCfg = whatsapp.loadConfig();
    const maintGroup = (waCfg.groups || []).find(g =>
      g.type === 'maintenance' || (g.name || '').toLowerCase().includes('maintenance')
    );
    if (!maintGroup || !maintGroup.jid) return;

    const pending = await maintenance.getPendingItems();
    
    // Find items older than 3 days without after-photos
    const now = new Date();
    const oldItems = pending.filter(item => {
      if (item.hasPhotoAfter) return false;
      // Only follow up on items with PENDING/URGENT status (not blank)
      if (item.status !== 'PENDING' && item.status !== 'URGENT') return false;
      return true;
    });

    if (oldItems.length === 0) return;

    // Send max 3 follow-ups per day to avoid spamming
    const followUps = oldItems.slice(0, 3);
    for (const item of followUps) {
      const msg = maintenance.formatFollowUp(item);
      await whatsapp.sendMessage(maintGroup.jid, msg);
      // Small delay between messages
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log('[Cron] Sent ' + followUps.length + ' maintenance follow-ups');
  } catch (err) {
    console.error('[Cron] Maintenance follow-up error:', err.message);
  }
}, { timezone: 'Asia/Makassar' });

// Daily 7:00 AM — Periodic maintenance schedule scan + calendar sync + 2-day reminder
cron.schedule('0 7 * * *', async () => {
  console.log('[Cron] Running periodic schedule scan...');
  try {
    if (!periodicSchedule) {
      console.log('[Cron] Periodic schedule module not available');
      return;
    }

    // Part 1: Auto-fill missing due dates and update statuses
    const updated = await periodicSchedule.autoFillDueDatesAndStatus();
    console.log('[Cron] Auto-updated ' + updated + ' schedule items (due dates + status)');

    // Part 2: Sync upcoming items to Google Calendar (next 30 days)
    const allItems = await periodicSchedule.getAllSchedules();
    const now = new Date();
    const thirtyDays = new Date(now);
    thirtyDays.setDate(thirtyDays.getDate() + 30);
    const upcoming = allItems.filter(item => {
      if (!item.dueDate) return false;
      return item.dueDate >= now && item.dueDate <= thirtyDays;
    });
    const synced = await periodicSchedule.syncToCalendar(upcoming);
    console.log('[Cron] Synced ' + synced + ' new events to Google Calendar');

    // Part 3: Send WhatsApp reminder for items due in 2 days
    if (whatsapp && whatsapp.getStatus().connected) {
      const waCfg = whatsapp.loadConfig();
      const maintGroup = (waCfg.groups || []).find(g =>
        g.type === 'maintenance' || (g.name || '').toLowerCase().includes('maintenance')
      );

      if (maintGroup && maintGroup.jid) {
        const dueIn2 = await periodicSchedule.getItemsDueInDays(2);
        if (dueIn2.length > 0) {
          const msg = periodicSchedule.formatUpcomingReminder(dueIn2);
          if (msg) {
            await whatsapp.sendMessage(maintGroup.jid, msg);
            console.log('[Cron] Sent 2-day reminder for ' + dueIn2.length + ' items');
          }
        }

        // Also alert on overdue items (weekly, on Monday)
        if (now.getDay() === 1) {
          const overdue = await periodicSchedule.getOverdueItems();
          if (overdue.length > 0) {
            const overdueMsg = periodicSchedule.formatOverdueAlert(overdue.slice(0, 15));
            if (overdueMsg) {
              await whatsapp.sendMessage(maintGroup.jid, overdueMsg);
              console.log('[Cron] Sent overdue alert for ' + overdue.length + ' items');
            }
          }
        }
      }
    }

    memory.setFact('schedule', 'last_scan', new Date().toISOString(), 'cron');
  } catch (err) {
    console.error('[Cron] Periodic schedule error:', err.message);
  }
}, { timezone: 'Asia/Makassar' });

// Email Watcher — fallback poll every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  if (!emailWatcher) return;
  try {
    const result = await emailWatcher.pollForNewEmails();
    if (result.processed > 0) {
      console.log('[Cron] Email watcher: processed ' + result.processed + ' new emails');
    }
  } catch (err) {
    console.error('[Cron] Email watcher error:', err.message);
  }
}, { timezone: 'Asia/Makassar' });

// Gmail Watch renewal — every 6 days (watch expires after 7 days)
cron.schedule('0 3 */6 * *', async () => {
  if (!emailWatcher) return;
  try {
    console.log('[Cron] Renewing Gmail push watch...');
    await emailWatcher.startWatch();
    console.log('[Cron] Gmail watch renewed successfully');
  } catch (err) {
    console.error('[Cron] Gmail watch renewal error:', err.message);
  }
}, { timezone: 'Asia/Makassar' });


// ─── WhatsApp Routes (Baileys — direct WA Web, no Meta API) ───────────────────

// GET /whatsapp/status
app.get('/whatsapp/status', (req, res) => {
  if (!whatsapp) return res.json({ state: 'unavailable', connected: false, qr: null });
  res.json(whatsapp.getStatus());
});

// POST /whatsapp/connect
app.post('/whatsapp/connect', (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  whatsapp.connect().catch(e => console.error('[WA connect]', e.message));
  res.json({ ok: true, message: 'Connecting… poll /whatsapp/status for QR' });
});

// POST /whatsapp/reset — clears session, forces new QR scan
app.post('/whatsapp/reset', (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  whatsapp.resetSession().catch(e => console.error('[WA reset]', e.message));
  res.json({ ok: true, message: 'Session cleared — new QR coming' });
});

// POST /whatsapp/disconnect
app.post('/whatsapp/disconnect', (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  whatsapp.disconnect().catch(e => console.error('[WA disconnect]', e.message));
  res.json({ ok: true, message: 'Disconnected' });
});

// POST /whatsapp/send — send a message to a phone number or group JID
app.post('/whatsapp/send', async (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message are required' });
  try {
    if (to.includes('@g.us')) {
      await whatsapp.sendMessage(to, message);
    } else {
      await whatsapp.sendToNumber(to, message);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /whatsapp/groups — list all WA groups the bot is in (with allowlist overlay)
app.get('/whatsapp/groups', async (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  try {
    const groups = await whatsapp.getGroups();
    const cfg = whatsapp.loadConfig();
    const allowlist = (cfg.groups || []).filter(g => g.jid);
    res.json({ groups, allowlist, policy: cfg.groupPolicy, dmPolicy: cfg.dmPolicy || 'none' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /whatsapp/config — return current group config
app.get('/whatsapp/config', (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  res.json(whatsapp.loadConfig());
});

// POST /whatsapp/config/group — add or update a group rule
// body: { jid, name, active, respondToAll, requireMention, triggerKeywords[] }
app.post('/whatsapp/config/group', (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  const { jid, ...settings } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  try {
    const cfg = whatsapp.updateGroupConfig(jid, settings);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /whatsapp/config/dm — set dmPolicy ('all' or 'none')
app.post('/whatsapp/config/dm', (req, res) => {
  if (!whatsapp) return res.status(503).json({ error: 'WhatsApp module unavailable' });
  const { dmPolicy } = req.body;
  if (!['all', 'none'].includes(dmPolicy)) return res.status(400).json({ error: "dmPolicy must be 'all' or 'none'" });
  try {
    const cfg = whatsapp.loadConfig();
    cfg.dmPolicy = dmPolicy;
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(__dirname, 'whatsapp-config.json'), JSON.stringify(cfg, null, 2));
    res.json({ ok: true, dmPolicy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Email Watcher Webhook (Gmail Push via Pub/Sub) ──────────────────────────

// POST /webhook/gmail — receives Pub/Sub push notifications
app.post('/webhook/gmail', async (req, res) => {
  res.status(200).send('OK');
  if (!emailWatcher) return;
  try {
    const message = req.body?.message;
    if (!message || !message.data) return;
    console.log('[Webhook] Gmail push notification received');
    const result = await emailWatcher.handlePushNotification(message.data);
    console.log('[Webhook] Push result:', JSON.stringify(result));
  } catch (err) {
    console.error('[Webhook] Gmail push error:', err.message);
  }
});

// GET /api/token-stats — token usage metering dashboard

// ── Dashboard: Real-time monitoring UI ──────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'dashboard', 'index.html'));
});


// ─── Chat Search / Message History ─────────────────────────────────────────────
app.get('/api/chat/history', (req, res) => {
  if (!req.session || !req.session.loggedIn) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sessionId = req.query.sessionId || 'web_default';
    const query = (req.query.q || '').toLowerCase().trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const session = sessions.get(sessionId);
    if (!session || !session.history) return res.json({ messages: [], total: 0 });

    let msgs = session.history.map((h, i) => ({
      id: i,
      role: h.role,
      content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content),
      timestamp: h.timestamp || null,
      tools: h.toolsUsed || []
    }));

    if (query) {
      msgs = msgs.filter(m => m.content.toLowerCase().includes(query));
    }

    const total = msgs.length;
    msgs = msgs.slice(-limit);

    res.json({ messages: msgs, total, query: query || null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── SSE: Dashboard real-time stream ──
app.get('/api/dashboard-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');

  const sendUpdate = () => {
    try {
      const data = ruflo ? ruflo.getDashboard(req.query.range || '24h') : {};
      if (tokenOptimizer) data.tokenOptimizer = tokenOptimizer.getStats();
      if (!data.stats) data.stats = {};
      try {
        const activeRentals = memory.getActiveRentals ? memory.getActiveRentals().length : '--';
        data.stats.activeRentals = activeRentals;
      } catch(e) { data.stats.activeRentals = '--'; }
      try {
        if (data.maintenance && Array.isArray(data.maintenance)) {
          data.stats.pendingTasks = data.maintenance.reduce((sum, v) => sum + (v.pending || 0), 0);
        }
      } catch(e) { data.stats.pendingTasks = '--'; }
      data.stats.toolActionsToday = (data.stats.writesToday || 0) + (data.stats.messagesToday || 0);
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch(e) {
      res.write('data: {"error":"' + e.message + '"}\n\n');
    }
  };

  sendUpdate();
  const interval = setInterval(sendUpdate, 15000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

app.get('/api/dashboard', (req, res) => {
  try {
    const data = ruflo ? ruflo.getDashboard(req.query.range) : {};
    if (tokenOptimizer) data.tokenOptimizer = tokenOptimizer.getStats();

    // Enrich with GM-relevant stats
    if (!data.stats) data.stats = {};
    try {
      const activeRentals = memory.getActiveRentals ? memory.getActiveRentals().length : '--';
      data.stats.activeRentals = activeRentals;
    } catch(e) { data.stats.activeRentals = '--'; }
    try {
      if (data.maintenance && Array.isArray(data.maintenance)) {
        data.stats.pendingTasks = data.maintenance.reduce((sum, v) => sum + (v.pending || 0), 0);
      }
    } catch(e) { data.stats.pendingTasks = '--'; }
    data.stats.toolActionsToday = (data.stats.writesToday || 0) + (data.stats.messagesToday || 0);

    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/token-stats', (req, res) => {
  res.json(tokenMeter.getStats());
});

// GET /api/email-watcher/stats
app.get('/api/email-watcher/stats', (req, res) => {
  if (!emailWatcher) return res.json({ available: false });
  res.json({ available: true, ...emailWatcher.getStats() });
});

// POST /api/email-watcher/poll — manually trigger a poll scan
app.post('/api/email-watcher/poll', async (req, res) => {
  if (!emailWatcher) return res.status(503).json({ error: 'EmailWatcher not available' });
  try {
    const result = await emailWatcher.pollForNewEmails();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-watcher/start-watch — start Gmail push notifications
app.post('/api/email-watcher/start-watch', async (req, res) => {
  if (!emailWatcher) return res.status(503).json({ error: 'EmailWatcher not available' });
  try {
    const topic = req.body?.topic;
    const result = await emailWatcher.startWatch(topic);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║          TVMbot PEMS Agent v2.0 Online          ║
║  Architecture: Planner → Executor → Memory → Supervisor  ║
╠══════════════════════════════════════════════════╣
║  Port:    ${PORT}                                       ║
║  Models:  Sonnet 4.5 + Haiku 4.5 (auto-routed + optimized)                     ║
║  Domain:  https://thevillamanagers.cloud               ║
╚══════════════════════════════════════════════════╝
  `);

  // Load startup context
  const profile = memory.getOwnerProfile();
  const villas = memory.getAllVillas();
  const upcoming = memory.getUpcomingBookings(7);

  console.log(`[Memory] Owner: ${profile.name || 'Not configured'}`);
  console.log(`[Memory] Villas: ${villas.length} | Upcoming bookings: ${upcoming.length}`);

  if (gmail) console.log('[Integration] Gmail: ✓');
  if (calendar) console.log('[Integration] Calendar: ✓');

  // ── WhatsApp: wire AI handler and auto-connect ─────────────────────────────
  if (whatsapp) {
    // Store WhatsApp globally for executor document sending
    global.__tvmbot_whatsapp = whatsapp;

    whatsapp.setMessageHandler(async ({ text, senderPhone, isGroup, groupJid, replyJid, quotedText }) => {
      try {
        const sessionId = `wa_${replyJid.replace(/[^a-z0-9]/gi,'_')}`;
        const contextTag = isGroup
          ? `[WhatsApp Group msg from +${senderPhone}]`
          : `[WhatsApp DM from +${senderPhone}]`;
        // Prepend quoted message as context so bot knows what user is replying to
        const quotedCtx = quotedText ? `[Replying to: ${quotedText}] ` : '';
        // Inject fresh datetime per message (RULE 01 from LinkAI best practices)
        const datetimeCtx = formatDatetimeInjection(senderPhone, memory.getDb());
        const fullText = `${datetimeCtx} ${contextTag} ${quotedCtx}${text}`;

        // Set current chat JID for document sending
        global.__tvmbot_current_jid = replyJid;

        // CLOSED. keyword: auto-close maintenance task from quoted context
        if (text.trim() === 'CLOSED.' && quotedText) {
          const closedText = `${contextTag} [Replying to: ${quotedText}] The user says CLOSED. — this means: mark this maintenance task as DONE/COMPLETED immediately. Extract the villa name and issue from the quoted message above, find it in the maintenance sheet, and update its status to DONE. Do NOT ask any follow-up questions. Just close it and confirm briefly.`;
          const result = await runPEMSAgent(closedText, sessionId, `wa_${senderPhone}`);
          let reply = result.reply;
          if (reply) reply = reply.replace(/\*\*/g, '*');
          return reply;
        }

        // Set current chat JID so executor can send documents to this chat
        global.__tvmbot_current_jid = replyJid;

        // Auto-link entities in knowledge graph
        if (knowledgeGraph) {
          try { knowledgeGraph.autoLink(text, { source: 'whatsapp', sender: senderPhone }); } catch(e) {}
        }

        // Ruflo Intelligence Layer processing
        let rufloResult = null;
        if (ruflo) {
          try {
            const rufloStartTime = Date.now();
            rufloResult = ruflo.processMessage(fullText, senderPhone, { sessionId, isGroup });
            if (rufloResult.blocked) {
              return rufloResult.blockMessage || 'Sorry, I cannot process that request.';
            }
            if (rufloResult.boosted) {
              return rufloResult.boosterResponse;
            }
          } catch(e) { console.warn('[Ruflo] Processing error:', e.message); }
        }

        const result = await runPEMSAgent(fullText, sessionId, `wa_${senderPhone}`);
        // Fix WhatsApp formatting: replace ** (double bold) with * (single bold)
        let reply = result.reply;
            // Ruflo post-processing: feed learning + screen response
            if (ruflo && rufloResult) {
              try {
                const postResult = ruflo.postProcess(fullText, reply, rufloResult.metadata, {
                  success: !!reply,
                  responseTimeMs: typeof rufloStartTime !== 'undefined' ? Date.now() - rufloStartTime : 0,
                  tokenCount: result.tokenCount || 0,
                  toolsUsed: result.toolsUsed || [],
                });
                if (postResult.cleanedResponse) reply = postResult.cleanedResponse;
              } catch(e) { /* ignore post-processing errors */ }
            }
        if (reply) reply = reply.replace(/\*\*/g, '*');
        return reply;
      } catch (e) {
        console.error('[WA handler]', e.message);
        return 'Sorry, something went wrong. Please try again.';
      }
    });

    // ── Voice Handler for WhatsApp ─────────────────────────────────────────
    voiceHandler.init({ 
      aiHandler: async (data) => {
        // Route voice transcription through the same PEMS pipeline
        const sessionId = `wa_${data.replyJid.replace(/[^a-z0-9]/gi,'_')}`;
        const result = await runPEMSAgent(data.text, sessionId, `wa_${data.senderPhone}`);
        let reply = result.reply;
        if (reply) reply = reply.replace(/\*\*/g, '*');
        return reply;
      },
      memory 
    });
    
    whatsapp.setVoiceHandler(async (msg, ctx) => {
      try {
        const audioMsg = msg.message.audioMessage || msg.message.pttMessage;
        const buffer = await voiceHandler.downloadWhatsAppMedia(msg, global.__tvmbot_whatsapp?.sock || whatsapp.sock);
        if (!buffer) return 'Sorry, I could not download that voice message.';
        
        return await voiceHandler.processVoiceMessage({
          buffer,
          duration: audioMsg.seconds || 0,
          userId: ctx.senderPhone,
          chatId: ctx.replyJid,
          userName: ctx.senderPhone,
          isGroup: ctx.isGroup,
          channel: 'whatsapp',
          caption: null
        });
      } catch(e) {
        console.error('[Voice WA]', e.message);
        return 'Sorry, I could not process that voice message.';
      }
    });
    
    whatsapp.connect().catch(e => console.error('[WA startup]', e.message));

    // ── Telegram: wire same AI handler and auto-connect ───────────────────────
    if (process.env.TELEGRAM_BOT_TOKEN) {
      telegram.init(process.env.TELEGRAM_BOT_TOKEN);
      
      telegram.setMessageHandler(async ({ text, senderPhone, senderName, isGroup, groupJid, replyJid, quotedText, channel }) => {
        try {
          const sessionId = `tg_${replyJid.replace(/[^a-z0-9]/gi,'_')}`;
          const contextTag = isGroup
            ? `[Telegram Group msg from ${senderName} (${senderPhone})]`
            : `[Telegram DM from ${senderName} (${senderPhone})]`;
          const quotedCtx = quotedText ? `[Replying to: ${quotedText}] ` : '';
          
          // Inject fresh datetime per message (RULE 01)
          const datetimeCtx = formatDatetimeInjection(senderPhone, memory.getDb());
          const fullText = `${datetimeCtx} ${contextTag} ${quotedCtx}${text}`;

          const result = await runPEMSAgent(fullText, sessionId, senderPhone);
          let reply = result.reply;
          if (reply) reply = reply.replace(/\*\*/g, '*');
          return reply;
        } catch (e) {
          console.error('[TG handler]', e.message);
          return 'Sorry, something went wrong. Please try again.';
        }
      });

      // Wire voice handler for Telegram
      voiceHandler.init({ 
        aiHandler: telegram._messageHandler,
        memory 
      });
      telegram.setVoiceHandler(async (voiceData) => {
        return voiceHandler.processVoiceMessage(voiceData);
      });
      
      telegram.connect().then(connected => {
        if (connected) console.log('[Integration] Telegram: ✓ connected');
        else console.log('[Integration] Telegram: failed to connect');
      }).catch(e => console.error('[TG startup]', e.message));
    } else {
      console.log('[Integration] Telegram: no token configured — set TELEGRAM_BOT_TOKEN in .env');
    }
    console.log('[Integration] WhatsApp: connecting…');

    // Wire proactive monitor with WhatsApp + executor
    if (proactiveMonitor) {
      proactiveMonitor.whatsapp = whatsapp;
      proactiveMonitor.memoryManager = memoryManager;
      // Set alert JID from first allowed group (owner's primary group)
      try {
        const waCfg = require('./whatsapp-config.json');
        const firstGroup = (waCfg.groups || []).find(g => g.enabled !== false);
        if (firstGroup) {
          proactiveMonitor.alertJid = firstGroup.jid;
          console.log('[Monitor] Alert target: ' + (firstGroup.name || firstGroup.jid));
        }
      } catch(e) { console.warn('[Monitor] No WhatsApp config for alerts'); }

      // Create executor wrapper for monitor to use tools
      proactiveMonitor.executor = async (toolName, toolInput) => {
        const Executor = require('./executor');
        return await Executor.executeTool(toolName, toolInput, 'monitor@system');
      };

      // Store monitor globally so memory-manager can access it
      global.__tvmbot_monitor = proactiveMonitor;

      // Start monitoring
      proactiveMonitor.start();
      // Start Ruflo background daemon workers
      if (ruflo && ruflo.backgroundDaemon) {
        try {
          typeof ruflo.backgroundDaemon === "function" ? ruflo.backgroundDaemon().start() : ruflo.backgroundDaemon.start();
          console.log('[Daemon] Background workers started');
        } catch(e) { console.warn('[Daemon] Start failed:', e.message); }
      }

    }
  }

  // ── Email Watcher: inject WhatsApp and start ──────────────────────────────
  if (emailWatcher) {
    if (whatsapp) emailWatcher.setWhatsApp(whatsapp);
    emailWatcher.startWatch().catch(err => {
      // Only log once, not repeatedly
      if (!global._emailWatcherWarned) {
        console.warn('[EmailWatcher] Push notifications unavailable:', err.message);
        global._emailWatcherWarned = true;
      }
    });
    setTimeout(() => {
      emailWatcher.pollForNewEmails().catch(err =>
        console.log('[EmailWatcher] Initial poll error:', err.message)
      );
    }, 10000);
    console.log('[Integration] EmailWatcher: active (poll every 15min)');
  }
});


// Ruflo 6-hourly maintenance (cleanup, drift check, consolidation)
if (ruflo) {
  setInterval(() => {
    try {
      const mResult = ruflo.runMaintenance();
      console.log('[Ruflo] Maintenance complete:', JSON.stringify(mResult).substring(0, 200));
    } catch(e) { console.warn('[Ruflo] Maintenance error:', e.message); }
  }, 6 * 60 * 60 * 1000); // Every 6 hours
  
let tokenOptimizer;
try {
  tokenOptimizer = getTokenOptimizer();
  console.log('[TokenOptimizer] Loaded: context compression + agent booster + batch optimizer');
} catch(e) {
  console.warn('[TokenOptimizer] Failed to load:', e.message);
}

  console.log('[Ruflo] Scheduled 6-hourly maintenance');
}

module.exports = app;