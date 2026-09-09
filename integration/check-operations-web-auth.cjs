'use strict';
// Run against the installed personal app's auth module, with a disposable auth
// store. Never pass its production data directory or an existing session token.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createOperationsHandler } = require('../operations-connector');
const { createOperationsChannels } = require('../operations-channel-client');

async function main() {
  if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error('Pass an absolute path to the installed private-auth.js');
  const { createAuth } = require(process.argv[2]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuzu-auth-check-'));
  const token = 'synthetic-connector-key-'.repeat(3);
  const auth = createAuth({ dir, setupToken: 'synthetic-setup', setupExpires: Date.now() + 60000, origin: 'https://app.zuzuzu.tech' });
  const routes = new Map();
  auth.install({ get: (route, fn) => routes.set('GET ' + route, fn), post: (route, fn) => routes.set('POST ' + route, fn) });
  function route(name, req) {
    const result = { status: 200, headers: {} };
    routes.get('POST ' + name)(req, { status(code) { result.status = code; return this; }, setHeader(key, value) { result.headers[key] = value; }, json(body) { result.body = body; } });
    return result;
  }
  const server = http.createServer(createOperationsHandler({
    enabled: true, bindings: [{ token, actor: 'afni', channel: 'web' }], journalDir: path.join(dir, 'receipts'),
    tasks: { async getTasks() { return [{ id: 'synthetic-task', name: 'Synthetic verified read' }]; } },
    villas: { async getAll() { return { villas: [] }; } },
  }));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = createOperationsChannels({ enabled: true, url: `http://127.0.0.1:${server.address().port}/v1/operations`, webBindings: [{ userId: 'u_afni', token }], authenticateWeb: auth.authenticate });
    const tool = { action: 'list_tasks', input: {} };
    await assert.rejects(client.fromWeb({ headers: {}, body: { userId: 'u_afni' } }, tool), /unauthorized/);
    const setup = route('/api/auth/setup', { headers: { origin: 'https://app.zuzuzu.tech' }, body: { token: 'synthetic-setup', password: 'Synthetic-password-only-2026' } });
    assert.equal(setup.status, 200);
    const req = { headers: { cookie: 'zuzu_private=' + setup.body.token, origin: 'https://app.zuzuzu.tech' } };
    assert.equal((await client.fromWeb(req, tool)).result.items[0].name, 'Synthetic verified read');
    route('/api/auth/logout', req);
    await assert.rejects(client.fromWeb(req, tool), /unauthorized/);
    const restartedAuth = createAuth({ dir });
    assert.equal(restartedAuth.authenticate(req), null, 'revocation survives auth reload');
    console.log('PASS: installed auth module -> owner connector read; forged identity and logged-out session rejected. Synthetic data only.');
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
