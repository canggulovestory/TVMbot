'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ownerKey = 'owner-key-'.repeat(5), webKey = 'web-key-'.repeat(6), staffKey = 'staff-key-'.repeat(5);

test('protected operations connector enforces identity, scope and durable retry safety', async t => {
  let api;
  try { api = require('../operations-connector'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  assert.equal(typeof api?.createOperationsHandler, 'function', 'protected connector must exist');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-connector-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tasks = [];
  let attemptedCreates = 0;
  const options = {
    enabled: true, journalDir: dir,
    bindings: [
      { token: ownerKey, actor: 'afni', channel: 'telegram', canWriteTasks: true },
      { token: webKey, actor: 'afni', channel: 'web', canWriteTasks: true },
      { token: staffKey, actor: 'syifa', channel: 'telegram', canWriteTasks: false },
    ],
    tasks: {
      async getTasks() { return tasks; },
      async createTask(input) {
        attemptedCreates++;
        const task = { id: '11111111-1111-4111-8111-111111111111', ...input, done: false };
        tasks.push(task);
        if (input.name === 'Lost response') throw new Error('secret upstream token and private URL');
        if (input.name === 'Missing receipt') return {};
        return task;
      },
      async completeTaskById(id) { tasks.find(x => x.id === id).done = true; return { id, done: true }; },
    },
    villas: { async getAll() { return {
      villas: [{ id: 'VIL-1', name: 'Villa Test', wifiName: 'Test Wi-Fi', keyBoxCode: 'synthetic', monthlyRate: 999, internetPaymentDetails: 'bank account', operationsNotes: 'private financial notes' }],
      transactions: [{ amount: 999 }], deposits: [{ amount: 888 }],
    }; } },
  };
  let handler = api.createOperationsHandler(options);
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/operations`;
  async function call(body, token = ownerKey) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await call({ action: 'list_tasks', input: {} }, '')).status, 401);
  assert.equal((await call({ action: 'list_tasks', input: {} }, 'unknown')).status, 401);
  assert.equal((await call({ action: 'list_tasks', input: {}, actor: 'afni' }, staffKey)).status, 400);
  for (const action of ['mark_paid', 'finance_read', 'finance_prepare', 'save_record', 'delete_task', '__proto__']) {
    assert.equal((await call({ action, input: {} })).status, 403, action);
  }
  const villas = await call({ action: 'list_villas', input: {} }, webKey);
  assert.equal(villas.status, 200);
  assert.equal(villas.body.result.items[0].wifiName, 'Test Wi-Fi');
  assert.equal(villas.body.result.items[0].keyBoxCode, 'synthetic');
  for (const field of ['monthlyRate', 'internetPaymentDetails', 'operationsNotes', 'transactions', 'deposits']) assert.ok(!JSON.stringify(villas.body).includes(field));
  const command = { action: 'create_task', input: { name: 'Review villa', priority: 'High', dueDate: '2026-09-11' }, requestId: 'message-1:tool-1' };
  assert.equal((await call(command, staffKey)).status, 403);
  assert.equal((await call({ ...command, input: { ...command.input, userKey: 'afni' } })).status, 400);
  assert.equal((await call({ ...command, input: { ...command.input, dueDate: '2026-02-30' } })).status, 400);
  assert.equal((await call({ action: 'create_task', input: command.input })).status, 400);
  assert.equal(attemptedCreates, 0);
  const [first, retry] = await Promise.all([call(command), call(command)]);
  assert.equal(first.status, 200); assert.deepEqual(first.body, retry.body);
  assert.equal(tasks.length, 1);
  handler = api.createOperationsHandler(options); // process restart reuses private receipt journal
  assert.deepEqual((await call(command)).body, first.body);
  assert.equal(attemptedCreates, 1);
  assert.equal((await call({ ...command, input: { name: 'Different task' } })).status, 409);
  assert.equal((await call({ action: 'list_tasks', input: {} }, webKey)).body.result.items[0].name, 'Review villa');
  assert.equal((await call({ action: 'complete_task', input: { id: '22222222-2222-4222-8222-222222222222' }, requestId: 'complete-wrong' })).status, 404);
  assert.equal((await call({ action: 'complete_task', input: { id: tasks[0].id }, requestId: 'complete-1' })).status, 200);
  assert.equal(tasks[0].done, true);
  const uncertain = { action: 'create_task', input: { name: 'Lost response' }, requestId: 'lost-1' };
  assert.equal((await call(uncertain)).status, 409);
  handler = api.createOperationsHandler(options);
  const lostRetry = await call(uncertain);
  assert.equal(lostRetry.status, 409);
  assert.equal(lostRetry.body.error, 'outcome_uncertain');
  assert.equal(attemptedCreates, 2, 'uncertain writes must never be blindly retried');
  assert.ok(!JSON.stringify(lostRetry.body).includes('secret'));
  const unicode = Buffer.from(JSON.stringify({ action: 'create_task', input: { name: 'Check café' }, requestId: 'unicode-1' }));
  const split = unicode.indexOf(Buffer.from('é')) + 1;
  const unicodeReply = await new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerKey}` } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; }); response.on('end', () => resolve(JSON.parse(raw)));
    });
    request.on('error', reject); request.write(unicode.subarray(0, split)); setTimeout(() => request.end(unicode.subarray(split)), 10);
  });
  assert.equal(unicodeReply.result.name, 'Check café', 'UTF-8 split across network chunks must stay intact');
  assert.equal((await call({ action: 'create_task', input: { name: 'Missing receipt' }, requestId: 'bad-receipt-1' })).status, 409, 'a missing committed task ID cannot be reported as saved');
  handler = api.createOperationsHandler({ ...options, enabled: false });
  assert.equal((await call({ action: 'list_tasks', input: {} })).status, 503);
});
