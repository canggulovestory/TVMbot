/** Private, life-only data store for app.zuzuzu.tech. */
'use strict';
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

let filePath = '';
let writeQueue = Promise.resolve();
const KINDS = new Set(['task', 'goal', 'habit', 'note']);

function init(dataDir) { filePath = path.join(dataDir, 'zuzu-life.json'); }
function empty() { return { version: 1, items: [] }; }
function clean(value, max = 2000) { return String(value || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max); }
async function read() {
  try { const data = JSON.parse(await fs.readFile(filePath, 'utf8')); return { ...empty(), items: Array.isArray(data.items) ? data.items : [] }; }
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
async function overview(user) {
  const data = await read(); const today = new Date().toISOString().slice(0, 10);
  const own = data.items.filter(item => item.user === user);
  return { today, items: own.slice().sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 120),
    counts: { tasks: own.filter(x => x.kind === 'task' && !x.done).length, goals: own.filter(x => x.kind === 'goal' && !x.done).length, habits: own.filter(x => x.kind === 'habit' && !x.done).length } };
}
async function add(user, input) {
  const kind = KINDS.has(String(input.kind)) ? String(input.kind) : 'task'; const title = clean(input.title, 300);
  if (!title) throw new Error('Write something first.');
  return mutate(data => { const item = { id: `LIFE-${crypto.randomUUID()}`, user, kind, title, details: clean(input.details, 2000), dueDate: clean(input.dueDate, 20), done: false, createdAt: new Date().toISOString() }; data.items.unshift(item); data.items = data.items.slice(0, 1000); return item; });
}
async function complete(user, id, done) {
  return mutate(data => { const item = data.items.find(x => x.id === String(id) && x.user === user); if (!item) return null; item.done = done !== false; item.updatedAt = new Date().toISOString(); return item; });
}
module.exports = { init, overview, add, complete };
