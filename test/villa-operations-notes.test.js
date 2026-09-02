'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const villaData = require('../villa-data');

test('private villa operations details persist with the villa record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-villa-ops-'));
  villaData.init(dir);
  const villa = await villaData.upsert('villas', {
    name: 'Villa LYSA',
    keyBoxCode: '1992',
    poolServiceSchedule: 'Tuesday and Friday at 09:00',
    internetProvider: 'GlobalXtreme',
    internetLocationId: 'afnihenG74D',
    wifiPassword: 'private-password',
    operationsNotes: 'Private key-box and access instructions.',
  });
  assert.equal(villa.keyBoxCode, '1992');
  assert.equal(villa.poolServiceSchedule, 'Tuesday and Friday at 09:00');
  assert.equal(villa.internetProvider, 'GlobalXtreme');
  assert.equal(villa.internetLocationId, 'afnihenG74D');
  assert.equal(villa.wifiPassword, 'private-password');
  assert.equal(villa.operationsNotes, 'Private key-box and access instructions.');
  const stored = await villaData.getAll();
  assert.equal(stored.villas[0].keyBoxCode, '1992');
  assert.equal(stored.villas[0].poolServiceSchedule, 'Tuesday and Friday at 09:00');
  assert.equal(stored.villas[0].operationsNotes, 'Private key-box and access instructions.');
  await fs.rm(dir, { recursive: true, force: true });
});

test('admin exposes structured operations fields without publishing them', () => {
  const root = path.join(__dirname, '..');
  const admin = fsSync.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
  const server = fsSync.readFileSync(path.join(root, 'index.js'), 'utf8');
  const publicApi = server.slice(server.indexOf("url.pathname === '/api/public/villas'"), server.indexOf("url.pathname === '/api/owner/overview'"));
  assert.match(admin, /name="keyBoxCode"/);
  assert.match(admin, /name="poolServiceSchedule"/);
  assert.match(admin, /name="cleaningSchedule"/);
  assert.match(admin, /name="wifiPassword"/);
  assert.match(admin, /name="internetLocationId"/);
  assert.match(admin, /Internet service &amp; billing/);
  assert.doesNotMatch(publicApi, /keyBoxCode|wifiPassword|internetLocationId|internetPaymentDetails|poolServiceSchedule|operationsNotes/);
});
