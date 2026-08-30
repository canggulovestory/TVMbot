'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assistant = require('../assistant');

test('villa-specific operations memory can be recalled for private admin display', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-ops-memory-'));
  assistant.init(dir);
  await assistant.remember('afni', 'Villa LYSA key box code is stored in operations memory.', { category: 'reference' });
  const facts = await assistant.searchMemory('afni', 'Villa LYSA', 12);
  assert.equal(facts.length, 1);
  assert.match(facts[0].fact, /key box/i);
  await fs.rm(dir, { recursive: true, force: true });
});
