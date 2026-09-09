'use strict';

// Trusted transport only. Never load this module or its keys into a model worker.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const ACTIONS = new Set(['list_tasks', 'create_task', 'complete_task', 'list_villas']);
const VILLA_FIELDS = ['id', 'name', 'code', 'status', 'location', 'mapUrl', 'bedrooms', 'bathrooms', 'maxGuests', 'pool', 'facilities', 'listingUrl', 'keyBoxCode', 'backupKeyLocation', 'checkInInstructions', 'internetProvider', 'internetPlan', 'internetLocationId', 'internetCircuitId', 'internetPortalUrl', 'wifiName', 'wifiPassword', 'electricityDetails', 'waterDetails', 'poolServiceSchedule', 'cleaningSchedule', 'gardeningSchedule', 'wasteSchedule', 'pestControlSchedule', 'linenSchedule', 'maintenanceContact', 'emergencyContact'];
const TASK_FIELDS = ['id', 'name', 'priority', 'done', 'dueDate', 'projectIds'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const pick = (item, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
function object(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) fail(400, 'invalid_arguments');
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail(400, 'invalid_arguments');
  return value.trim();
}
function validate(body) {
  object(body, ['action', 'input', 'requestId']);
  if (!ACTIONS.has(body.action)) fail(403, 'action_not_allowed');
  const input = body.input;
  if (body.action.startsWith('list_')) {
    object(input, ['search', 'offset', 'limit']);
    const search = input.search === undefined || input.search === '' ? '' : text(input.search, 150);
    const offset = input.offset ?? 0, limit = input.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, 'invalid_arguments');
    return { search, offset, limit };
  }
  text(body.requestId, 160);
  if (body.action === 'complete_task') {
    object(input, ['id']);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.id || '')) fail(400, 'invalid_arguments');
    return { id: input.id.toLowerCase() };
  }
  object(input, ['name', 'priority', 'dueDate']);
  const result = { name: text(input.name, 300), priority: input.priority ?? 'Mid' };
  if (!['High', 'Mid', 'Low'].includes(result.priority)) fail(400, 'invalid_arguments');
  if (input.dueDate !== undefined) {
    if (typeof input.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || !Number.isFinite(Date.parse(input.dueDate)) || new Date(input.dueDate).toISOString().slice(0, 10) !== input.dueDate) fail(400, 'invalid_arguments');
    result.dueDate = input.dueDate;
  }
  return result;
}

async function syncDir(dir) { const handle = await fs.open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function durableFile(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await syncDir(path.dirname(file));
}

function createOperationsHandler({ enabled = false, bindings = [], journalDir, tasks, villas }) {
  const tokens = new Map();
  for (const binding of bindings) {
    if (typeof binding.token !== 'string' || binding.token.length < 32 || !['telegram', 'web'].includes(binding.channel) || !['afni', 'syifa'].includes(binding.actor) || tokens.has(digest(binding.token))) throw new Error('Invalid connector binding');
    tokens.set(digest(binding.token), Object.freeze({ actor: binding.actor, channel: binding.channel, canWriteTasks: binding.canWriteTasks === true }));
  }
  if (enabled && (!journalDir || !path.isAbsolute(journalDir) || !tasks || !villas || !tokens.size)) throw new Error('Connector configuration is incomplete');
  // One broker process owns this journal. Exclusive creation also fails closed across processes.
  let queue = Promise.resolve();
  async function writeTask(binding, body, input) {
    if (!binding.canWriteTasks) fail(403, 'action_not_allowed');
    const run = queue.then(async () => {
      await fs.mkdir(journalDir, { recursive: true, mode: 0o700 });
      if ((await fs.stat(journalDir)).mode & 0o077) fail(503, 'private_journal_required');
      const file = path.join(journalDir, digest(JSON.stringify([binding.channel, binding.actor, body.requestId])) + '.json');
      const fingerprint = digest(JSON.stringify([body.action, input]));
      let receipt;
      try { receipt = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail(409, 'request_conflict');
        if (receipt.state !== 'done') fail(409, 'outcome_uncertain');
        return receipt.result;
      }
      // Resolve exact task membership before allowing a page update. Never update a guessed page ID.
      if (body.action === 'complete_task' && !(await tasks.getTasks()).some(item => item.id === input.id)) fail(404, 'task_not_found');
      const audit = { fingerprint, actor: binding.actor, channel: binding.channel, action: body.action, at: new Date().toISOString(), state: 'pending' };
      try { await durableFile(file, audit); } catch (error) { if (error.code === 'EEXIST') fail(409, 'outcome_uncertain'); throw error; }
      try {
        const result = pick(await (body.action === 'create_task' ? tasks.createTask(input) : tasks.completeTaskById(input.id)), TASK_FIELDS);
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.id || '') || (body.action === 'create_task' ? result.name !== input.name : result.id !== input.id || result.done !== true)) fail(409, 'outcome_uncertain');
        const temp = file + '.' + crypto.randomUUID() + '.tmp';
        await durableFile(temp, { ...audit, state: 'done', result });
        await fs.rename(temp, file); await syncDir(journalDir);
        return result;
      } catch (_) { fail(409, 'outcome_uncertain'); }
    });
    queue = run.catch(() => {});
    return run;
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const reply = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    try {
      if (req.url !== '/v1/operations' || req.method !== 'POST') fail(404, 'not_found');
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      const binding = token && tokens.get(digest(token));
      if (!binding) fail(401, 'unauthorized');
      if (!enabled) fail(503, 'connector_disabled');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'json_required');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8192) fail(413, 'request_too_large'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { fail(400, 'invalid_json'); }
      const input = validate(body);
      let result;
      if (body.action.startsWith('list_')) {
        const records = body.action === 'list_tasks' ? await tasks.getTasks() : (await villas.getAll()).villas;
        const fields = body.action === 'list_tasks' ? TASK_FIELDS : VILLA_FIELDS;
        const selected = records.map(item => pick(item, fields)).filter(item => !input.search || `${item.name || ''} ${item.code || ''}`.toLowerCase().includes(input.search.toLowerCase()));
        result = { items: selected.slice(input.offset, input.offset + input.limit), nextOffset: input.offset + input.limit < selected.length ? input.offset + input.limit : null, sourceMayBeTruncated: body.action === 'list_tasks' && records.length >= 100 };
      } else result = await writeTask(binding, body, input);
      reply(200, { ok: true, result });
    } catch (error) {
      reply(error.status || 503, { ok: false, error: error.status ? error.code : 'service_unavailable' });
    }
  };
}
module.exports = { createOperationsHandler };
