/**
 * brain.js — Claude-powered message handler
 * Takes a message from any channel (WhatsApp/Telegram), processes it,
 * executes Notion actions, returns a response.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;
const notion = require('./notion');
const assistant = require('./assistant');

let claude;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

function init() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
  let prompt = `You are TVMbot, a task assistant for The Villa Managers team.
You are talking to ${user.name}. Be brief — max 3-4 lines per response.
Never ask permission. Just do it and confirm.
Current date/time: ${nowWita} WITA (Asia/Makassar).

You can help with:
- Adding tasks: "todo: [task]" or "urgent: [task]"
- Completing tasks: "done: [task]"
- Listing tasks: "tasks" or "list"
- Payment tracking: "paid [villa]"
- Maintenance: "maintenance: [issue] at [location]"
- Reminders: "remind me [when] [what]" — use the set_reminder tool
- Memory: "remember [fact]" — use the remember_fact tool
- Villa ops: recurring cleaning/pool/maintenance schedules — use add_ops_schedule

Always save everything to Notion. Confirm with one line.
Respond in the same language the user writes in (English or Indonesian).`;

  if (memoryFacts.length) {
    prompt += `\n\nKnown facts about ${user.name} (from memory):\n` +
      memoryFacts.slice(0, 20).map(e => `- ${e.fact}`).join('\n');
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

// ─── Tool definitions for Claude ────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'create_task',
    description: 'Create a new task in Notion. Use for todo/urgent/maintenance commands.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name' },
        priority: { type: 'string', enum: ['High', 'Mid', 'Low'], description: 'Task priority' },
      },
      required: ['name'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done. Search by partial name match.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Text to search for in task names' },
      },
      required: ['search'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List open tasks from Notion.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional project name filter' },
      },
    },
  },
  {
    name: 'mark_paid',
    description: 'Mark a villa payment as paid.',
    input_schema: {
      type: 'object',
      properties: {
        villa: { type: 'string', description: 'Villa name (partial match)' },
      },
      required: ['villa'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder delivered by WhatsApp/Telegram at a specific WITA time. Supports one-off and recurring.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to remind about' },
        datetime: { type: 'string', description: 'WITA time as "YYYY-MM-DD HH:MM"' },
        recurrence: { type: 'string', enum: ['', 'daily', 'weekly:1', 'weekly:2', 'weekly:3', 'weekly:4', 'weekly:5', 'weekly:6', 'weekly:7', 'monthly:1', 'monthly:15', 'monthly:25'], description: 'Empty for one-off. weekly:N uses Mon=1..Sun=7. monthly:D = day of month.' },
      },
      required: ['text', 'datetime'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List pending reminders for this user.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder by partial text match.',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string' } },
      required: ['search'],
    },
  },
  {
    name: 'remember_fact',
    description: 'Store a lasting fact about this user (preferences, contacts, decisions, context).',
    input_schema: {
      type: 'object',
      properties: { fact: { type: 'string' } },
      required: ['fact'],
    },
  },
  {
    name: 'add_ops_schedule',
    description: 'Add a recurring villa operations schedule (cleaning, pool service, maintenance). Appears in the morning briefing on matching days.',
    input_schema: {
      type: 'object',
      properties: {
        villa: { type: 'string' },
        task: { type: 'string' },
        frequency: { type: 'string', description: 'daily | weekly:1..7 (Mon=1) | monthly:1..31' },
        assignee: { type: 'string', description: 'Optional staff name' },
      },
      required: ['villa', 'task', 'frequency'],
    },
  },
];

// ─── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(name, input, user) {
  switch (name) {
    case 'set_reminder': {
      const m = String(input.datetime || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
      if (!m) return 'Invalid datetime — need "YYYY-MM-DD HH:MM" (WITA)';
      const at = assistant.witaToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]);
      const r = await assistant.addReminder({ userKey: user.key, text: input.text, at, recurrence: input.recurrence || '' });
      return `Reminder set: "${r.text}" — ${assistant.epochToWitaString(r.at)} WITA${r.recurrence ? ` (${r.recurrence.replace(':', ' ')})` : ''}`;
    }
    case 'list_reminders': {
      const list = await assistant.listReminders(user.key);
      if (!list.length) return 'No reminders set.';
      return list.slice(0, 15).map((r, i) => `${i + 1}. ${assistant.epochToWitaString(r.at)} — ${r.text}`).join('\n');
    }
    case 'cancel_reminder': {
      const target = await assistant.cancelReminder(user.key, input.search);
      return target ? `Cancelled: "${target.text}"` : 'No matching reminder found.';
    }
    case 'remember_fact': {
      const entry = await assistant.remember(user.key, input.fact);
      return `Remembered: "${entry.fact}"`;
    }
    case 'add_ops_schedule': {
      const entry = await assistant.addOpsSchedule(input);
      return `Ops schedule added: ${entry.villa} — ${entry.task} (${entry.frequency.replace(':', ' ')})`;
    }
    case 'create_task': {
      const result = await notion.createTask({
        name: input.name,
        priority: input.priority || 'Mid',
      });
      return `Task created: "${result.name}" [${result.priority}]`;
    }
    case 'complete_task': {
      const result = await notion.completeTask(input.search);
      if (!result) return `No open task found matching "${input.search}"`;
      return `Completed: "${result.name}"`;
    }
    case 'list_tasks': {
      let tasks = await notion.getTasks();
      if (input.project) {
        const project = await notion.findProject(input.project);
        if (project) {
          tasks = tasks.filter(t => t.projectIds.includes(project.id));
        }
      }
      if (tasks.length === 0) return 'No open tasks.';

      const lines = tasks.slice(0, 15).map((t, i) =>
        `${i + 1}. ${t.name} [${t.priority}]${t.dueDate ? ' (due ' + t.dueDate + ')' : ''}`
      );
      let result = lines.join('\n');
      if (tasks.length > 15) result += `\n...+${tasks.length - 15} more`;
      return result;
    }
    case 'mark_paid': {
      const result = await notion.markPaid(input.villa);
      if (!result) return `No pending payment found for "${input.villa}"`;
      return `Paid: ${result.villa} (Rp ${result.amount.toLocaleString('id-ID')})`;
    }
    default:
      return 'Unknown tool';
  }
}

// ─── Process message ────────────────────────────────────────────────────────────

async function processMessage({ text, phone, telegramId }) {
  const user = identifyUser({ phone, telegramId });
  if (!user) return null;

  // Structured commands (/remind, /remember, /ops…) work with ZERO AI credits.
  const commandReply = await assistant.tryCommand(text, user.key);
  if (commandReply) return commandReply;

  try {
    const memoryFacts = await assistant.getMemory(user.key).catch(() => []);
    const systemPrompt = buildPrompt(user, memoryFacts);
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: systemPrompt,
      tools: TOOLS,
      messages: [{ role: 'user', content: text }],
    });

    // Handle tool use loop
    let messages = [{ role: 'user', content: text }];
    let assistantMsg = response;

    while (assistantMsg.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: assistantMsg.content });

      const toolResults = [];
      for (const block of assistantMsg.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input, user);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });

      assistantMsg = await claude.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });
    }

    // Extract text response
    const textBlocks = assistantMsg.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || 'Done.';

  } catch (err) {
    if (err.message?.includes('credit') || err.status === 400) {
      return 'API credits depleted. Top up at console.anthropic.com';
    }
    console.error('[Brain] Error:', err.message);
    return 'Something went wrong. Try again.';
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
  init, processMessage, buildMorningDM,
  identifyUser, isAllowed, USERS,
};
