'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createOperationsHandler } = require('../operations-connector');

test('both channel bindings derive identity outside model arguments and fail closed', async t => {
  let api;
  try { api = require('../operations-channel-client'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  assert.equal(typeof api?.createOperationsChannels, 'function', 'shared authenticated channel client must exist');
  const token = 'synthetic-key-'.repeat(4);
  const telegramToken = 'synthetic-telegram-key-'.repeat(3);
  const server = http.createServer(createOperationsHandler({
    enabled: true, journalDir: '/unused-for-reads',
    bindings: [{ token, actor: 'afni', channel: 'web' }, { token: telegramToken, actor: 'afni', channel: 'telegram' }],
    tasks: { async getTasks() { return [{ id: 'task-1', name: 'Shared TVM task' }]; } },
    villas: { async getAll() { return { villas: [{ id: 'villa-1', name: 'Shared villa' }] }; } },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const options = {
    enabled: true, url: `http://127.0.0.1:${server.address().port}/v1/operations`,
    telegramBindings: [{ senderId: '100', token: telegramToken }], webBindings: [{ userId: 'user-owner', token }],
    authenticateWeb: req => req.headers?.cookie === 'verified-session' ? { id: 'user-owner' } : null,
  };
  const client = api.createOperationsChannels(options);
  const tool = { action: 'list_tasks', input: {} };
  const update = { message_id: 10, from: { id: 100 }, chat: { id: 100, type: 'private' } };
  assert.equal((await client.fromTelegram(update, tool)).result.items[0].name, 'Shared TVM task');
  assert.equal((await client.fromWeb({ headers: { cookie: 'verified-session' } }, tool)).result.items[0].name, 'Shared TVM task');
  for (const bad of [
    { ...update, from: { id: 101, username: 'afni' } },
    { ...update, chat: { id: -100, type: 'group' } },
    { ...update, from: { id: 100, is_bot: true } },
    { ...update, message_id: undefined },
  ]) await assert.rejects(client.fromTelegram(bad, tool), /unauthorized/);
  await assert.rejects(client.fromWeb({ body: { userId: 'user-owner', authenticated: true } }, tool), /unauthorized/);
  await assert.rejects(client.fromWeb({ headers: { cookie: 'verified-session' } }, { ...tool, actor: 'syifa' }), /invalid_arguments/);
  await assert.rejects(client.fromTelegram(update, { action: 'finance_read', input: {} }), /action_not_allowed/);
  await assert.rejects(client.fromWeb({ headers: { cookie: 'verified-session' } }, { action: 'create_task', input: { name: 'Task' } }), /trusted_delivery_required/);
  await assert.rejects(api.createOperationsChannels({ ...options, enabled: false }).fromTelegram(update, tool), /connector_disabled/);
  assert.throws(() => api.createOperationsChannels({ ...options, url: 'http://example.com/v1/operations' }), /HTTPS/);
  assert.throws(() => api.createOperationsChannels({ ...options, telegramBindings: [{ senderId: '100', token }, { senderId: '100', token }] }), /binding/);
  const unicodeServer = http.createServer((req, res) => {
    const raw = Buffer.from(JSON.stringify({ ok: true, result: { name: 'Café' } }));
    const split = raw.indexOf(Buffer.from('é')) + 1;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(raw.subarray(0, split)); setTimeout(() => res.end(raw.subarray(split)), 10);
  });
  await new Promise(resolve => unicodeServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { unicodeServer.close(resolve); unicodeServer.closeAllConnections(); }));
  const unicodeClient = api.createOperationsChannels({ ...options, url: `http://127.0.0.1:${unicodeServer.address().port}/v1/operations` });
  assert.equal((await unicodeClient.fromTelegram(update, tool)).result.name, 'Café');
});
