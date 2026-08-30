'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const villaData = require('../villa-data');

test('private villa operations notes persist with the villa record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-villa-ops-'));
  villaData.init(dir);
  const villa = await villaData.upsert('villas', {
    name: 'Villa LYSA',
    operationsNotes: 'Private key-box and access instructions.',
  });
  assert.equal(villa.operationsNotes, 'Private key-box and access instructions.');
  const stored = await villaData.getAll();
  assert.equal(stored.villas[0].operationsNotes, 'Private key-box and access instructions.');
  await fs.rm(dir, { recursive: true, force: true });
});
