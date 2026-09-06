'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('Telegram approval is bound to its requester, chat, message and a single use', async () => {
  const { createApprovals } = require('../channels/telegram-approvals');
  let sent;
  const bot = { sendMessage: async (chat, text, options) => { sent = { chat, text, options }; return { message_id: 50 }; },
    editMessageReplyMarkup: async () => {}, answerCallbackQuery: async () => {} };
  const approvals = createApprovals(bot);
  const controller = new AbortController();
  const result = approvals.ask({ chatId: 10, userId: '10' }, { command: 'read Sempol', choices: ['once', 'always', 'deny'] }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.options.reply_markup.inline_keyboard[0].map(b => b.text), ['Approve once', 'Deny']);
  const data = sent.options.reply_markup.inline_keyboard[0][0].callback_data;
  const query = { id: 'q', from: { id: 99 }, message: { message_id: 50, chat: { id: 10, type: 'private' } }, data };
  assert.equal(await approvals.handle(query), false);
  assert.equal(await approvals.handle({ ...query, from: { id: 10 }, message: { ...query.message, message_id: 51 } }), false);
  assert.equal(await approvals.handle({ ...query, from: { id: 10 } }), true);
  assert.equal(await result, 'once');
  assert.equal(await approvals.handle({ ...query, from: { id: 10 } }), false);
});

test('Telegram approval aborts safely and never offers truncated or hard-denied commands', async () => {
  const { createApprovals } = require('../channels/telegram-approvals');
  let sends = 0;
  const bot = { sendMessage: async () => { sends++; return { message_id: 1 }; }, editMessageReplyMarkup: async () => {}, answerCallbackQuery: async () => {} };
  const approvals = createApprovals(bot);
  const controller = new AbortController();
  const result = approvals.ask({ chatId: 10, userId: '10' }, { command: 'read', choices: ['once', 'deny'] }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await result, 'deny');
  const opts = { signal: new AbortController().signal };
  assert.equal(await approvals.ask({ chatId: 10 }, { command: 'x'.repeat(3000), choices: ['once'] }, opts), 'deny');
  assert.equal(await approvals.ask({ chatId: 10 }, { command: 'read', smart_denied: true, choices: ['once'] }, opts), 'deny');
  assert.equal(sends, 1);
});

test('stalled Telegram delivery or button cleanup cannot prevent cancellation', async () => {
  const { createApprovals } = require('../channels/telegram-approvals');
  for (const stalled of ['send', 'cleanup']) {
    let release;
    const hung = new Promise(resolve => { release = resolve; });
    const bot = {
      sendMessage: async () => stalled === 'send' ? hung : { message_id: 1 },
      editMessageReplyMarkup: async () => stalled === 'cleanup' ? hung : undefined,
      answerCallbackQuery: async () => {},
    };
    const controller = new AbortController();
    const result = createApprovals(bot).ask({ chatId: 1, userId: '1' }, { command: 'read', choices: ['once'] }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    try {
      assert.equal(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('stuck'), 30))]), 'deny', stalled);
    } finally { release({ message_id: 1 }); await result; }
  }
});
