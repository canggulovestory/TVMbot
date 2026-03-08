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
const { createPlan, revisePlan, classifyIntent } = require('./planner');
const { validatePlan, validateResult, deepValidate, formatApprovalRequest, RISK } = require('./supervisor');
const { executeTool, SENSITIVE_TOOLS } = require('./executor');
const TOOLS = require('./tools');
const audit = require('./audit');

// ─── Integration Imports ───────────────────────────────────────────────────────
let gmail, calendar;
try { gmail    = require('./integrations/gmail');    } catch(e) {}
try { calendar = require('./integrations/calendar'); } catch(e) {}

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── Session & Auth ────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'tvmbot_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware — protects everything except /auth/* and /login.html
function requireAuth(req, res, next) {
  const open = ['/auth/login', '/auth/logout', '/login.html'];
  if (open.includes(req.path)) return next();
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api') || req.method === 'POST') {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  res.redirect('/login.html');
}
app.use(requireAuth);

// Login route
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.LOGIN_USER || 'admin';
  const validPass = process.env.LOGIN_PASSWORD || 'tvmbot2026';
  if (username === validUser && password === validPass) {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: 'Invalid username or password.' });
});

// Logout route
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Session Store (in-memory, upgrade to Redis for prod) ─────────────────────
const sessions = new Map();
const pendingApprovals = new Map(); // sessionId → { plan, resolve, reject }

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [], userEmail: 'unknown', createdAt: Date.now() });
  }
  return sessions.get(sessionId);
}

// ─── Build System Prompt ───────────────────────────────────────────────────────
function buildSystemPrompt(memoryCtx) {
  const ownerProfile = memory.getOwnerProfile();
  const ownerName = ownerProfile.name || ownerProfile.owner_name || 'the owner';
  const company = ownerProfile.company || 'The Villa Managers';

  return `You are TVMbot, the autonomous AI agent for ${company}, managed by ${ownerName}.

You are an expert villa management agent with full access to Gmail, Google Calendar, Drive, Docs, Sheets, and business intelligence tools. You execute tasks autonomously — reading emails, creating contracts, managing bookings, building reports, and coordinating operations.

PERSONALITY:
- Professional, warm, and highly capable
- Proactive: suggest improvements, flag upcoming tasks, notice patterns
- Concise in confirmations, thorough in reports
- Always confirm sensitive actions before executing

BUSINESS CONTEXT:
${memoryCtx || '(no prior context loaded)'}

EXECUTION RULES:
1. Use tools to get REAL data — never guess or make up emails, names, dates
2. For SENSITIVE actions (send email, create contract, write data): state what you will do, then do it
3. Chain tools when needed: first read, then write; first check availability, then book
4. After completing tasks, confirm what was done and provide links/references
5. Save important discoveries to memory using save_note
6. If a task is unclear, ask ONE clarifying question before proceeding

Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
}

// ─── Core PEMS Agent Loop ──────────────────────────────────────────────────────
async function runPEMSAgent(userMessage, sessionId, userEmail = 'unknown') {
  const session = getSession(sessionId);
  const startTime = Date.now();

  // ── P: Plan ─────────────────────────────────────────────────────────────────
  const memoryCtx = memory.buildContextSummary();
  const convSummary = session.history.slice(-4).map(m =>
    `${m.role === 'user' ? 'User' : 'TVMbot'}: ${typeof m.content === 'string' ? m.content.slice(0, 100) : '[tool call]'}`
  ).join('\n');

  const plan = await createPlan(userMessage, memoryCtx, convSummary);
  console.log(`[PEMS] Plan: ${plan.strategy} | ${plan.steps.length} steps`);

  // ── S: Supervisor pre-validation ─────────────────────────────────────────────
  const validation = validatePlan(plan, memoryCtx);
  console.log(`[PEMS] Validation: ${validation.approved ? 'APPROVED' : 'REJECTED'} [${validation.risk}]`);

  if (!validation.approved) {
    // Try to revise the plan
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

  // If plan asks for clarification
  if (plan.clarification_needed && plan.missing_info?.length > 0) {
    return {
      reply: `Before I proceed, I need a bit more info:\n${plan.missing_info.map(i => `• ${i}`).join('\n')}`,
      plan,
      validation,
      toolsUsed: [],
      elapsed: Date.now() - startTime
    };
  }

  // ── E: Execute (Claude Agentic Loop) ─────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(memoryCtx);
  const messages = [
    ...session.history,
    { role: 'user', content: userMessage }
  ];

  const toolsUsed = [];
  const toolResults = [];
  let finalReply = '';
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages: messages
    });

    console.log(`[PEMS] Claude iteration ${iterations}: stop_reason=${response.stop_reason}`);

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

        // Execute tool
        const result = await executeTool(block.name, block.input, userEmail);

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
          content: JSON.stringify(result)
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
    elapsed
  };
}

// ─── API Routes ────────────────────────────────────────────────────────────────

// Main chat endpoint
app.post('/chat', async (req, res) => {
  const { message, sessionId, userEmail } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

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

    const result = await runPEMSAgent(message, sid, email);

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
    res.status(500).json({ error: err.message, reply: 'Something went wrong. Please try again.' });
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
    if (profile.name) memory.setFact('owner', 'name', profile.name, 'onboarding');
    if (profile.company) memory.setFact('owner', 'company', profile.company, 'onboarding');
    if (profile.email) memory.setFact('owner', 'email', profile.email, 'onboarding');
    if (profile.currency) memory.setFact('business', 'currency', profile.currency, 'onboarding');

    res.json({ success: true, message: 'Profile saved to memory' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Memory API
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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Scheduled Tasks ───────────────────────────────────────────────────────────

// Daily morning briefing (9 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Running morning briefing...');
  try {
    if (!gmail || !calendar) return;
    const emails = await gmail.getEmails(5);
    const events = await calendar.getEvents(5);
    const upcoming = memory.getUpcomingBookings(3);

    memory.setFact('briefing', 'last_run', new Date().toISOString(), 'cron');
    console.log(`[Cron] Briefing: ${emails.length} emails, ${events.length} events, ${upcoming.length} upcoming bookings`);
  } catch (err) {
    console.error('[Cron] Briefing error:', err.message);
  }
});

// Hourly email check
cron.schedule('0 * * * *', async () => {
  if (!gmail) return;
  try {
    const flagged = await gmail.getFlaggedEmails();
    if (flagged.length > 0) {
      memory.setFact('email', 'flagged_count', flagged.length, 'cron');
    }
  } catch (err) {
    console.error('[Cron] Email check error:', err.message);
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
║  Model:   claude-sonnet-4-5-20250929                     ║
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
});

module.exports = app;
