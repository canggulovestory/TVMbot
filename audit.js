/**
 * audit.js — Append-only activity log. Who did what, when.
 * Stored in data/audit.json, capped at the newest 1000 entries.
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');

let filePath;
let writeQueue = Promise.resolve();

function init(dataDir) {
  filePath = path.join(dataDir, 'audit.json');
}

async function read() {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch { return []; }
}

function add(user, action, detail = '') {
  const task = writeQueue.then(async () => {
    const entries = await read();
    entries.unshift({
      at: new Date().toISOString(),
      user: String(user || 'system').slice(0, 40),
      action: String(action || '').slice(0, 60),
      detail: String(detail || '').slice(0, 200),
    });
    const next = entries.slice(0, 1000);
    const temp = `${filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temp, filePath);
  });
  writeQueue = task.catch(() => {});
  return task;
}

async function list(limit = 200) {
  const entries = await read();
  return entries.slice(0, limit);
}

module.exports = { init, add, list };
