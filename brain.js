/**
 * brain.js — Hermes Agent harness message handler
 * Authenticates a TVM user, preserves deterministic slash commands, and sends
 * general requests to the local Hermes API server.
 */
'use strict';

const notion = require('./notion');
const assistant = require('./assistant');
const hermes = require('./hermes-client');

function init() {
  hermes.init();
}

// ─── User identification ────────────────────────────────────────────────────────

const USERS = {
  afni: {
    phone: process.env.AFNI_PHONE || '6282122922252',
    telegramId: process.env.AFNI_TELEGRAM_ID || '',
    name: 'Afni',
    buckets: ['Villas / CHB', 'Furniture', 'AI', 'Dream Job'],
    schedule: {
      1: 'Villas / CHB', 2: 'Furniture', 3: 'Villas / CHB',
      4: 'AI', 5: 'Dream Job', 6: 'Content + Admin', 0: 'Rest + Planning',
    },
    includeRoutine: true,
  },
  syifa: {
    phone: process.env.SYIFA_PHONE || '6287750590799',
    telegramId: process.env.SYIFA_TELEGRAM_ID || '',
    name: 'Syifa',
    includeRoutine: false,
  },
};

function identifyUser({ phone, telegramId }) {
  for (const [key, u] of Object.entries(USERS)) {
    if (phone && u.phone === phone) return { ...u, key };
    if (telegramId && u.telegramId === String(telegramId)) return { ...u, key };
  }
  return null;
}

function isAllowed({ phone, telegramId }) {
  return !!identifyUser({ phone, telegramId });
}

// ─── System prompt ──────────────────────────────────────────────────────────────

function buildPrompt(user, memoryFacts = []) {
  const nowWita = assistant.epochToWitaString(Date.now());
  let prompt = `You are Zuzu, the AI operating assistant for The Villa Managers team.
You are talking to ${user.name}. Be brief — max 3-4 lines per response.
Complete safe internal task and reminder actions directly. For any client message,
financial change, payment/invoice status change, or deletion: prepare the action
and ask for explicit confirmation before doing it.
Current date/time: ${nowWita} WITA (Asia/Makassar).

You are running inside the Hermes Agent harness and can help with:
- Adding tasks: "todo: [task]" or "urgent: [task]"
- Completing tasks: "done: [task]"
- Listing tasks: "tasks" or "list"
- Payment tracking: "paid [villa]"
- Maintenance: "maintenance: [issue] at [location]"
- Reminders: "remind me [when] [what]" — use the set_reminder tool
- Memory: "remember [fact]" — use the remember_fact tool
- Agency CRM: owner submissions, renter leads, campaigns and next follow-up
- Agency finance: retainers, placement commissions and campaign costs
- Business intelligence: live lead pipeline, invoices due, receivables, income and expenses
- Private operations memory: villa details, contracts/expiry dates, guest stays, check-ins/check-outs,
  rent schedules, deposits/refunds, Drive document links, villa tasks and payables
- Reply drafting: prepare, but never send, a client WhatsApp/email draft
- Google Workspace: inspect Gmail, uploaded document intake and calendar. You may create an email draft or calendar hold only after explicit confirmation; never send email

For task, payment, lead, finance, reminder, memory, or operations requests, load and follow the
project skill named tvm-operations. For questions such as "briefing", "what needs
attention", "show leads", "lead [name]", "finance", "invoices due", "when does a contract expire?",
"when is a check-in?", "how much is a guest deposit?", "email inbox", "calendar", "marketing pipeline",
or "uploaded documents", use its
read-only business actions before answering. Never claim an action succeeded until its
tool returns a successful result. For a requested TVM record create/update, first show the
important fields as a draft and ask for an explicit confirmation in the same chat. Only after
the user confirms may you use the save_record action. Do not edit source code, deploy, or change
server configuration from this messaging conversation.
Confirm completed actions with one line.
Respond in the same language the user writes in (English or Indonesian).`;

  if (memoryFacts.length) {
    prompt += `\n\nKnown facts about ${user.name} (from memory):\n` +
      memoryFacts.slice(0, 12).map(e => `- ${e.fact}${e.category && e.category !== 'reference' ? ` [${e.category}]` : ''}`).join('\n');
  }

  if (user.key === 'afni') {
    prompt += `\n\nAfni's work buckets: ${user.buckets.join(', ')}.
Today's focus: ${user.schedule[new Date().getDay()]}.
She also tracks personal routine: workout, journaling, prayer.`;
  }

  if (user.key === 'syifa') {
    prompt += `\n\nSyifa manages multiple villa/furniture projects.
Organize her tasks by project name when listing.`;
  }

  return prompt;
}

// ─── Process message ────────────────────────────────────────────────────────────

async function processMessage({ text, phone, telegramId }) {
  const user = identifyUser({ phone, telegramId });
  if (!user) return null;
  return processForUser({ text, user });
}

/** Used by the protected Admin chat; it shares the same user-scoped Hermes conversation. */
async function processInternalMessage({ text, userKey }) {
  const user = USERS[userKey];
  if (!user) return null;
  return processForUser({ text, user: { ...user, key: userKey } });
}

async function processForUser({ text, user }) {
  const message = String(text || '').trim().slice(0, 2000);
  if (!message) return 'Write a message for Zuzu first.';

  // Structured commands remain deterministic and do not need a model provider.
  const commandReply = await assistant.tryCommand(message, user.key);
  if (commandReply) return commandReply;

  try {
    // Recall only memories relevant to this message. This keeps Zuzu useful
    // across long conversations without injecting every private fact at once.
    const memoryFacts = await assistant.searchMemory(user.key, message, 12).catch(() => []);
    const systemPrompt = buildPrompt(user, memoryFacts);
    return await hermes.respond({
      input: message,
      instructions: systemPrompt,
      userKey: user.key,
    });
  } catch (err) {
    console.error(`[Hermes] ${err.code || 'ERROR'}:`, err.message);
    return 'Hermes is temporarily unavailable. Structured commands still work: /remind, /reminders, /remember, /memory, /ops (see /help).';
  }
}

// ─── Morning DM builder (no AI needed — pure data) ─────────────────────────────

const DAYS_INDO = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

async function buildMorningDM(userKey) {
  const user = USERS[userKey];
  if (!user) return null;

  const now = new Date();
  const dayName = DAYS_INDO[now.getDay()];
  const dateStr = now.toISOString().split('T')[0];

  const tasks = await notion.getTasks();
  const { dueSoon, overdue: overduePayments } = await notion.getPaymentsDueSoon(3);

  if (userKey === 'afni') {
    const focus = user.schedule[now.getDay()];
    let msg = `*${dayName}, ${dateStr}*\n`;
    msg += `Focus: *${focus}*\n\n`;

    if (tasks.length > 0) {
      const high = tasks.filter(t => t.priority === 'High');
      const mid = tasks.filter(t => t.priority === 'Mid');
      const rest = tasks.filter(t => !['High', 'Mid'].includes(t.priority));

      msg += `*Tasks (${tasks.length}):*\n`;
      [...high, ...mid, ...rest].slice(0, 10).forEach((t, i) => {
        const flag = t.dueDate && new Date(t.dueDate) < now ? ' !!!' : '';
        msg += `${i + 1}. ${t.name} [${t.priority}]${flag}\n`;
      });
      if (tasks.length > 10) msg += `_+${tasks.length - 10} more_\n`;
    } else {
      msg += 'No open tasks.\n';
    }

    if (overduePayments.length > 0) {
      msg += '\n*Payments OVERDUE:*\n';
      overduePayments.forEach(p => {
        const amt = p.amount ? ` Rp ${p.amount.toLocaleString('id-ID')}` : '';
        msg += `- ${p.villa}${amt} (day ${p.dueDay})\n`;
      });
    }
    if (dueSoon.length > 0) {
      msg += '\n*Payments due soon:*\n';
      dueSoon.forEach(p => {
        const amt = p.amount ? ` Rp ${p.amount.toLocaleString('id-ID')}` : '';
        const diff = p.dueDay - now.getDate();
        const label = diff === 0 ? 'TODAY' : `in ${diff}d`;
        msg += `- ${p.villa}${amt} (${label})\n`;
      });
    }

    const extras = await assistant.buildMorningExtras('afni').catch(() => '');
    if (extras) msg += `\n${extras}\n`;

    msg += '\nWorkout + journal + prayer';
    return msg;
  }

  if (userKey === 'syifa') {
    let msg = `*${dayName}, ${dateStr}*\n\n`;

    if (tasks.length > 0) {
      // Group by project
      const projects = await notion.getProjects();
      const projMap = {};
      projects.forEach(p => { projMap[p.id] = p.name; });

      const grouped = {};
      tasks.forEach(t => {
        const projId = t.projectIds[0];
        const projName = projId ? (projMap[projId] || 'Other') : 'No Project';
        if (!grouped[projName]) grouped[projName] = [];
        grouped[projName].push(t);
      });

      msg += `*Tasks (${tasks.length}):*\n\n`;
      for (const [proj, pTasks] of Object.entries(grouped)) {
        msg += `*${proj}:*\n`;
        pTasks.slice(0, 5).forEach((t, i) => {
          msg += `  ${i + 1}. ${t.name} [${t.priority}]\n`;
        });
        if (pTasks.length > 5) msg += `  _+${pTasks.length - 5} more_\n`;
        msg += '\n';
      }
    } else {
      msg += 'No open tasks.\n';
    }

    if (overduePayments.length > 0 || dueSoon.length > 0) {
      msg += '*Payments:*\n';
      overduePayments.forEach(p => {
        msg += `- OVERDUE: ${p.villa} Rp ${p.amount.toLocaleString('id-ID')}\n`;
      });
      dueSoon.forEach(p => {
        const diff = p.dueDay - now.getDate();
        msg += `- ${p.villa} Rp ${p.amount.toLocaleString('id-ID')} (${diff === 0 ? 'TODAY' : `in ${diff}d`})\n`;
      });
    }

    const extras = await assistant.buildMorningExtras('syifa').catch(() => '');
    if (extras) msg += `\n${extras}`;

    return msg;
  }

  return null;
}

module.exports = {
  init, processMessage, processInternalMessage, buildMorningDM,
  identifyUser, isAllowed, USERS,
};
