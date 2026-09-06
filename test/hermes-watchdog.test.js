'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('free-model watchdog leaves a paid provider untouched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-watchdog-'));
  try {
    await fs.writeFile(path.join(dir, 'hermes'), '#!/bin/sh\nif [ "$*" = "-p tvm config get model.provider" ]; then echo openrouter; else exit 99; fi\n', { mode: 0o700 });
    const output = execFileSync('bash', ['ops/hermes/model-watchdog.sh'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.match(output, /not managed by the free-model watchdog/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
