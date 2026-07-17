/**
 * brain.js — Claude-powered message handler
 * Takes a message from any channel (WhatsApp/Telegram), processes it,
 * executes Notion actions, returns a response.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;
const notion = require('./notion');

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

function buildPrompt(user) {
  let prompt = `You are TVMbot, a task assistant for The Villa Managers team.
You are talking to ${user.name}. Be brief — max 3-4 lines per response.
Never ask permission. Just do it and confirm.

You can help with:
- Adding tasks: "todo: [task]" or "urgent: [task]"
- Completing tasks: "done: [task]"
- Listing tasks: "tasks" or "list"
- Payment tracking: "paid [villa]"
- Maintenance: "maintenance: [issue] at [location]"

Always save everything to Notion. Confirm with one line.
Respond in the same language the user writes in (English or Indonesian).`;

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
];

// ─── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
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

  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: buildPrompt(user),
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
          const result = await executeTool(block.name, block.input);
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
        system: buildPrompt(user),
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

    return msg;
  }

  return null;
}

module.exports = {
  init, processMessage, buildMorningDM,
  identifyUser, isAllowed, USERS,
};
