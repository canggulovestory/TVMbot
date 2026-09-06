'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const brain = require('../brain');
const hermes = require('../hermes-client');
const assistant = require('../assistant');
const villaData = require('../villa-data');

test('a follow-up task list reaches Hermes with recent context and its approval callback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-conversation-'));
  assistant.init(dir); villaData.init(dir);
  const original = hermes.respond;
  const received = [];
  hermes.respond = async args => { received.push(args); return 'What tasks for tomorrow?'; };
  const onApproval = async () => 'deny';
  try {
    await brain.processMessage({ phone: '6282122922252', text: 'zuzu lets put the task for tomorrow', onApproval });
    await brain.processMessage({ phone: '6282122922252', text: '• get water heater from Mitra10\n• check villa lysa', onApproval });
    assert.equal(received.length, 2);
    assert.equal(received[1].onApproval, onApproval);
    assert.deepEqual(received[1].conversationHistory, [
      { role: 'user', content: 'zuzu lets put the task for tomorrow' },
      { role: 'assistant', content: 'What tasks for tomorrow?' },
    ]);
    await brain.processMessage({ phone: '6287750590799', text: 'hello', onApproval });
    assert.deepEqual(received[2].conversationHistory, []);
  } finally { hermes.respond = original; await fs.rm(dir, { recursive: true, force: true }); }
});
