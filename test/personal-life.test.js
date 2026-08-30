'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const life = require('../personal-life');

test('personal commands save only an explicit private-life item', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuzu-life-'));
  life.init(dir);
  assert.equal(await life.tryCommand('afni', 'journal: A quiet morning'), 'Saved to your private journal list: A quiet morning');
  assert.equal(await life.tryCommand('afni', 'I feel tired today'), null);
  const overview = await life.overview('afni');
  assert.equal(overview.items[0].kind, 'journal');
  await fs.rm(dir, { recursive: true, force: true });
});
