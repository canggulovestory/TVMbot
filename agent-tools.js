/**
 * Narrow TVM operations bridge for the Hermes project skill.
 *
 * Usage:
 *   node agent-tools.js <action> <user> <<'TVM_JSON'
 *   {"name":"Review villa listing","priority":"High"}
 *   TVM_JSON
 *
 * Output is always JSON so the agent can verify success before confirming it.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const notion = require('./notion');
const assistant = require('./assistant');

const ALLOWED_USERS = new Set(['afni', 'syifa']);
const ALLOWED_PRIORITIES = new Set(['High', 'Mid', 'Low']);
const ALLOWED_RECURRENCES = /^(daily|weekly:[1-7]|monthly:([1-9]|[12]\d|3[01]))$/;

function requireText(value, name, max = 500) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text.slice(0, max);
}

function parseInput(raw) {
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Input must be a JSON object');
  }
  return value;
}

function parseWitaDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('datetime must be YYYY-MM-DD HH:MM in WITA');
  return assistant.witaToEpoch(+match[1], +match[2], +match[3], +match[4], +match[5]);
}

async function run(action, userKey, input) {
  switch (action) {
    case 'create_task': {
      const priority = ALLOWED_PRIORITIES.has(input.priority) ? input.priority : 'Mid';
      return notion.createTask({ name: requireText(input.name, 'name', 300), priority });
    }
    case 'complete_task':
      return notion.completeTask(requireText(input.search, 'search', 200));
    case 'list_tasks': {
      let tasks = await notion.getTasks();
      if (input.project) {
        const project = await notion.findProject(requireText(input.project, 'project', 120));
        tasks = project ? tasks.filter(task => task.projectIds.includes(project.id)) : [];
      }
      return tasks.slice(0, 50);
    }
    case 'mark_paid':
      return notion.markPaid(requireText(input.villa, 'villa', 160));
    case 'set_reminder': {
      const recurrence = String(input.recurrence || '');
      if (recurrence && !ALLOWED_RECURRENCES.test(recurrence)) {
        throw new Error('Invalid recurrence');
      }
      return assistant.addReminder({
        userKey,
        text: requireText(input.text, 'text'),
        at: parseWitaDateTime(input.datetime),
        recurrence,
      });
    }
    case 'list_reminders':
      return assistant.listReminders(userKey);
    case 'cancel_reminder':
      return assistant.cancelReminder(userKey, requireText(input.search, 'search', 200));
    case 'remember_fact':
      return assistant.remember(userKey, requireText(input.fact, 'fact', 400));
    case 'list_memory':
      return assistant.getMemory(userKey);
    case 'add_ops_schedule': {
      const frequency = requireText(input.frequency, 'frequency', 30);
      if (!ALLOWED_RECURRENCES.test(frequency)) throw new Error('Invalid frequency');
      return assistant.addOpsSchedule({
        villa: requireText(input.villa, 'villa', 120),
        task: requireText(input.task, 'task', 300),
        frequency,
        assignee: String(input.assignee || '').trim().slice(0, 120),
      });
    }
    case 'list_ops':
      return assistant.listOpsSchedules();
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

async function main() {
  const [action, userKey] = process.argv.slice(2);
  if (!action) throw new Error('Action is required');
  if (!ALLOWED_USERS.has(userKey)) throw new Error('Unknown TVM user');

  assistant.init(process.env.DATA_DIR || path.join(__dirname, 'data'));
  notion.init();
  const result = await run(action, userKey, parseInput(fs.readFileSync(0, 'utf8').trim()));
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
