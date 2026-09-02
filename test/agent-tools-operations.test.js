'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const villaData = require('../villa-data');
const { searchOperations } = require('../agent-tools');
const { buildPrompt, quickVillaFactReply } = require('../brain');

test('Zuzu villa lookup returns structured electricity and utility details', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-agent-ops-'));
  villaData.init(dir);
  await villaData.upsert('villas', {
    name: 'Villa Lourinka',
    electricityDetails: '86279021751 · 5,500 kWh',
    wifiName: 'Lourinka',
    wifiPassword: 'thevillamanagers.com',
    internetBillingDetails: 'IDR 333,000 / month · Due around the 1st',
  });

  for (const search of [
    'what’s token electric Lourinka',
    'berapa nomor token listrik Lourinka',
    'wat is het elektriciteit token Lourinka',
    'whts tokn eletric lourinca',
    'brapa nomr tokn lisrik lourinka',
    'wat is elektrisiteit tokn lourinca',
  ]) {
    const result = await searchOperations({ search });
    assert.equal(result.villas.length, 1);
    assert.equal(result.villas[0].electricityDetails, '86279021751 · 5,500 kWh');
    assert.equal(result.villas[0].wifiName, 'Lourinka');
    assert.match(result.villas[0].internetBillingDetails, /333,000/);
    assert.match(await quickVillaFactReply(search), /86279021751/);
  }

  assert.match(await quickVillaFactReply('wfi pasword lourinca'), /thevillamanagers\.com/);
});

test('Zuzu receives matching live operations data before answering', () => {
  const prompt = buildPrompt({ name: 'Afni', key: 'afni', buckets: [], schedule: {} }, [], {
    asOf: '2026-09-03',
    villas: [{ name: 'Villa Lourinka', electricityDetails: '86279021751 · 5,500 kWh' }],
  });
  assert.match(prompt, /86279021751/);
  assert.match(prompt, /source of truth/i);
  assert.match(prompt, /Dutch \(Nederlands\)/);
});
