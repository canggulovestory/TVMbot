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
const personalLife = require('../personal-life');

test('web chat keeps follow-up context separate for Admin and personal life', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-web-conversation-'));
  assistant.init(dir); villaData.init(dir); personalLife.init(dir);
  await personalLife.add('afni', { kind: 'note', title: 'Volingo language learning', details: 'A private learning link' });
  const original = hermes.respond; const received = [];
  hermes.respond = async args => { received.push(args); return 'First answer'; };
  try {
    await brain.processInternalMessage({ userKey: 'afni', text: 'My audit label is blue' });
    await brain.processInternalMessage({ userKey: 'afni', text: 'Which audit label?' });
    assert.equal(received[1].conversationHistory[0].content, 'My audit label is blue');
    await brain.processPersonalMessage({ userKey: 'afni', text: 'My imaginary trip is to Kyoto' });
    assert.deepEqual(received[2].conversationHistory, []);
    assert.match(received[2].instructions, /Volingo language learning/);
    await brain.processPersonalMessage({ userKey: 'afni', text: 'Which city?' });
    assert.equal(received[3].conversationHistory[0].content, 'My imaginary trip is to Kyoto');
    assert.ok(!JSON.stringify(received[3].conversationHistory).includes('audit label'));
  } finally { hermes.respond = original; await fs.rm(dir, { recursive: true, force: true }); }
});

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

test('web scopes forward approval and cancellation controls to Hermes', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tvm-web-approval-'));
  assistant.init(dir);villaData.init(dir);personalLife.init(dir);
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const original=hermes.respond,received=[];
  hermes.respond=async args=>{received.push(args);return 'Ready'};
  const onApproval=async()=>'deny',signal=new AbortController().signal;
  try{
    await brain.processInternalMessage({userKey:'afni',text:'Discuss a fictional idea',onApproval,signal});
    await brain.processPersonalMessage({userKey:'afni',text:'Discuss a fictional walk',onApproval,signal});
    for(const args of received){assert.equal(args.onApproval,onApproval);assert.equal(args.signal,signal)}
  }finally{hermes.respond=original}
});
