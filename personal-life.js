/** Private, life-only data store for app.zuzuzu.tech. */
'use strict';
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

let filePath = '';
let writeQueue = Promise.resolve();
const KINDS = new Set(['task', 'goal', 'habit', 'note', 'journal', 'routine', 'travel', 'shopping']);

function init(dataDir) { filePath = path.join(dataDir, 'zuzu-life.json'); }
function empty() { return { version: 1, items: [] }; }
function clean(value, max = 2000) { return String(value || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max); }
async function read() {
  try { const data = JSON.parse(await fs.readFile(filePath, 'utf8')); return { ...empty(), items: Array.isArray(data.items) ? data.items : [], challenges: data.challenges && typeof data.challenges === 'object' && !Array.isArray(data.challenges) ? data.challenges : {} }; }
  catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
}
function mutate(work) {
  const task = writeQueue.then(async () => {
    const data = await read(); const result = await work(data);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.tmp`; await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(temp, filePath);
    return result;
  });
  writeQueue = task.catch(() => {}); return task;
}
async function overview(user, options = {}) {
  const data = await read(); const today = new Date().toISOString().slice(0, 10);
  const own = data.items.filter(item => item.user === user);
  const q = clean(options.q, 200).toLocaleLowerCase();
  const limit = Number.isInteger(Number(options.limit)) && Number(options.limit) > 0 ? Math.min(Number(options.limit), 120) : 120;
  const offset = Number.isSafeInteger(Number(options.offset)) && Number(options.offset) >= 0 ? Number(options.offset) : 0;
  const matching = own.filter(item => !q || [item.title, item.details, item.kind].join(' ').toLocaleLowerCase().includes(q))
    .sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  return { today, items: matching.slice(offset, offset + limit), total: matching.length, offset, limit, hasMore: offset + limit < matching.length,
    counts: { tasks: own.filter(x => x.kind === 'task' && !x.done).length, goals: own.filter(x => x.kind === 'goal' && !x.done).length, habits: own.filter(x => x.kind === 'habit' && !x.done).length, routines: own.filter(x => x.kind === 'routine' && !x.done).length, travel: own.filter(x => x.kind === 'travel' && !x.done).length, shopping: own.filter(x => x.kind === 'shopping' && !x.done).length } };
}
async function add(user, input) {
  const kind = KINDS.has(String(input.kind)) ? String(input.kind) : 'task'; const title = clean(input.title, 300);
  if (!title) throw new Error('Write something first.');
  return mutate(data => { const item = { id: `LIFE-${crypto.randomUUID()}`, user, kind, title, details: clean(input.details, 2000), dueDate: clean(input.dueDate, 20), done: false, createdAt: new Date().toISOString() }; data.items.unshift(item); return item; });
}
async function complete(user, id, done) {
  return mutate(data => { const item = data.items.find(x => x.id === String(id) && x.user === user); if (!item) return null; item.done = done !== false; item.updatedAt = new Date().toISOString(); return item; });
}

function requiredText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}.`);
  return value;
}
function validateChallenge(input) {
  if (!input || !Array.isArray(input.days) || input.days.length !== 90) throw new Error('A challenge must contain 90 days.');
  const title = requiredText(input.title, 200, 'title');
  const guide = requiredText(input.guide, 100000, 'guide');
  const fields = ['mission','training','ugc','arabic','spiritual','health','mind'];
  let previousDate;
  const days = input.days.map((item, index) => {
    if (!item || item.day !== index + 1) throw new Error('Invalid day sequence.');
    const date = requiredText(item.date, 10, 'date');
    const timestamp = Date.parse(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10) !== date || (previousDate !== undefined && timestamp !== previousDate + 86400000)) throw new Error('Invalid date sequence.');
    previousDate = timestamp;
    const day = { day: item.day, date };
    for (const field of fields) day[field] = requiredText(item[field], 6000, field);
    return day;
  });
  return { title, guide, days };
}
async function challenge(user) {
  const data = await read();
  return Object.hasOwn(data.challenges || {}, user) ? data.challenges[user] : null;
}
async function importChallenge(user, input) {
  const plan = validateChallenge(input);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return mutate(data => {
    data.challenges ||= {};
    if (Object.hasOwn(data.challenges, user)) {
      if (data.challenges[user].fingerprint !== fingerprint) throw new Error('A different challenge already exists. It has not been replaced.');
      return data.challenges[user];
    }
    const saved = { ...plan, fingerprint, progress: {}, createdAt: new Date().toISOString() };
    Object.defineProperty(data.challenges, user, { value: saved, enumerable: true, configurable: true, writable: true });
    return saved;
  });
}
async function updateChallengeDay(user, day, input) {
  if (!Number.isInteger(day) || day < 1 || day > 90) throw new Error('Invalid day.');
  if (!input || !['pending','done','modified','skipped'].includes(input.status)) throw new Error('Invalid status.');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) throw new Error('Invalid note.');
  return mutate(data => {
    if (!Object.hasOwn(data.challenges || {}, user)) throw new Error('No challenge found.');
    const saved = data.challenges[user];
    saved.progress[String(day)] = { status: input.status, note: input.note || '', updatedAt: new Date().toISOString() };
    return saved.progress[String(day)];
  });
}

/** Explicit chat shortcuts keep life storage separate and avoid guessing which private thoughts to save. */
async function tryCommand(user, message) {
  const match = String(message || '').trim().match(/^(task|goal|habit|note|journal|routine|travel|shopping)\s*:\s*(.+)$/i);
  if (!match) return null;
  const item = await add(user, { kind: match[1].toLowerCase(), title: match[2] });
  return `Saved to your private ${item.kind} list: ${item.title}`;
}
module.exports = { init, overview, add, complete, tryCommand, challenge, importChallenge, updateChallengeDay };
