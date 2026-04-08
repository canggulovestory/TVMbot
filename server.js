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
// ── Domain Agents + Event Bus ──────────────────────────────────────────────
const eventBus    = require('./event-bus');
const bookingAgent     = require('./agents/domain/booking-agent');
const maintenanceAgent = require('./agents/domain/maintenance-agent');
const financeAgent     = require('./agents/domain/finance-agent');
const reportAgent      = require('./agents/domain/report-agent');

// Wire event bus to domain agents
eventBus.on('booking.received',  (data, opts) => bookingAgent.handle(data, opts).catch(e => console.error('[EventBus] BookingAgent error:', e.message)));
eventBus.on('payment.received',  (data, opts) => financeAgent.handle(data, opts).catch(e => console.error('[EventBus] FinanceAgent error:', e.message)));
eventBus.on('maintenance.issue', (data, opts) => maintenanceAgent.handle(data, opts).catch(e => console.error('[EventBus] MaintenanceAgent error:', e.message)));
eventBus.on('report.morning',    ()           => reportAgent.morningBriefing().catch(e => console.error('[EventBus] ReportAgent error:', e.message)));
eventBus.on('report.weekly',     ()           => reportAgent.weeklySummary().catch(e => console.error('[EventBus] ReportAgent error:', e.message)));

console.log('[EventBus] Domain agent listeners registered');

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

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
// Return JSON (not HTML) on oversized payloads, with a user-friendly message
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    console.warn('[413] Payload too large on', req.path, '—', err.message);
    return res.status(413).json({
      error: 'Image or file too large. Please try a smaller image (under 20 MB) or crop it first.',
      code: 'payload_too_large'
    });
  }
  return next(err);
});

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
// Persistent session store — survives PM2 restarts
const SQLiteStore = require('./sqlite-session-store')(session);
app.use(session({
  store: new SQLiteStore({ dir: path.join(__dirname, 'data'), db: path.join(__dirname, 'data', 'express-sessions.db') }),
  secret: process.env.SESSION_SECRET || 'tvmbot_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware — fully enforced
const OPEN_PATHS = [
  '/login.html', '/auth/login', '/auth/logout',
  '/favicon.svg', '/webhook/gmail',
  '/api/email-watcher/poll', '/api/email-watcher/start-watch'
];

function requireAuth(req, res, next) {
  // Always allow open paths and static assets (js/, css/, etc.)
  if (OPEN_PATHS.includes(req.path)) return next();
  if (req.path.startsWith('/js/') || req.path.startsWith('/css/') || req.path.startsWith('/assets/')) return next();
  // Allow if already authenticated
  if (req.session && req.session.loggedIn) return next();
  // API requests → 401 JSON (frontend fetch interceptor handles session_expired)
  if (req.path.startsWith('/api/') || req.path.startsWith('/chat') || req.path.startsWith('/upload')) {
    return res.status(401).json({ error: 'Not authenticated', session_expired: true });
  }
  // Browser page requests → redirect to login
  return res.redirect('/login.html');
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
    return res.status(403).json({ error: 'Invalid CSRF token', csrf: true });
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

// No-cache for HTML files (prevents stale frontend after deploys)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));

// ─── NO AUTONOMOUS MODE ───────────────────────────────────────────────────────
// Global kill switch — when true, the bot acts as a TOOL only, never on its own.
// No cron jobs, no proactive monitor sends, no background daemon WhatsApp sends.
// Defaults to TRUE. Override with NO_AUTONOMOUS_MODE=false in .env to re-enable.
const NO_AUTONOMOUS_MODE = (process.env.NO_AUTONOMOUS_MODE || 'true').toLowerCase() !== 'false';
global.__tvmbot_no_autonomous = NO_AUTONOMOUS_MODE;
console.log(`[Boot] NO_AUTONOMOUS_MODE = ${NO_AUTONOMOUS_MODE} (autonomous WhatsApp sends ${NO_AUTONOMOUS_MODE ? 'BLOCKED' : 'allowed'})`);

// ─── Session Store ────────────────────────────────────────────────────────────
const sessions = new Map();
const pendingApprovals = new Map(); // sessionId → { plan, resolve, reject, timestamp }
// Pending direct WhatsApp sends awaiting yes/no confirmation
// sessionId → { phone: '+628...', message: '...', createdAt: timestamp }
const pendingDirectSends = new Map();
global.__tvmbot_pendingDirectSends = pendingDirectSends;
const PENDING_SEND_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
    sessions.set(sessionId, { history: [], userEmail: 'unknown', createdAt: Date.now(), recentAttachment: null, activeSheet: null, activeVilla: null, lastMatchedSkills: [], lastVerifiedAction: null });
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

// ─── Reply Cleanup — collapse excessive blank lines ───────────────────────────
function cleanReply(text) {
  if (!text) return text;
  // Normalize CRLF / CR to LF
  text = text.replace(/\r\n?/g, '\n');
  // Strip trailing whitespace from each line (some lines have trailing spaces that defeat the regex)
  text = text.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
  // Collapse 3+ consecutive newlines → max 2 (one blank line)
  text = text.replace(/\n{3,}/g, '\n\n');
  // Remove blank lines between list items (run twice to catch sequences)
  for (let i = 0; i < 3; i++) {
    text = text.replace(/\n\n([ \t]*[-•*][ \t])/g, '\n$1');
    text = text.replace(/\n\n([ \t]*\d+[.)][ \t])/g, '\n$1');
  }
  return text.trim();
}

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

RESPONSE STYLE (CRITICAL — follow strictly):
- Be COMPACT. NEVER use more than one newline between paragraphs. ZERO blank lines between list items.
- Use SINGLE newline (\n) between sections, NEVER double newline (\n\n) unless starting a completely new topic.
- Keep confirmations to 1-3 lines maximum. Do not repeat what the user said.
- Do NOT give examples unless the user specifically asks.
- When asking clarifying questions, ask ONLY the truly missing essentials in 1-2 lines.
- For bullet lists: put each item on its own line with NO blank lines between items.
- NEVER start a response with a blank line. NEVER end with blank lines.

FILE UPLOAD RULES:
- If a PDF/document attachment is present in the conversation context (look for [RECENT ATTACHMENT] or [User uploaded]), NEVER ask the user to upload it again.
- Work from the extracted text directly. Parse it, extract data, and proceed.
- If extraction failed or text is empty, THEN ask the user to re-upload or paste the content.

SPREADSHEET LINK RULES:
- If the user provides a Google Sheets URL, treat it as the target sheet for the current task.
- Do NOT ask for the sheet link again if it was already provided.
- If the link includes a gid parameter, target that specific tab.
- The master expenses sheet ID is: 1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4

FINANCE/EXPENSE ENTRY WORKFLOW:
- If the user provides: (1) uploaded file with data, (2) transaction type (income/expense), (3) target sheet, and (4) payment method — move STRAIGHT to extraction and entry. Do not ask unnecessary questions.
- Only ask about fields that are genuinely missing from the source data AND required by the target sheet format.
- Parse all rows from the uploaded document and present them for confirmation, or write directly if the user says "input all".

WRITE VERIFICATION (MANDATORY):
- When sheets_append_row or sheets_write_data returns, check the 'verified' field.
- If verified=true, report the updatedRange and updatedRows to the user.
- If verified=false or success=false, tell the user the write FAILED. Do NOT claim rows were written.
- NEVER say "Done! X rows logged" unless the tool result has verified=true.
- Include the actual updatedRange (e.g. "EXPENSES!A205:K228") in your confirmation.

EXECUTION RULES:
1. Use tools to get REAL data — never guess or make up emails, names, dates
2. ALWAYS read before write: check target cells/data before modifying anything in Google Sheets. If a cell has a formula, SKIP it.
3. For SENSITIVE actions (send email to external contacts, delete events, modify financial records): state what you will do, then do it. For routine operations (reading data, checking status, logging entries) — just execute directly.
4. Chain tools when needed: first read, then write; first check availability, then book
5. After completing tasks, confirm briefly what was done. Keep confirmations SHORT on WhatsApp.
6. Save important discoveries to memory using save_note
7. If a task is unclear, ask ONE short clarifying question before proceeding
13. TASK ROUTING (CRITICAL): When user says "make a task", "add to task list", "create a checklist", "follow this up", "assign this", "track this", "to-do" — ALWAYS use todo_create_task to save it to Notion. Do NOT just output text. The task must be saved. Confirm with the Notion URL from the result.
14. TOOL-NOT-ASSISTANT MODE (CRITICAL): You are a TOOL. You execute exactly what the operator says — nothing more.
    - NEVER initiate, propose follow-ups, remind, ping, or send unsolicited messages.
    - NEVER continue a topic on your own. If the operator did not ask, do not act.
    - NEVER add commentary, suggestions, or "next steps" after completing a request unless asked.
    - When the operator says "send WhatsApp to <number>: <message>", call whatsapp_send_direct with phone_number and message VERBATIM. Do not paraphrase, polish, or expand the message.
    - The whatsapp_send_direct tool returns a preview that ends with "Send this message? (yes/no)". When you receive that result, output the preview text EXACTLY as returned and STOP. Do not call any other tool. Do not add anything before or after.
    - After the operator confirms with "yes", the system handles the actual send and the assistant is not invoked again for that turn. Do not preempt this.
    - After a successful send the only acceptable acknowledgement is "Sent to +<number>." — nothing else.
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
URL: https://docs.google.com/spreadsheets/d/1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ

⚠️ THIS IS A FORMULA-DRIVEN TEMPLATE. 90%+ of cells contain formulas. Overwriting a formula DESTROYS the template permanently with NO undo. Follow the rules below with ZERO exceptions.

TABS (26 total):
- WRITABLE: "Transactions (Variable)", "Transactions (Recurring)" — ONLY these 2
- READ-ONLY (NEVER write): Setup, Annual Dashboard, Bank Accounts, Payment Tracker, Monthly Calendar, Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec, Expense Distribution, Income Distribution, 50/30/20 Rule Tracker, Debt Calculator, Savings Tracker, Net Worth Tracker, Annual Report (Printable)

#### Transactions (Variable) — SAFE WRITE COLUMNS:
Header row: 6. Data starts: row 7.
| Header | Header Col | INPUT Col | What to write |
| DESCRIPTION | J (idx 9) | J (idx 9) | Text description |
| AMOUNT | Q (idx 16) | R (idx 17) | Number ONLY. Column Q has "Rp" label — NEVER touch Q |
| DATE | U (idx 20) | U (idx 20) | YYYY-MM-DD format |
| SPENDER | Y (idx 24) | Y (idx 24) | Person name |
| CATEGORY | AS (idx 44) | AS (idx 44) | Category name |
SAFE COLUMNS: J, R, U, Y, AS — nothing else.
⛔ FORBIDDEN: A-I (layout/formulas), K-P (formulas), Q ("Rp" label), S-T (formulas), V-X (formulas), Z-AR (formulas/dropdowns), AT+ (hidden calcs)

#### Transactions (Recurring) — SAFE WRITE COLUMNS:
Header row: 8. Data starts: row 9.
| Header | Header Col | INPUT Col | What to write |
| DESCRIPTION | K (idx 10) | K (idx 10) | Text description |
| FREQUENCY | R (idx 17) | R (idx 17) | "Monthly", "Weekly", etc. |
| AMOUNT | V (idx 21) | W (idx 22) | Number ONLY. Column V has formula =IF(W<>"",Setup!$H$16,"") — NEVER touch V |
| DATE | Z (idx 25) | Z (idx 25) | YYYY-MM-DD format |
| MEMBER | AF (idx 31) | AF (idx 31) | Member name |
SAFE COLUMNS: K, R, W, Z, AF — nothing else.
⛔ FORBIDDEN: A-J (layout/formulas), L-Q (formulas), S-U (formulas), V (FORMULA — auto "Rp"), X-Y (formulas), AA-AE (formulas), AG+ (formulas)

#### MANDATORY WRITE PROCEDURE:
1. READ FIRST: Before ANY write, read target range with valueRenderOption:FORMULA
2. CHECK: If any cell starts with "=", it's a formula — DO NOT WRITE TO IT
3. VERIFY COLUMN: Cross-check against safe list above. Not in list = DO NOT WRITE
4. WRITE ONLY SAFE CELLS: Target only J/R/U/Y/AS (Variable) or K/R/W/Z/AF (Recurring)
5. VERIFY AFTER: Read back to confirm adjacent formulas survived

#### APPEND ROW FORMAT:
Variable: array with values at index 9=DESCRIPTION, 17=AMOUNT, 20=DATE, 24=SPENDER, 44=CATEGORY. All other indexes = ""
Recurring: array with values at index 10=DESCRIPTION, 17=FREQUENCY, 22=AMOUNT, 25=DATE, 31=MEMBER. All other indexes = ""
Write amounts as plain numbers (e.g. 500000, not "Rp 500.000").

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
- Internal Sheet is STRICTLY OWNER ONLY

## SUPERPOWERS: ADVANCED EXECUTION PROTOCOLS

### 1. PLANNING BEFORE EXECUTION
When a task involves 3+ steps or touches multiple systems (Sheets + Calendar + Email, bulk operations, reorganizing data, setting up a new villa, monthly reports), DO NOT jump in. Plan first.

PROCEDURE:
1. State the goal in one line
2. List the steps you will take (numbered, short)
3. Identify which tools/sheets/tabs each step needs
4. Flag any risks (formula cells, duplicate data, missing info)
5. Execute step by step, confirming each before moving to next

WHEN TO PLAN:
- "Log all expenses for this month" → plan which tabs, what data, what order
- "Set up a new villa" → plan: VILLAS_MASTER row, calendar, suppliers, maintenance tab
- "Send payment reminders to all overdue" → plan: read BILLS_DB, filter unpaid, draft messages, confirm before sending
- "Reorganize Drive files" → plan: list current structure, define target, move one by one

WHEN NOT TO PLAN (just do it):
- Single lookups: "What's Villa Ann's wifi password?"
- Simple reads: "Show me today's bookings"
- One-step writes: "Log this expense: 500k for pool cleaning"
- Quick answers: "What time is checkout?"

### 2. VERIFICATION AFTER COMPLETION
After ANY write operation (Sheets, Calendar, Drive, Email), VERIFY before reporting success.

THE RULE: Evidence before claims. Never say "Done" without proof.

PROCEDURE:
- After sheets_write_data or sheets_append_row → READ BACK the written range, confirm values match
- After calendar_create_event → READ the event back using calendar_get_events, confirm details
- After sending email → Confirm the send result, report message ID
- After drive operations → Verify file exists in target location

EXAMPLES:
✅ Write expense → Read row back → "Logged: Pool cleaning Rp 500,000 on 2026-03-29 ✓"
✅ Create event → Read event back → "Event created: Villa Ann checkout 11:00 AM Mar 30 ✓"
❌ "Done! I've added the expense." (without reading back)
❌ "Event created successfully." (without verifying it exists)

FOR SHEETS SPECIFICALLY:
- After writing to Financial Tracker → Read back AND check adjacent formula cells still intact
- After bulk writes → Read back a sample of rows to confirm
- If verification fails → Report the actual state, do NOT retry blindly

### 3. SYSTEMATIC DEBUGGING
When ANY operation fails (API error, wrong data, missing info, unexpected result), follow this process. NO random retrying.

PHASE 1 — UNDERSTAND THE ERROR:
1. Read the FULL error message carefully (don't skip details)
2. Identify: What tool failed? What was the input? What was expected vs actual?
3. Check: Is this a permissions issue? Wrong ID? Missing data? Rate limit?

PHASE 2 — DIAGNOSE:
1. If Sheets error → Check: correct spreadsheet ID? Correct tab name? Correct range? Does the tab exist?
2. If Calendar error → Check: valid date format? Event ID exists? Correct calendar ID?
3. If Email error → Check: valid recipient? Attachment exists? Rate limited?
4. If Drive error → Check: file ID valid? Correct folder? Permissions?

PHASE 3 — FIX (one thing at a time):
1. Form ONE hypothesis: "I think it failed because X"
2. Make the SMALLEST fix to test that hypothesis
3. Try again
4. If it fails again → form NEW hypothesis, don't repeat the same fix
5. After 3 failed attempts → STOP and tell the user: "I've tried X, Y, Z — none worked. Here's what I know: [details]. I need your help to investigate further."

NEVER DO:
- Retry the exact same call hoping for different results
- Change multiple things at once
- Say "let me try again" without explaining what you'll change
- Hide errors from the user — always report what went wrong`;
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
    },
    todo: {
      keywords: ['todo', 'task', 'to do', 'to-do', 'assign', 'assignee', 'overdue', 'kanban', 'checklist', 'follow up', 'follow this up', 'track this', 'remind me to', 'add to my list'],
      tools: ['todo_get_tasks', 'todo_create_task', 'todo_update_task', 'todo_delete_task', 'todo_get_summary']
    },
    villa_utility: {
      keywords: ['lock', 'code', 'keybox', 'key box', 'door code', 'pin', 'electricity', 'meter', 'kwh', 'wifi', 'password', 'daya listrik', 'update lock', 'update code', 'update meter', 'kode', 'sandi', 'listrik'],
      tools: ['villa_update_utility', 'villa_get_utilities']
    },
    whatsapp: {
      keywords: [
        'whatsapp', 'wa', 'send wa', 'kirim wa', 'kirim whatsapp', 'send whatsapp',
        'wa to', 'wa ke', 'send to +', 'kirim ke +', 'message +', 'pesan ke +',
        'send a wa', 'send a whatsapp', 'text +', 'dm +', 'kirim pesan'
      ],
      tools: ['whatsapp_send_direct', 'whatsapp_send_document']
    }
  };

  // Force-include whatsapp tools when message contains a phone number AND a send verb
  const phoneRegex = /(?:\+?62|\+?\d{1,3}[\s-]?)?\d[\d\s().-]{6,}\d/;
  const sendVerb = /(send|kirim|text|dm|message|pesan|forward|teruskan)\b/i;
  if (phoneRegex.test(userMessage) && sendVerb.test(userMessage)) {
    // Pre-include whatsapp tools
    if (!toolGroups.whatsapp) {
      toolGroups.whatsapp = { keywords: [], tools: ['whatsapp_send_direct', 'whatsapp_send_document'] };
    }
    toolGroups.whatsapp.__forced = true;
  }

  // Always include these core tools (tiny overhead)
  const selectedTools = new Set(['get_owner_profile', 'save_note']);

  // Match tool groups based on keywords (and forced flag)
  let matched = false;
  for (const [group, config] of Object.entries(toolGroups)) {
    if (config.__forced || config.keywords.some(kw => msg.includes(kw))) {
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
  const isFile = userMessage.includes('[User uploaded');
  if (isFile) console.log(`[PEMS] File context message: ${userMessage.length} chars`);
  const session = getSession(sessionId);
  const startTime = Date.now();

  // Ruflo pre-processing for web chat
  let rufloResult = null;
  if (ruflo) {
    try {
      rufloResult = ruflo.processMessage(userMessage, userEmail, { sessionId, isGroup: false });
      if (rufloResult && rufloResult.blocked) {
        return { reply: rufloResult.blockMessage || 'Sorry, I cannot process that request.', plan: null, validation: null, toolsUsed: [], elapsed: Date.now() - startTime };
      }
      if (rufloResult && rufloResult.boosted) {
        return { reply: rufloResult.boosterResponse, plan: null, validation: null, toolsUsed: [], elapsed: Date.now() - startTime };
      }
    } catch(e) { console.warn('[PEMS] Ruflo pre-process error:', e.message); }
  }

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
  if (skillLoader) {
    contextParts.push(skillLoader.buildSkillContext(userMessage));
    // Track matched skills in session for continuity
    const skillMatch = skillLoader.matchSkills(userMessage);
    session.lastMatchedSkills = skillMatch.matched.map(s => s.id);
  }
  if (rufloResult && rufloResult.systemPromptAddition) contextParts.push(rufloResult.systemPromptAddition);

  // ── Detect active villa from user message ────────────────────────────────
  const villaPattern = /villa\s+(alyssa|ann|diane|lian|louna|lourinka|lysa|nissa)/i;
  const villaMatch = userMessage.match(villaPattern);
  if (villaMatch) {
    session.activeVilla = villaMatch[1].charAt(0).toUpperCase() + villaMatch[1].slice(1).toUpperCase();
    console.log('[Session] Active villa:', session.activeVilla);
  }

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
  // File context messages (PDF/doc uploads) are allowed up to 4000 chars to preserve extracted text
  historySlice = historySlice.map(m => {
    if (typeof m.content !== 'string') return m;
    const isFileMsg = m.content.includes('[User uploaded');
    const limit = isFileMsg ? 4000 : 2000;
    if (m.content.length > limit) {
      return { ...m, content: m.content.slice(0, limit) + '... [trimmed]' };
    }
    return m;
  });
  
  console.log('[Budget] History: ' + historySlice.length + ' msgs, ~' + Math.round(historyTokens) + ' tokens');

  // ── Inject persisted file + sheet context if available ──
  let extraContext = '';
  if (session.recentAttachment && session.recentAttachment.text && !userMessage.includes('[User uploaded')) {
    // User is on a follow-up turn — inject the stored attachment so AI remembers it
    extraContext += `\n\n[RECENT ATTACHMENT — already uploaded, DO NOT ask user to upload again]\nFilename: ${session.recentAttachment.filename}\nType: ${session.recentAttachment.fileType}\nExtracted text:\n${session.recentAttachment.text}\n[END ATTACHMENT]`;
    console.log(`[PEMS] Injected stored attachment: ${session.recentAttachment.filename} (${session.recentAttachment.text.length} chars)`);
  }
  if (session.activeSheet) {
    extraContext += `\n\n[ACTIVE SPREADSHEET TARGET — user provided this link, use it]\nURL: ${session.activeSheet.url}\nSpreadsheet ID: ${session.activeSheet.spreadsheetId}`;
    if (session.activeSheet.tabName) extraContext += `\nTarget tab: ${session.activeSheet.tabName}`;
    if (session.activeSheet.gid) extraContext += `\nTab GID: ${session.activeSheet.gid}`;
    extraContext += `\nUse sheets_append_row with spreadsheetId="${session.activeSheet.spreadsheetId}" and sheetName="${session.activeSheet.tabName || 'EXPENSES'}" to write rows.\n[END SHEET]`;
  }
  if (session.activeVilla) {
    extraContext += `\n\n[ACTIVE VILLA — current context is ${session.activeVilla}. Use this as default villa unless user specifies otherwise.]`;
  }
  if (session.lastMatchedSkills && session.lastMatchedSkills.length > 0) {
    extraContext += `\n[RECENT SKILLS: ${session.lastMatchedSkills.join(', ')}]`;
  }
  if (session.lastVerifiedAction) {
    const lva = session.lastVerifiedAction;
    const age = Math.round((Date.now() - lva.timestamp) / 1000);
    if (age < 300) {
      extraContext += `\n[LAST ACTION: ${lva.tool} → ${lva.verified ? 'VERIFIED' : lva.success ? 'SUCCESS (unverified)' : 'FAILED'}${lva.detail ? ': ' + lva.detail.slice(0, 150) : ''}]`;
    }
  }

  const messages = [
    ...historySlice,
    { role: 'user', content: userMessage + extraContext }
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
          // Pass current sessionId to executor (used by whatsapp_send_direct preview/confirm)
          global.__tvmbot_current_session = sessionId;
          result = await executeTool(block.name, block.input, userEmail);
          global.__tvmbot_current_session = null;
          // Cache read-only tool results
          if (CACHEABLE_TOOLS.has(block.name)) {
            setCachedResponse(cacheKey, result);
          }
        }

        // Short-circuit: if a tool requested stop_and_reply (e.g. whatsapp_send_direct preview),
        // bypass any further AI iterations and return the preview text verbatim.
        if (result && result.stop_and_reply) {
          const shortReply = cleanReply(result.stop_and_reply);
          session.history.push({ role: 'user', content: userMessage });
          session.history.push({ role: 'assistant', content: shortReply });
          if (session.history.length > 20) session.history = session.history.slice(-20);
          return {
            reply: shortReply,
            plan,
            validation,
            toolsUsed: [...toolsUsed],
            iterations,
            elapsed: Date.now() - startTime
          };
        }

        // Auto-learn from tool results
        if (block.name === 'get_owner_profile' && result.profile) {
          // Profile already in memory
        }
        if (block.name === 'docs_create_contract' && result.success) {
          memory.setFact('contracts', `contract_${Date.now()}`,
            `Contract for ${block.input.guestName} at ${block.input.villaName}`, userEmail);
        }

        // Track verified write actions in session for continuity
        if (result && (result.verified !== undefined || result.success !== undefined)) {
          session.lastVerifiedAction = {
            tool: block.name,
            success: result.success || false,
            verified: result.verified || false,
            detail: result.verificationDetail || result.message || '',
            timestamp: Date.now()
          };
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

  // Compact whitespace — collapse excessive blank lines before storing/returning
  finalReply = finalReply.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '').trim();

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
  // File-context messages (from PDF/doc uploads) include extracted text and can be much longer.
  // Regular user-typed chat is capped at 4000 chars; file contexts are allowed up to 24000.
  const isFileContext = message.startsWith('[User uploaded');
  const msgLimit = isFileContext ? 24000 : 4000;
  if (message.length > msgLimit) {
    return res.status(400).json({ error: isFileContext
      ? `Document too large to process (${message.length} chars). Try a shorter document.`
      : 'Message too long (max 4000 characters)' });
  }

  const sid = sessionId || `session_${Date.now()}`;
  const email = userEmail || req.ip || 'unknown';

  try {
    // ── Pending direct WhatsApp send: yes/no confirmation ──────────────────
    if (pendingDirectSends.has(sid)) {
      const entry = pendingDirectSends.get(sid);
      // Expire stale entries
      if (Date.now() - entry.createdAt > PENDING_SEND_TTL_MS) {
        pendingDirectSends.delete(sid);
      } else {
        const lower = (message || '').toLowerCase().trim();
        const yesWords = ['yes', 'y', 'ya', 'send', 'send it', 'kirim', 'confirm', 'ok', 'okay', 'go', 'go ahead', 'do it', 'proceed'];
        const noWords  = ['no', 'n', 'cancel', 'stop', 'batal', 'jangan', 'abort', 'nevermind', 'never mind'];
        const isYes = yesWords.some(w => lower === w || lower.startsWith(w + ' '));
        const isNo  = noWords.some(w => lower === w || lower.startsWith(w + ' '));

        if (isYes) {
          pendingDirectSends.delete(sid);
          try {
            // Authorize the outbound send through the NO_AUTONOMOUS gate
            global.__tvmbot_authorized_send = true;
            try {
              await whatsapp.sendToNumber(entry.phone, entry.message);
            } finally {
              global.__tvmbot_authorized_send = false;
            }
            return res.json({
              reply: `Sent to ${entry.phone}.`,
              sessionId: sid,
              meta: { toolsUsed: ['whatsapp_send_direct'], iterations: 1 }
            });
          } catch (e) {
            return res.json({
              reply: `Failed to send to ${entry.phone}: ${e.message}`,
              sessionId: sid,
              meta: { toolsUsed: ['whatsapp_send_direct'], iterations: 1 }
            });
          }
        } else if (isNo) {
          pendingDirectSends.delete(sid);
          return res.json({
            reply: `Cancelled. Nothing was sent to ${entry.phone}.`,
            sessionId: sid,
            meta: { toolsUsed: [], iterations: 0 }
          });
        }
        // Anything else: drop the pending and fall through to normal handling
        pendingDirectSends.delete(sid);
      }
    }

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

    // ── Persist uploaded file context across turns ──
    const _sess = getSession(sid);
    if (message.includes('[User uploaded')) {
      const fnMatch = message.match(/file: "([^"]+)"/);
      const typeMatch = message.match(/a (\w+) file:/);
      const textMatch = message.match(/EXTRACTED CONTENT:\n---\n([\s\S]*?)\n---/);
      _sess.recentAttachment = {
        filename: fnMatch ? fnMatch[1] : 'unknown',
        fileType: typeMatch ? typeMatch[1] : 'document',
        text: textMatch ? textMatch[1] : '',
        preview: textMatch ? textMatch[1].slice(0, 200) : '',
        timestamp: Date.now()
      };
      console.log(`[Session] Stored attachment: "${_sess.recentAttachment.filename}" (${_sess.recentAttachment.text.length} chars)`);
    }

    // ── Detect and store Google Sheets URL ──
    const sheetMatch = message.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:[^\s]*gid=(\d+))?/);
    if (sheetMatch) {
      _sess.activeSheet = {
        spreadsheetId: sheetMatch[1],
        gid: sheetMatch[2] || null,
        tabName: null,
        url: sheetMatch[0]
      };
      // Resolve gid → tab name if possible
      if (sheetMatch[2]) {
        try {
          const sheets = require('./integrations/sheets');
          const meta = await sheets.getSpreadsheet(sheetMatch[1]);
          if (meta && meta.sheets) {
            const tab = meta.sheets.find(s => String(s.properties.sheetId) === sheetMatch[2]);
            if (tab) _sess.activeSheet.tabName = tab.properties.title;
          }
        } catch(e) { /* gid resolution is best-effort */ }
      }
      console.log(`[Session] Active sheet: ${_sess.activeSheet.spreadsheetId} gid=${_sess.activeSheet.gid} tab=${_sess.activeSheet.tabName}`);
    }

    const result = await runPEMSAgent(enrichedMessage, sid, email);

    res.json({
      reply: cleanReply(result.reply),
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
    const errId = Date.now().toString(36);
    console.error(`[Server] Chat error [${errId}]:`, err.constructor?.name || 'Error', err.message, '\n', err.stack?.split('\n').slice(0,4).join('\n'));
    let code = 'internal_error';
    let userReply = 'Something went wrong. Please try again.';
    let status = 500;
    if (err.status === 429 || (err.message && err.message.includes('rate_limit'))) {
      code = 'rate_limited'; status = 429;
      userReply = 'Too many requests. Please wait 30 seconds.';
    } else if (err.message && err.message.includes('overloaded')) {
      code = 'ai_overloaded';
      userReply = 'AI service temporarily busy. Try again in a minute.';
    } else if (err.message && err.message.includes('timeout')) {
      code = 'timeout';
      userReply = 'Request took too long. Try a simpler question.';
    } else if (err.message && err.message.includes('context_length')) {
      code = 'context_too_long';
      userReply = 'Message too complex. Try a shorter request.';
    }
    res.status(status).json({ error: userReply, code, ref: errId, reply: userReply });
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
  console.log(`[Upload] Received: "${originalname}" (${mimetype}, ${size} bytes) → ${tmpPath}`);
  let extractedText = '';
  let fileType = 'document';

  try {
    if (mimetype === 'application/pdf' || originalname.match(/\.pdf$/i)) {
      fileType = 'pdf';
      const rawBuf = fs.readFileSync(tmpPath);
      console.log(`[Upload] PDF buffer size: ${rawBuf.length} bytes`);
      const data = await pdfParse(rawBuf);
      extractedText = data.text?.slice(0, 6000) || '';
      console.log(`[Upload] PDF extracted: ${extractedText.length} chars, pages: ${data.numpages}`);
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

  console.log(`[Upload] Done: type=${fileType}, textLen=${extractedText.length}`);
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

// ── Document Download Endpoint ─────────────────────────────────────────────
app.get('/download/:token', (req, res) => {
  const store = global._docTokenStore;
  if (!store) return res.status(404).send('No documents available');
  const entry = store.get(req.params.token);
  if (!entry) return res.status(404).send('Document not found or expired');
  if (Date.now() > entry.expires) { store.delete(req.params.token); return res.status(410).send('Download link expired'); }
  const fs = require('fs');
  if (!fs.existsSync(entry.path)) return res.status(404).send('File not found');
  res.setHeader('Content-Disposition', `attachment; filename="${entry.name}"`);
  res.setHeader('Content-Type', entry.mime);
  res.sendFile(entry.path);
});

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
  if (NO_AUTONOMOUS_MODE) { console.log('[Cron] Morning briefing skipped (NO_AUTONOMOUS_MODE)'); return; }
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
  if (NO_AUTONOMOUS_MODE) return;
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
  if (NO_AUTONOMOUS_MODE) { console.log('[Cron] Maintenance reminder skipped (NO_AUTONOMOUS_MODE)'); return; }
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
  if (NO_AUTONOMOUS_MODE) { console.log('[Cron] Maintenance follow-up skipped (NO_AUTONOMOUS_MODE)'); return; }
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
  if (NO_AUTONOMOUS_MODE) { console.log('[Cron] Periodic schedule scan skipped (NO_AUTONOMOUS_MODE)'); return; }
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

// Email Watcher — fallback poll every 15 minutes (read-only — safe under NO_AUTONOMOUS_MODE)
cron.schedule('*/15 * * * *', async () => {
  if (NO_AUTONOMOUS_MODE) return;
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
  if (NO_AUTONOMOUS_MODE) return;
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


// GET /whatsapp/scan — dedicated QR scan page (no CSRF, for easy access)
app.get('/whatsapp/scan', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TVMbot — Scan WhatsApp QR</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f0eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 32px 28px; max-width: 380px; width: 100%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.1); }
    h1 { font-size: 1.1rem; font-weight: 700; margin-bottom: 4px; }
    p { font-size: .82rem; color: #6b7280; margin-bottom: 20px; }
    #qr-wrap { width: 260px; height: 260px; margin: 0 auto 16px; background: #f3f4f6; border-radius: 12px; display: flex; align-items: center; justify-content: center; border: 2px solid #e5e7eb; overflow: hidden; }
    #qr-img { width: 260px; height: 260px; display: none; border-radius: 10px; }
    #status { font-size: .78rem; font-weight: 600; padding: 8px 14px; border-radius: 8px; margin-bottom: 16px; }
    .s-ready  { background: #eff6ff; color: #1e40af; }
    .s-wait   { background: #fef9c3; color: #713f12; }
    .s-ok     { background: #d1fae5; color: #065f46; }
    .s-err    { background: #fee2e2; color: #991b1b; }
    .steps { text-align: left; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 10px; padding: 12px 14px; font-size: .74rem; color: #075985; line-height: 2; margin-bottom: 16px; }
    .steps strong { font-weight: 700; }
    .spinner { width: 36px; height: 36px; border: 3px solid #e5e7eb; border-top-color: #6366f1; border-radius: 50%; animation: spin .8s linear infinite; margin: 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    small { font-size: .7rem; color: #9ca3af; }
    button { margin-top: 12px; padding: 9px 20px; background: #16a34a; color: white; border: none; border-radius: 8px; font-size: .82rem; font-weight: 600; cursor: pointer; width: 100%; }
    button:hover { background: #15803d; }
  </style>
</head>
<body>
<div class="card">
  <h1>📱 Connect TVMbot</h1>
  <p>Scan this QR code with WhatsApp to connect the bot</p>
  <div id="status" class="s-wait">Checking status…</div>
  <div id="qr-wrap">
    <div class="spinner" id="spinner"></div>
    <img id="qr-img" src="" alt="QR Code">
  </div>
  <div class="steps">
    1. Open <strong>WhatsApp</strong> on your phone<br>
    2. Tap <strong>⋮ Settings → Linked Devices</strong><br>
    3. Tap <strong>Link a Device</strong><br>
    4. Point camera at the QR code above
  </div>
  <small id="timer">QR refreshes automatically</small>
  <button onclick="forceNew()">↻ Generate New QR</button>
</div>
<script>
let lastQR = null;
async function poll() {
  try {
    const r = await fetch('/whatsapp/status');
    const d = await r.json();
    const status = document.getElementById('status');
    const qrImg  = document.getElementById('qr-img');
    const spinner = document.getElementById('spinner');
    const timer   = document.getElementById('timer');
    if (d.connected) {
      status.className = 'status s-ok';
      status.textContent = '✅ Connected! Bot is live.';
      qrImg.style.display = 'none';
      spinner.style.display = 'none';
      document.getElementById('qr-wrap').style.background = '#d1fae5';
    } else if (d.qr) {
      status.className = 'status s-ready';
      status.textContent = '📱 Scan the QR code now';
      if (d.qr !== lastQR) {
        lastQR = d.qr;
        qrImg.src = d.qr;
        qrImg.style.display = 'block';
        spinner.style.display = 'none';
        timer.textContent = 'QR valid for ~60s — refreshes automatically';
      }
    } else {
      status.className = 'status s-wait';
      status.textContent = '⏳ Generating QR code…';
      qrImg.style.display = 'none';
      spinner.style.display = 'block';
      timer.textContent = 'Starting connection…';
    }
  } catch(e) {
    document.getElementById('status').textContent = '⚠️ Connection error';
  }
}
async function forceNew() {
  const btn = document.querySelector('button');
  btn.textContent = '⏳ Generating…'; btn.disabled = true;
  const csrf = await fetch('/csrf-token').then(r=>r.json()).then(d=>d.csrfToken).catch(()=>null);
  await fetch('/whatsapp/reset', { method:'POST', headers: csrf ? {'X-CSRF-Token': csrf} : {} }).catch(()=>{});
  setTimeout(() => { btn.textContent = '↻ Generate New QR'; btn.disabled = false; poll(); }, 2000);
}
poll();
setInterval(poll, 2000);
<\/script>
</body>
</html>`);
});

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
  res.redirect('/');
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


// ── WhatsApp /bot admin command handler ─────────────────────────────────────
async function handleBotCommand(text, groupJid, senderJid, replyJid) {
  const parts = text.replace(/^@bot\s*/i, '').split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  // status & help → anyone can use
  const publicCmds = ['status', 'help', '', undefined];
  if (!publicCmds.includes(cmd)) {
    // config-change commands → group admins only
    let isAdmin = false;
    try {
      const fullSenderJid = senderJid.includes('@') ? senderJid : `${senderJid}@s.whatsapp.net`;
      isAdmin = await whatsapp.isGroupAdmin(groupJid, fullSenderJid);
    } catch(e) {}
    // Non-admin attempting a config command → return null so the caller
    // falls through to normal AI handling instead of refusing the user.
    if (!isAdmin) return null;
  }
  // parts[0]=cmd, parts[1]=arg1, parts[2]=arg2 (previous indexing was off by one)
  const arg1 = parts[1]?.toLowerCase();
  const arg2 = parts[2]?.toLowerCase();

  const ACTION_LABELS = {
    reply: '💬 reply',
    inquiry_search: '🔍 inquiry search',
    sheet_write: '📊 sheet write',
    reminder: '⏰ reminders',
    automation: '⚙️ automation'
  };

  const cfg = whatsapp.loadConfig();
  const group = (cfg.groups || []).find(g => g.jid === groupJid);
  if (!group) return '❌ This group is not in the bot allowlist yet.';

  if (cmd === 'on') {
    whatsapp.updateGroupConfig(groupJid, { active: true });
    return `✅ Bot *ON* in this group.\nMode: ${group.mode || 'always'}`;
  }
  if (cmd === 'off') {
    whatsapp.updateGroupConfig(groupJid, { active: false });
    return '🔕 Bot *OFF* — I will stay silent in this group.';
  }
  if (cmd === 'mode' && arg1) {
    const modeMap = { always: 'always', all: 'always', mention: 'mention_only', mention_only: 'mention_only', silent: 'silent' };
    const newMode = modeMap[arg1];
    if (!newMode) return '❌ Valid modes: `always` · `mention` · `silent`';
    whatsapp.updateGroupConfig(groupJid, {
      mode: newMode,
      respondToAll: newMode === 'always',
      requireMention: newMode === 'mention_only'
    });
    return `✅ Mode set to *${newMode}*`;
  }
  if (cmd === 'allow' && arg1) {
    const current = group.allowed_actions || ['reply'];
    if (!current.includes(arg1)) current.push(arg1);
    whatsapp.updateGroupConfig(groupJid, { allowed_actions: current });
    return `✅ *${ACTION_LABELS[arg1] || arg1}* action enabled`;
  }
  if (cmd === 'deny' && arg1) {
    const current = (group.allowed_actions || ['reply']).filter(a => a !== arg1);
    whatsapp.updateGroupConfig(groupJid, { allowed_actions: current });
    return `🚫 *${ACTION_LABELS[arg1] || arg1}* action disabled`;
  }
  if (cmd === 'status' || cmd === '' || !cmd) {
    const mode = group.mode || (group.respondToAll ? 'always' : 'mention_only');
    const active = group.active !== false;
    const actions = (group.allowed_actions || ['reply']).map(a => ACTION_LABELS[a] || a).join(', ');
    return `*TVMbot Group Status*\n` +
      `Status: ${active ? '🟢 Active' : '🔴 Off'}\n` +
      `Mode: ${mode}\n` +
      `Allowed: ${actions}\n\n` +
      `_Commands: @bot on · @bot off · @bot mode [always|mention|silent]_\n` +
      `_@bot allow [reply|inquiry_search|sheet_write|reminder|automation]_\n` +
      `_@bot deny [action] · @bot status_`;
  }
  return `*TVMbot commands:*\n@bot on · @bot off\n@bot mode [always|mention|silent]\n@bot allow [action] · @bot deny [action]\n@bot status`;
}

// ── Group action filter: returns null if ok, string error if blocked ──────────
function checkGroupAction(action, groupJid) {
  if (!groupJid) return null; // DMs always allowed
  const cfg = whatsapp.loadConfig();
  const group = (cfg.groups || []).find(g => g.jid === groupJid);
  if (!group) return null;
  const allowed = group.allowed_actions;
  if (!allowed) return null; // no filter set
  if (!allowed.includes(action)) {
    return `🚫 This action (${action}) is not enabled for this group.`;
  }
  return null;
}

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
        // Set current chat JID for document sending
        global.__tvmbot_current_jid = replyJid;

        // ── @bot command handler (admin config commands only) ─────────────
        // IMPORTANT: only intercept known config commands, NOT general @bot questions
        // Regular @bot questions (e.g. "@bot what is the check-in time?") go to AI
        if (isGroup && /^@bot\b/i.test(text.trim())) {
          // Match ONLY well-formed config commands (avoids false positives on
          // natural language like "@bot allow me to check in early").
          const BOT_CMD_RE = /^@bot\s+(status|help|on|off|(?:mode|allow|deny)\s+\S+)\s*$/i;
          if (BOT_CMD_RE.test(text.trim())) {
            const botReply = await handleBotCommand(text.trim(), groupJid, senderPhone, replyJid);
            if (botReply) return botReply;
            // handleBotCommand returned null → non-admin attempt, fall through to AI
          }
          // Not a config command — falls through to normal AI handling below
        }

        // ── Group action context: set global + inject restriction hint ────
        let groupActionCtx = '';
        if (isGroup && groupJid) {
          const grpCfg = whatsapp.getGroupConfig ? whatsapp.getGroupConfig(groupJid) : null;
          global.__tvmbot_current_group_cfg = grpCfg;
          if (grpCfg && grpCfg.allowed_actions) {
            const ALL_ACTIONS = ['inquiry_search','sheet_write','reminder','automation'];
            const blocked = ALL_ACTIONS.filter(a => !grpCfg.allowed_actions.includes(a));
            if (blocked.length > 0) {
              groupActionCtx = `[GROUP RESTRICTIONS: These actions are NOT allowed here: ${blocked.join(', ')}. Do NOT use tools for these actions.] `;
            }
          }
        } else {
          global.__tvmbot_current_group_cfg = null;
        }
        const fullText = `${datetimeCtx} ${contextTag} ${quotedCtx}${groupActionCtx}${text}`;

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
        if (reply) reply = cleanReply(reply);
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
        if (reply) reply = cleanReply(reply);
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

      // Start monitoring — only if autonomous mode allowed
      if (NO_AUTONOMOUS_MODE) {
        console.log('[Monitor] NOT started (NO_AUTONOMOUS_MODE = true)');
      } else {
        proactiveMonitor.start();
      }
      // Start Ruflo background daemon workers — only if autonomous mode allowed
      if (NO_AUTONOMOUS_MODE) {
        console.log('[Daemon] NOT started (NO_AUTONOMOUS_MODE = true)');
      } else if (ruflo && ruflo.backgroundDaemon) {
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
    require('./integrations/email-watcher').setEventBus(eventBus);
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
let tokenOptimizer;
try {
  tokenOptimizer = getTokenOptimizer();
  console.log('[TokenOptimizer] Loaded: context compression + agent booster + batch optimizer');
} catch(e) {
  console.warn('[TokenOptimizer] Failed to load:', e.message);
}

if (ruflo) {
  setInterval(() => {
    try {
      const mResult = ruflo.runMaintenance();
      console.log('[Ruflo] Maintenance complete:', JSON.stringify(mResult).substring(0, 200));
    } catch(e) { console.warn('[Ruflo] Maintenance error:', e.message); }
  }, 6 * 60 * 60 * 1000); // Every 6 hours

  console.log('[Ruflo] Scheduled 6-hourly maintenance');
}


// ─── Process Error Handlers (crash safety) ──────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  // Let PM2 restart gracefully
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[WARN] Unhandled Promise Rejection:', reason?.message || reason);
  // Don't crash — log and continue
});

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received — shutting down');
  process.exit(0);
});

// GET /memory/payments — payment notifications

// ─── Notion Todo API Routes ────────────────────────────────────────────────────
app.get('/api/todo/tasks', async (req, res) => {
  try {
    const notionTodo = require('./integrations/notion-todo');
    if (!notionTodo.isConfigured()) {
      // Fallback: SQLite maintenance_tasks
      try {
        const allTasks = memory.getMaintenanceTasks ? memory.getMaintenanceTasks({ limit: 200 }) : [];
        const sf = (req.query.status || '').toLowerCase();
        const filtered = sf
          ? allTasks.filter(t => (t.status || 'open').toLowerCase().includes(sf) || sf.includes((t.status||'').toLowerCase()))
          : allTasks;
        return res.json({
          tasks: filtered.map(t => ({
            id: t.id, task_name: t.title || 'Untitled', status: t.status || 'Open',
            priority: t.priority || 'Medium', assignee: t.pic || 'Unassigned',
            due_date: t.due_date || null, description: t.notes || '', source: 'sqlite'
          })),
          total: filtered.length, configured: false, source: 'sqlite'
        });
      } catch(sqlErr) {
        return res.json({ error: 'Notion not configured', tasks: [], configured: false });
      }
    }
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.priority) filters.priority = req.query.priority;
    if (req.query.assignee) filters.assignee = req.query.assignee;
    const data = await notionTodo.getTasks(filters);
    data.configured = true;
    res.json(data);
  } catch (e) {
    res.json({ error: e.message, tasks: [], configured: false });
  }
});

app.get('/api/todo/summary', async (req, res) => {
  try {
    const notionTodo = require('./integrations/notion-todo');
    if (!notionTodo.isConfigured()) {
      return res.json({ configured: false, total: 0, by_status: {} });
    }
    const data = await notionTodo.getTaskSummary();
    res.json(data);
  } catch (e) {
    res.json({ error: e.message, configured: false });
  }
});

app.post('/api/todo/tasks', async (req, res) => {
  try {
    const notionTodo = require('./integrations/notion-todo');
    if (!notionTodo.isConfigured()) {
      return res.json({ error: 'Notion not configured' });
    }
    const result = await notionTodo.createTask(req.body);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.put('/api/todo/tasks/:id', async (req, res) => {
  try {
    const notionTodo = require('./integrations/notion-todo');
    if (!notionTodo.isConfigured()) {
      return res.json({ error: 'Notion not configured' });
    }
    const result = await notionTodo.updateTask(req.params.id, req.body);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.delete('/api/todo/tasks/:id', async (req, res) => {
  try {
    const notionTodo = require('./integrations/notion-todo');
    if (!notionTodo.isConfigured()) {
      return res.json({ error: 'Notion not configured' });
    }
    const result = await notionTodo.deleteTask(req.params.id);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/memory/payments', (req, res) => {
  try {
    const rentals = memory.getActiveRentals ? memory.getActiveRentals() : [];
    const upcoming = rentals.filter(r => {
      if (!r.next_payment) return false;
      const due = new Date(r.next_payment);
      const diff = (due - new Date()) / (1000 * 60 * 60 * 24);
      return diff >= -30 && diff <= 30; // Due within 30 days past or future
    });
    res.json({ upcoming, total: rentals.length });
  } catch(e) {
    res.json({ upcoming: [], total: 0 });
  }
});


// ── Finance Endpoints (Phase 3) ───────────────────────────────────────────────

// POST /api/finance/log-expense — direct DB insert, no AI
app.post('/api/finance/log-expense', async (req, res) => {
  try {
    const { villa, amount, category, description, date } = req.body;
    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'amount is required and must be a number' });
    }
    const expDate = date || new Date().toISOString().slice(0, 10);
    const expDesc = description || 'Expense';
    const expCategory = category || 'general';
    const expAmount = parseFloat(amount);

    // 1. SQLite memory
    const id = memory.logTransaction({
      type: 'expense', villa_name: villa || '', amount: expAmount,
      currency: 'IDR', category: expCategory, description: expDesc,
      date: expDate, status: 'paid'
    });

    // 2. Google Sheets (Staff Sheet — Variable Expenses tab)
    let sheetsOk = false;
    try {
      const finance = require('./integrations/finance');
      if (finance && finance.logVariableExpense) {
        const sr = await finance.logVariableExpense({
          date: expDate, property: villa || '', category: expCategory,
          description: expDesc, amount: expAmount, notes: 'via UI'
        });
        sheetsOk = sr && sr.success;
        console.log('[API] Expense → Sheets:', sr?.message || 'unknown');
      }
    } catch (shErr) {
      console.error('[API] Expense → Sheets FAILED:', shErr.message);
    }

    res.json({ success: true, id, sheetsWritten: sheetsOk, message: 'Expense logged' + (sheetsOk ? ' + Sheets updated' : ' (Sheets write failed)') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/finance/monthly-summary — direct DB read, no AI
app.get('/api/finance/monthly-summary', (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
    const allTxns = memory.getTransactions ? memory.getTransactions({}) : [];
    const txns = allTxns.filter(t => t.date && t.date.startsWith(month));

    const income = txns.filter(t => t.type === 'income');
    const expenses = txns.filter(t => t.type === 'expense');

    const totalIncome = income.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const totalExpenses = expenses.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

    // Group income by villa
    const byVilla = {};
    income.forEach(t => {
      const v = t.villa_name || 'Unknown';
      byVilla[v] = (byVilla[v] || 0) + (parseFloat(t.amount) || 0);
    });

    // Group expenses by category
    const byCategory = {};
    expenses.forEach(t => {
      const c = t.category || 'general';
      byCategory[c] = (byCategory[c] || 0) + (parseFloat(t.amount) || 0);
    });

    // Outstanding payments from long_term_rentals
    let outstanding = 0;
    try {
      const overdue = memory.getOutstandingPayments ? memory.getOutstandingPayments() : [];
      outstanding = overdue.reduce((s, r) => s + (parseFloat(r.monthly_rent) || 0), 0);
    } catch(e) {}

    res.json({
      month,
      totalIncome,
      totalExpenses,
      netProfit: totalIncome - totalExpenses,
      incomeByVilla: byVilla,
      expensesByCategory: byCategory,
      transactionCount: txns.length,
      outstanding,
      currency: 'IDR'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/finance/transactions — list recent transactions
app.get('/api/finance/transactions', (req, res) => {
  try {
    const { type, villa, limit = 50 } = req.query;
    let txns = memory.getTransactions ? memory.getTransactions({ type, villa }) : [];
    txns = txns.slice(0, parseInt(limit));
    res.json({ transactions: txns, count: txns.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/metrics/overview — Phase 6 ROI metrics dashboard
app.get('/api/metrics/overview', (req, res) => {
  try {
    const now = new Date();
    const thisMonth = now.toISOString().slice(0, 7);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = lastMonthDate.toISOString().slice(0, 7);

    const allTxns = memory.getTransactions ? memory.getTransactions({}) : [];
    const bookings = memory.getBookings ? memory.getBookings({}) : [];
    const villas = memory.getAllVillas ? memory.getAllVillas() : [];

    // This month transactions
    const thisMonthTxns = allTxns.filter(t => t.date && t.date.startsWith(thisMonth));
    const lastMonthTxns = allTxns.filter(t => t.date && t.date.startsWith(lastMonth));

    const calcRevenue = (txns) => txns.filter(t => t.type === 'income')
      .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

    const thisRevenue = calcRevenue(thisMonthTxns);
    const lastRevenue = calcRevenue(lastMonthTxns);
    const revenueDelta = lastRevenue > 0 ? ((thisRevenue - lastRevenue) / lastRevenue * 100).toFixed(1) : null;

    // Upcoming bookings next 30 days
    const in30 = new Date(now.getTime() + 30 * 86400000);
    const upcomingBookings = bookings.filter(b => {
      const ci = new Date(b.check_in || b.checkin || b.start_date || '');
      return ci >= now && ci <= in30;
    });

    // Occupancy estimate: bookings this month / (villas * 30)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const activeBookings = bookings.filter(b => {
      const ci = new Date(b.check_in || '');
      const co = new Date(b.check_out || '');
      return co >= thisMonthStart && ci <= thisMonthEnd;
    });
    const villaCount = villas.filter(v => !v.name.startsWith('_')).length;
    const occupancyRate = villaCount > 0
      ? Math.min(100, (activeBookings.length / villaCount * 100 / 30)).toFixed(0)
      : 0;

    // Outstanding / overdue
    let overdueCount = 0;
    let overdueAmount = 0;
    try {
      const overdue = memory.getOutstandingPayments ? memory.getOutstandingPayments() : [];
      overdueCount = overdue.length;
      overdueAmount = overdue.reduce((s, r) => s + (parseFloat(r.monthly_rent) || 0), 0);
    } catch(e) {}

    res.json({
      revenue: {
        thisMonth: thisRevenue,
        lastMonth: lastRevenue,
        delta: revenueDelta,
        currency: 'IDR'
      },
      bookings: {
        upcoming30Days: upcomingBookings.length,
        thisMonth: activeBookings.length
      },
      occupancy: {
        rate: parseFloat(occupancyRate),
        activeVillas: villaCount
      },
      overdue: {
        count: overdueCount,
        amount: overdueAmount,
        currency: 'IDR'
      },
      generatedAt: now.toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Phase 7: Morning Briefing ─────────────────────────────────────────────
// Cached for 30 min, generated at first request each morning
let _briefingCache = null;
let _briefingCacheTime = 0;

app.get('/api/briefing', async (req, res) => {
  try {
    const now = Date.now();
    const cacheAge = now - _briefingCacheTime;
    const today = new Date().toISOString().slice(0, 10);

    // Return cached if less than 30 min old and same day
    if (_briefingCache && cacheAge < 30 * 60 * 1000 && _briefingCache.date === today) {
      return res.json(_briefingCache);
    }

    // Build briefing data from DB (no AI call — pure data)
    const bookings = memory.getBookings ? memory.getBookings({}) : [];
    const now2 = new Date();
    const tomorrow = new Date(now2.getTime() + 86400000);
    const nextWeek = new Date(now2.getTime() + 7 * 86400000);

    const todayCheckins = bookings.filter(b => {
      const ci = new Date(b.check_in || '');
      return ci.toDateString() === now2.toDateString();
    });
    const tomorrowCheckins = bookings.filter(b => {
      const ci = new Date(b.check_in || '');
      return ci.toDateString() === tomorrow.toDateString();
    });
    const weekCheckins = bookings.filter(b => {
      const ci = new Date(b.check_in || '');
      return ci >= now2 && ci <= nextWeek;
    });

    // Outstanding payments
    let overdue = [];
    try {
      overdue = memory.getOutstandingPayments ? memory.getOutstandingPayments() : [];
    } catch(e) {}

    // Open tasks
    let openTasks = 0;
    try {
      const tasks = memory.getMaintenanceTasks ? memory.getMaintenanceTasks({ limit: 100 }) : [];
      openTasks = tasks.filter(t => t.status !== 'completed' && t.status !== 'done').length;
    } catch(e) {}

    // Build briefing lines
    const lines = [];
    const dateStr = now2.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });
    lines.push(`📅 Today is ${dateStr}`);

    if (todayCheckins.length > 0) {
      lines.push(`🏠 ${todayCheckins.length} guest(s) checking in today: ${todayCheckins.map(b=>b.villa_name||'—').join(', ')}`);
    } else {
      lines.push('🏠 No check-ins today');
    }

    if (tomorrowCheckins.length > 0) {
      lines.push(`📦 ${tomorrowCheckins.length} check-in(s) tomorrow — prep needed`);
    }

    if (weekCheckins.length > 0) {
      lines.push(`📆 ${weekCheckins.length} check-in(s) this week`);
    }

    if (overdue.length > 0) {
      lines.push(`⚠️ ${overdue.length} overdue rental payment(s) — follow up needed`);
    }

    if (openTasks > 0) {
      lines.push(`🔧 ${openTasks} open maintenance task(s)`);
    }

    if (lines.length <= 2) {
      lines.push('✅ All clear — no urgent items today');
    }

    const briefing = {
      date: today,
      lines,
      summary: lines.join(' · '),
      generatedAt: now2.toISOString()
    };

    _briefingCache = briefing;
    _briefingCacheTime = now;

    res.json(briefing);
  } catch(e) {
    res.json({ date: new Date().toISOString().slice(0,10), lines: ['Good morning — briefing unavailable today.'], summary: '' });
  }
});


// ── System Health Check Endpoint ─────────────────────────────────────────────
// Returns real-time health status for ALL integrations + subsystems
app.get('/api/health', async (req, res) => {
  const health = {
    timestamp: new Date().toISOString(),
    system: { status: 'ok', uptime: process.uptime(), memory: process.memoryUsage().heapUsed },
    integrations: {},
    agents: {},
    queues: {}
  };

  // WhatsApp
  try {
    const waStatus = whatsapp ? whatsapp.getStatus() : { state: 'unavailable', connected: false };
    health.integrations.whatsapp = {
      status: waStatus.connected ? 'ok' : (waStatus.state === 'qr_ready' ? 'needs_scan' : 'down'),
      state: waStatus.state,
      connected: waStatus.connected,
      message: waStatus.connected ? 'Connected' : (waStatus.state === 'qr_ready' ? 'Scan QR to activate' : 'Not connected')
    };
  } catch(e) { health.integrations.whatsapp = { status: 'error', message: e.message }; }

  // Gmail
  try {
    const cfg = require('./config/integrations.json');
    const gmailOk = cfg.gmail && cfg.gmail.enabled && !!cfg.gmail.refresh_token;
    health.integrations.gmail = { status: gmailOk ? 'ok' : 'not_configured', enabled: !!(cfg.gmail && cfg.gmail.enabled) };
  } catch(e) { health.integrations.gmail = { status: 'error', message: e.message }; }

  // Google Calendar
  try {
    const cfg = require('./config/integrations.json');
    const calOk = cfg.google_calendar && cfg.google_calendar.enabled && !!cfg.google_calendar.refresh_token;
    health.integrations.calendar = { status: calOk ? 'ok' : 'not_configured', enabled: !!(cfg.google_calendar && cfg.google_calendar.enabled) };
  } catch(e) { health.integrations.calendar = { status: 'error', message: e.message }; }

  // Google Sheets
  try {
    const cfg = require('./config/integrations.json');
    const sheetsOk = cfg.sheets && cfg.sheets.enabled && !!cfg.sheets.refresh_token;
    health.integrations.sheets = { status: sheetsOk ? 'ok' : 'not_configured', enabled: !!(cfg.sheets && cfg.sheets.enabled) };
  } catch(e) { health.integrations.sheets = { status: 'error', message: e.message }; }

  // Notion
  try {
    const notionTodo = require('./integrations/notion-todo');
    const notionOk = notionTodo.isConfigured();
    health.integrations.notion = { status: notionOk ? 'ok' : 'not_configured', configured: notionOk };
  } catch(e) { health.integrations.notion = { status: 'error', message: e.message }; }

  // Email Watcher
  try {
    if (emailWatcher) {
      const stats = emailWatcher.getStats ? emailWatcher.getStats() : {};
      health.integrations.email_watcher = {
        status: 'ok',
        processed: stats.total_processed || 0,
        last_poll: stats.last_poll || null,
        watch_active: stats.watch_active || false
      };
    } else {
      health.integrations.email_watcher = { status: 'not_loaded' };
    }
  } catch(e) { health.integrations.email_watcher = { status: 'error', message: e.message }; }

  // Brave Search / Web Search
  try {
    const search = require('./integrations/search');
    health.integrations.search = { status: 'ok', provider: process.env.BRAVE_API_KEY ? 'brave' : 'duckduckgo' };
  } catch(e) { health.integrations.search = { status: 'error', message: e.message }; }

  // Memory DB
  try {
    const bookings = memory.getBookings({});
    health.agents.memory_db = { status: 'ok', bookings: bookings.length };
  } catch(e) { health.agents.memory_db = { status: 'error', message: e.message }; }

  // Ruflo Intelligence Layer
  try {
    if (ruflo) {
      const stats = ruflo.getStats ? ruflo.getStats() : {};
      health.agents.ruflo = { status: 'ok', modules: stats.modules || [], routes: stats.total_routes || 0 };
    } else {
      health.agents.ruflo = { status: 'not_loaded' };
    }
  } catch(e) { health.agents.ruflo = { status: 'error', message: e.message }; }

  // Proactive Monitor
  try {
    if (proactiveMonitor) {
      health.agents.proactive_monitor = {
        status: 'ok',
        running: proactiveMonitor.isRunning || false,
        last_scan: proactiveMonitor.lastScanTime || null
      };
    } else {
      health.agents.proactive_monitor = { status: 'not_loaded' };
    }
  } catch(e) { health.agents.proactive_monitor = { status: 'error', message: e.message }; }

  // Alert Queue (from proactive monitor)
  try {
    const alertsDb = require('./data/memory.db') || null;
    health.queues.alerts = { status: 'ok' };
  } catch(e) { health.queues.alerts = { status: 'ok' }; }

  // Overall status
  const criticalDown = Object.values(health.integrations).filter(i => i.status === 'down' || i.status === 'error').length;
  health.overall = criticalDown > 2 ? 'degraded' : 'ok';

  res.json(health);
});

// ── GET /api/health/alerts — Pending proactive monitor alerts (dashboard fallback) ──
app.get('/api/health/alerts', (req, res) => {
  try {
    const db = memory.db;
    // Check if alerts table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_alerts'").get();
    if (!tableExists) {
      // Create it
      db.exec(`CREATE TABLE IF NOT EXISTS monitor_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT NOT NULL DEFAULT 'WARNING',
        title TEXT NOT NULL,
        details TEXT,
        suggested_action TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        acknowledged INTEGER DEFAULT 0,
        sent_via_wa INTEGER DEFAULT 0
      )`);
    }
    const alerts = db.prepare("SELECT * FROM monitor_alerts WHERE acknowledged=0 ORDER BY created_at DESC LIMIT 20").all();
    res.json({ alerts, count: alerts.length });
  } catch(e) {
    res.json({ alerts: [], count: 0 });
  }
});

// ── POST /api/health/alerts/:id/ack — Acknowledge an alert ──────────────────
app.post('/api/health/alerts/:id/ack', (req, res) => {
  try {
    const db = memory.db;
    db.prepare("UPDATE monitor_alerts SET acknowledged=1 WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch(e) {
    res.json({ error: e.message });
  }
});


// ── Finance Sync: Reconcile Google Sheets → SQLite ──────────────────────────
// Reads from Google Sheets finance ledger and inserts any missing rows into SQLite
// Run: POST /api/finance/sync  (manual trigger)
// Auto: runs on server start + nightly cron
let _lastFinanceSync = null;
let _financeSyncRunning = false;

async function runFinanceSync() {
  if (_financeSyncRunning) return { skipped: true, reason: 'already running' };
  _financeSyncRunning = true;
  const results = { inserted: 0, skipped: 0, errors: 0, details: [] };
  try {
    const financeInt = require('./integrations/finance');
    if (!financeInt || !financeInt.getRecentTransactions) {
      _financeSyncRunning = false;
      return { skipped: true, reason: 'finance integration not available' };
    }
    // Pull recent rows from Sheets (last 90 days)
    const sheetsRows = await financeInt.getRecentTransactions(90).catch(() => []);
    for (const row of sheetsRows) {
      try {
        // Check if this row already exists in SQLite by date + amount + category
        const existing = memory.getTransactions ? memory.getTransactions({
          date: row.date, amount: row.amount
        }) : [];
        const isDuplicate = existing.some(t =>
          t.date === row.date &&
          Math.abs(parseFloat(t.amount) - parseFloat(row.amount)) < 1 &&
          (t.category || '').toLowerCase() === (row.category || '').toLowerCase()
        );
        if (!isDuplicate) {
          memory.logTransaction({
            type: row.type || 'income',
            category: row.category || 'uncategorised',
            description: row.description || row.notes || '',
            amount: parseFloat(row.amount || 0),
            currency: row.currency || 'IDR',
            villa_name: row.villa_name || row.property || '',
            guest_name: row.guest_name || '',
            date: row.date || new Date().toISOString().slice(0, 10),
            status: row.status || 'paid',
            reference: row.reference || row.booking_ref || ''
          });
          results.inserted++;
          results.details.push({ action: 'inserted', date: row.date, amount: row.amount, category: row.category });
        } else {
          results.skipped++;
        }
      } catch (rowErr) {
        results.errors++;
        results.details.push({ action: 'error', error: rowErr.message });
      }
    }
    _lastFinanceSync = new Date().toISOString();
    console.log(`[FinanceSync] Complete: inserted=${results.inserted} skipped=${results.skipped} errors=${results.errors}`);
  } catch (err) {
    console.error('[FinanceSync] Error:', err.message);
    results.error = err.message;
  } finally {
    _financeSyncRunning = false;
  }
  return results;
}

// Manual trigger endpoint
app.post('/api/finance/sync', requireAuth, async (req, res) => {
  try {
    const result = await runFinanceSync();
    res.json({ success: true, ...result, lastSync: _lastFinanceSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get sync status
app.get('/api/finance/sync/status', requireAuth, (req, res) => {
  res.json({
    lastSync: _lastFinanceSync,
    running: _financeSyncRunning,
    message: _lastFinanceSync
      ? `Last synced: ${_lastFinanceSync}`
      : 'Never synced — POST /api/finance/sync to run'
  });
});

// Auto-run on startup (non-blocking, 10s delay)
setTimeout(() => {
  runFinanceSync().catch(e => console.log('[FinanceSync] Startup sync skipped:', e.message));
}, 10000);

// Nightly sync at 03:00 server time
setInterval(() => {
  const h = new Date().getHours();
  if (h === 3) {
    runFinanceSync().catch(e => console.log('[FinanceSync] Nightly sync error:', e.message));
  }
}, 60 * 60 * 1000); // Check every hour



// ── Wire Integrations into Domain Agents ──────────────────────────────────────
// Called after all modules are loaded so integrations are available
function wireAgents() {
  try {
    const wiring = {};
    if (typeof whatsapp !== 'undefined' && whatsapp) wiring.whatsapp = whatsapp;
    if (typeof gmail    !== 'undefined' && gmail)    wiring.gmail    = gmail;
    if (typeof calendar !== 'undefined' && calendar) wiring.calendar = calendar;
    if (typeof sheets   !== 'undefined') {
      try { wiring.sheets = require('./integrations/sheets'); } catch(e) {}
    }
    bookingAgent.inject(wiring);
    maintenanceAgent.inject({ whatsapp: wiring.whatsapp });
    financeAgent.inject({ whatsapp: wiring.whatsapp, sheets: wiring.sheets });
    reportAgent.inject({ whatsapp: wiring.whatsapp, gmail: wiring.gmail });
    console.log('[Agents] Domain agents wired with integrations');
  } catch(e) {
    console.warn('[Agents] Wire failed (non-critical):', e.message);
  }
}
setTimeout(wireAgents, 3000); // 3s delay — let all integrations initialize first

// ── Agent Cron Schedules ───────────────────────────────────────────────────────
// Morning briefing at 07:00 server time
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 7 && now.getMinutes() < 5) {
    eventBus.emitMorningBriefing();
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Weekly summary on Sunday at 09:00
setInterval(() => {
  const now = new Date();
  if (now.getDay() === 0 && now.getHours() === 9 && now.getMinutes() < 5) {
    eventBus.emitWeeklySummary();
  }
}, 5 * 60 * 1000);

// ── /api/agents/status endpoint ───────────────────────────────────────────────
app.get('/api/agents/status', requireAuth, (req, res) => {
  res.json({
    eventBus: eventBus.getStats(),
    agents: {
      booking:     { name: bookingAgent.name,     wired: !!bookingAgent.whatsapp },
      maintenance: { name: maintenanceAgent.name, wired: !!maintenanceAgent.whatsapp },
      finance:     { name: financeAgent.name,     wired: !!financeAgent.whatsapp },
      report:      { name: reportAgent.name,      wired: !!reportAgent.whatsapp }
    }
  });
});

// ── Manual agent trigger endpoints ───────────────────────────────────────────
app.post('/api/agents/booking', requireAuth, async (req, res) => {
  const result = await bookingAgent.handle(req.body, { source: 'manual' });
  res.json(result);
});
app.post('/api/agents/maintenance', requireAuth, async (req, res) => {
  const result = await maintenanceAgent.handle(req.body, { source: 'manual' });
  res.json(result);
});
app.post('/api/agents/payment', requireAuth, async (req, res) => {
  const result = await financeAgent.handle(req.body, { source: 'manual' });
  res.json(result);
});
app.post('/api/agents/briefing', requireAuth, async (req, res) => {
  reportAgent._lastBriefing = null; // force resend
  const result = await reportAgent.morningBriefing();
  res.json(result);
});


module.exports = app;