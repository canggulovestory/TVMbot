/**
 * assistant.js — Reminders, memory, and villa ops schedules.
 * Works fully WITHOUT AI credits via structured commands (/remind, /remember, /ops).
 * AI tools in brain.js call the same functions when credits are available.
 * Storage: data/assistant.json (gitignored, private).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Makassar, UTC+8, no DST
let filePath;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { version: 1, reminders: [], memory: {}, opsSchedules: [] };
}

function init(dataDir) {
  filePath = path.join(dataDir, 'assistant.json');
}

async function read() {
  try {
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return { ...emptyStore(), ...stored };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
}

function mutate(work) {
  writeQueue = writeQueue.then(async () => {
    const store = await read();
    const result = await work(store);
    const temp = `${filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.rename(temp, filePath);
    return result;
  });
  return writeQueue;
}

// ─── WITA time helpers ──────────────────────────────────────────────────────────

function nowWita() {
  return new Date(Date.now() + WITA_OFFSET_MS); // read UTC getters as WITA wall time
}

function witaToEpoch(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h, mi) - WITA_OFFSET_MS;
}

function epochToWitaString(epoch) {
  const d = new Date(epoch + WITA_OFFSET_MS);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ─── Reminders ──────────────────────────────────────────────────────────────────
// recurrence: '' (one-off) | 'daily' | 'weekly:1..7 (Mon..Sun)' | 'monthly:1..31'

async function addReminder({ userKey, text, at, recurrence = '' }) {
  if (!userKey || !text || !Number.isFinite(at)) throw new Error('Reminder needs user, text, and time');
  return mutate(store => {
    const reminder = {
      id: `REM-${crypto.randomUUID()}`,
      userKey, text: String(text).slice(0, 500), at,
      recurrence: String(recurrence || ''),
      createdAt: Date.now(), sent: false,
    };
    store.reminders.unshift(reminder);
    store.reminders = store.reminders.slice(0, 500);
    return reminder;
  });
}

async function listReminders(userKey) {
  const store = await read();
  return store.reminders
    .filter(r => r.userKey === userKey && !r.sent)
    .sort((a, b) => a.at - b.at);
}

async function cancelReminder(userKey, search) {
  return mutate(store => {
    const target = store.reminders.find(r =>
      r.userKey === userKey && !r.sent &&
      r.text.toLowerCase().includes(String(search).toLowerCase()));
    if (!target) return null;
    store.reminders = store.reminders.filter(r => r.id !== target.id);
    return target;
  });
}

function nextOccurrence(reminder, fromEpoch) {
  const [kind, arg] = reminder.recurrence.split(':');
  const base = new Date(reminder.at + WITA_OFFSET_MS);
  const h = base.getUTCHours(), mi = base.getUTCMinutes();
  const from = new Date(fromEpoch + WITA_OFFSET_MS);
  let y = from.getUTCFullYear(), mo = from.getUTCMonth() + 1, d = from.getUTCDate();
  for (let i = 0; i < 62; i += 1) {
    const candidate = witaToEpoch(y, mo, d, h, mi);
    const cd = new Date(candidate + WITA_OFFSET_MS);
    const isoDow = ((cd.getUTCDay() + 6) % 7) + 1; // Mon=1..Sun=7
    const matches = kind === 'daily'
      || (kind === 'weekly' && isoDow === Number(arg))
      || (kind === 'monthly' && cd.getUTCDate() === Number(arg));
    if (candidate > fromEpoch && matches) return candidate;
    const next = new Date(Date.UTC(y, mo - 1, d) + 86400000);
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return null;
}

/** Due reminders; marks one-offs sent and advances recurring ones. */
async function collectDueReminders() {
  const now = Date.now();
  return mutate(store => {
    const due = [];
    for (const r of store.reminders) {
      if (r.sent || r.at > now) continue;
      due.push({ ...r });
      if (r.recurrence) {
        const next = nextOccurrence(r, now);
        if (next) r.at = next; else r.sent = true;
      } else {
        r.sent = true;
      }
    }
    return due;
  });
}

// ─── Memory ─────────────────────────────────────────────────────────────────────

async function remember(userKey, fact) {
  if (!fact) throw new Error('Nothing to remember');
  return mutate(store => {
    store.memory[userKey] = store.memory[userKey] || [];
    const entry = { fact: String(fact).slice(0, 400), at: new Date().toISOString() };
    store.memory[userKey].unshift(entry);
    store.memory[userKey] = store.memory[userKey].slice(0, 100);
    return entry;
  });
}

async function forget(userKey, search) {
  return mutate(store => {
    const list = store.memory[userKey] || [];
    const target = list.find(e => e.fact.toLowerCase().includes(String(search).toLowerCase()));
    if (!target) return null;
    store.memory[userKey] = list.filter(e => e !== target);
    return target;
  });
}

async function getMemory(userKey) {
  const store = await read();
  return store.memory[userKey] || [];
}

// ─── Villa ops schedules (cleaning, pool, maintenance…) ─────────────────────────
// frequency: 'daily' | 'weekly:1..7' | 'monthly:1..31'

async function addOpsSchedule({ villa, task, frequency, assignee = '' }) {
  if (!villa || !task || !frequency) throw new Error('Ops schedule needs villa, task, and frequency');
  return mutate(store => {
    const entry = {
      id: `OPS-${crypto.randomUUID()}`,
      villa: String(villa).slice(0, 120), task: String(task).slice(0, 300),
      frequency: String(frequency), assignee: String(assignee).slice(0, 120),
      createdAt: new Date().toISOString(),
    };
    store.opsSchedules.unshift(entry);
    return entry;
  });
}

async function removeOpsSchedule(search) {
  return mutate(store => {
    const target = store.opsSchedules.find(o =>
      `${o.villa} ${o.task}`.toLowerCase().includes(String(search).toLowerCase()));
    if (!target) return null;
    store.opsSchedules = store.opsSchedules.filter(o => o.id !== target.id);
    return target;
  });
}

async function listOpsSchedules() {
  const store = await read();
  return store.opsSchedules;
}

async function todaysOps() {
  const now = nowWita();
  const isoDow = ((now.getUTCDay() + 6) % 7) + 1;
  const dom = now.getUTCDate();
  const all = await listOpsSchedules();
  return all.filter(o => {
    const [kind, arg] = o.frequency.split(':');
    return kind === 'daily'
      || (kind === 'weekly' && Number(arg) === isoDow)
      || (kind === 'monthly' && Number(arg) === dom);
  });
}

// ─── Morning DM section ─────────────────────────────────────────────────────────

async function buildMorningExtras(userKey) {
  const lines = [];
  const reminders = (await listReminders(userKey)).filter(r =>
    epochToWitaString(r.at).slice(0, 10) === epochToWitaString(Date.now()).slice(0, 10));
  if (reminders.length) {
    lines.push('*Reminders today:*');
    reminders.forEach(r => lines.push(`- ${epochToWitaString(r.at).slice(11)} ${r.text}`));
  }
  const ops = await todaysOps();
  if (ops.length) {
    if (lines.length) lines.push('');
    lines.push('*Villa ops today:*');
    ops.forEach(o => lines.push(`- ${o.villa}: ${o.task}${o.assignee ? ` (${o.assignee})` : ''}`));
  }
  return lines.join('\n');
}

// ─── Structured command parser (works with ZERO AI credits) ────────────────────

const DOW = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6, minggu: 7 };

function parseWhen(words) {
  // returns { at, recurrence, consumed } or null
  const now = nowWita();
  const y = now.getUTCFullYear(), mo = now.getUTCMonth() + 1, d = now.getUTCDate();
  const timeRe = /^(\d{1,2})[:.](\d{2})$/;
  const w0 = (words[0] || '').toLowerCase(), w1 = (words[1] || '').toLowerCase(), w2 = (words[2] || '').toLowerCase();

  // daily HH:MM
  if ((w0 === 'daily' || w0 === 'setiap-hari') && timeRe.test(w1)) {
    const [, h, mi] = w1.match(timeRe);
    let at = witaToEpoch(y, mo, d, +h, +mi);
    if (at <= Date.now()) at += 86400000;
    return { at, recurrence: 'daily', consumed: 2 };
  }
  // weekly DOW HH:MM
  if (w0 === 'weekly' && DOW[w1] && timeRe.test(w2)) {
    const [, h, mi] = w2.match(timeRe);
    const seed = witaToEpoch(y, mo, d, +h, +mi);
    const r = { at: seed, recurrence: `weekly:${DOW[w1]}` };
    const next = nextOccurrence(r, Date.now() - 1);
    return { at: next || seed, recurrence: r.recurrence, consumed: 3 };
  }
  // monthly D HH:MM
  if (w0 === 'monthly' && /^\d{1,2}$/.test(w1) && timeRe.test(w2)) {
    const [, h, mi] = w2.match(timeRe);
    const seed = witaToEpoch(y, mo, d, +h, +mi);
    const r = { at: seed, recurrence: `monthly:${Number(w1)}` };
    const next = nextOccurrence(r, Date.now() - 1);
    return { at: next || seed, recurrence: r.recurrence, consumed: 3 };
  }
  // +Nh / +Nm
  const rel = w0.match(/^\+(\d+)([hm])$/);
  if (rel) {
    const ms = Number(rel[1]) * (rel[2] === 'h' ? 3600000 : 60000);
    return { at: Date.now() + ms, recurrence: '', consumed: 1 };
  }
  // YYYY-MM-DD HH:MM
  const dateRe = /^(\d{4})-(\d{2})-(\d{2})$/;
  if (dateRe.test(w0) && timeRe.test(w1)) {
    const [, yy, mm, dd] = w0.match(dateRe);
    const [, h, mi] = w1.match(timeRe);
    return { at: witaToEpoch(+yy, +mm, +dd, +h, +mi), recurrence: '', consumed: 2 };
  }
  // tomorrow HH:MM / besok HH:MM
  if ((w0 === 'tomorrow' || w0 === 'besok') && timeRe.test(w1)) {
    const [, h, mi] = w1.match(timeRe);
    return { at: witaToEpoch(y, mo, d, +h, +mi) + 86400000, recurrence: '', consumed: 2 };
  }
  // HH:MM (today, or tomorrow if past)
  if (timeRe.test(w0)) {
    const [, h, mi] = w0.match(timeRe);
    let at = witaToEpoch(y, mo, d, +h, +mi);
    if (at <= Date.now()) at += 86400000;
    return { at, recurrence: '', consumed: 1 };
  }
  return null;
}

const HELP = `*TVMbot commands* (work even without AI):
/remind 15:30 call the notary
/remind tomorrow 09:00 send invoice
/remind 2026-08-01 10:00 renew contract
/remind +2h check the pool
/remind daily 07:00 workout
/remind weekly mon 09:00 team check-in
/remind monthly 25 10:00 chase rent
/reminders — list · /cancel [text] — remove
/remember [fact] · /memory · /forget [text]
/ops add [villa] | [task] | daily|weekly:mon|monthly:15 | [assignee]
/ops list · /ops remove [text]
/help — this message`;

async function tryCommand(text, userKey) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [cmd, ...rest] = trimmed.split(/\s+/);
  const lower = cmd.toLowerCase();

  try {
    if (lower === '/help') return HELP;

    if (lower === '/remind' || lower === '/ingatkan') {
      const when = parseWhen(rest);
      if (!when) return 'Time not understood. Try: /remind 15:30 text · /remind tomorrow 09:00 text · /remind daily 07:00 text (see /help)';
      const text2 = rest.slice(when.consumed).join(' ').trim();
      if (!text2) return 'What should I remind you about? /remind 15:30 [text]';
      const r = await addReminder({ userKey, text: text2, at: when.at, recurrence: when.recurrence });
      const rec = r.recurrence ? ` (${r.recurrence.replace(':', ' ')})` : '';
      return `Reminder set: "${r.text}" — ${epochToWitaString(r.at)} WITA${rec}`;
    }

    if (lower === '/reminders') {
      const list = await listReminders(userKey);
      if (!list.length) return 'No reminders set.';
      return list.slice(0, 15).map((r, i) =>
        `${i + 1}. ${epochToWitaString(r.at)} — ${r.text}${r.recurrence ? ` (${r.recurrence.replace(':', ' ')})` : ''}`
      ).join('\n');
    }

    if (lower === '/cancel') {
      const target = await cancelReminder(userKey, rest.join(' '));
      return target ? `Cancelled: "${target.text}"` : 'No matching reminder found.';
    }

    if (lower === '/remember' || lower === '/ingat') {
      const entry = await remember(userKey, rest.join(' '));
      return `Remembered: "${entry.fact}"`;
    }

    if (lower === '/memory') {
      const list = await getMemory(userKey);
      if (!list.length) return 'Nothing remembered yet. /remember [fact]';
      return list.slice(0, 20).map((e, i) => `${i + 1}. ${e.fact}`).join('\n');
    }

    if (lower === '/forget' || lower === '/lupakan') {
      const target = await forget(userKey, rest.join(' '));
      return target ? `Forgot: "${target.fact}"` : 'No matching memory found.';
    }

    if (lower === '/ops') {
      const sub = (rest[0] || '').toLowerCase();
      if (sub === 'add') {
        const parts = rest.slice(1).join(' ').split('|').map(s => s.trim());
        if (parts.length < 3) return 'Format: /ops add [villa] | [task] | daily|weekly:mon|monthly:15 | [assignee]';
        let freq = parts[2].toLowerCase();
        const wk = freq.match(/^weekly:(\w+)$/);
        if (wk && DOW[wk[1]]) freq = `weekly:${DOW[wk[1]]}`;
        if (!/^(daily|weekly:[1-7]|monthly:([1-9]|[12]\d|3[01]))$/.test(freq)) {
          return 'Frequency must be: daily, weekly:mon..sun, or monthly:1..31';
        }
        const entry = await addOpsSchedule({ villa: parts[0], task: parts[1], frequency: freq, assignee: parts[3] || '' });
        return `Ops schedule added: ${entry.villa} — ${entry.task} (${entry.frequency.replace(':', ' ')})`;
      }
      if (sub === 'list') {
        const list = await listOpsSchedules();
        if (!list.length) return 'No ops schedules. /ops add [villa] | [task] | daily';
        return list.slice(0, 20).map((o, i) =>
          `${i + 1}. ${o.villa}: ${o.task} (${o.frequency.replace(':', ' ')})${o.assignee ? ` — ${o.assignee}` : ''}`
        ).join('\n');
      }
      if (sub === 'remove') {
        const target = await removeOpsSchedule(rest.slice(1).join(' '));
        return target ? `Removed: ${target.villa} — ${target.task}` : 'No matching schedule found.';
      }
      return 'Ops commands: /ops add · /ops list · /ops remove (see /help)';
    }
  } catch (error) {
    return `Error: ${error.message}`;
  }
  return null; // unknown slash command → let AI try (or fall through)
}

module.exports = {
  init, tryCommand, buildMorningExtras,
  addReminder, listReminders, cancelReminder, collectDueReminders,
  remember, forget, getMemory,
  addOpsSchedule, removeOpsSchedule, listOpsSchedules, todaysOps,
  epochToWitaString, witaToEpoch, parseWhen,
};
