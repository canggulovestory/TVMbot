'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('each personal chat response stays with its message; pending cannot duplicate sends', async () => {
  const createChat = require('../personal/chat-state');
  let release; let calls = 0;
  const chat = createChat(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = chat.send('Kyoto');
  await chat.send('Duplicate');
  assert.equal(calls, 1);
  release({ reply: 'First answer' }); await first;
  const second = chat.send('Another city');
  release({ reply: 'Second answer' }); await second;
  assert.deepEqual(chat.messages.filter(m => m.role === 'assistant').map(m => m.text), ['First answer', 'Second answer']);
  assert.ok(chat.messages.every(m => !m.pending));
  assert.equal(chat.busy, false);
});

test('failed personal chat retains the user message and replaces its own pending state', async () => {
  const createChat = require('../personal/chat-state');
  const chat = createChat(async () => { throw new Error('Timed out'); });
  await chat.send('Keep this request');
  assert.equal(chat.messages[0].text, 'Keep this request');
  assert.match(chat.messages[1].text, /Timed out/);
  assert.equal(chat.messages[1].pending, false);
  assert.equal(chat.busy, false);
});
