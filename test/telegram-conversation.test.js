'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('Telegram keeps a second message queued and carries the authenticated approval callback', async () => {
  const apiPath = require.resolve('node-telegram-bot-api');
  require(apiPath);
  const originalApi = require.cache[apiPath].exports;
  const brain = require('../brain');
  const originalProcess = brain.processMessage, originalAllowed = brain.isAllowed;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const handlers = {}, calls = [], sent=[];
  class FakeTelegram {
    async getMe() { return { username: 'test' }; }
    on(name, fn) { handlers[name] = fn; }
    async sendChatAction() {}
    async sendMessage(chatId,text,options) { sent.push({chatId,text,options});return { message_id: 1 }; }
  }
  require.cache[apiPath].exports = FakeTelegram;
  delete require.cache[require.resolve('../channels/telegram')];
  process.env.TELEGRAM_BOT_TOKEN = 'test-only';
  let release;
  const firstWait = new Promise(resolve => { release = resolve; });
  brain.isAllowed = () => true;
  brain.processMessage = async args => { calls.push(args); if (calls.length === 1) {await firstWait;return 'Done';}return 'Review: https://financial-ten-inky.vercel.app/?financeProposal=22222222-2222-4222-8222-222222222222'; };
  try {
    await require('../channels/telegram').start();
    const msg = text => ({ chat: { type: 'private', id: 1 }, from: { id: 1, first_name: 'Test' }, text });
    const first = handlers.message(msg('Plan tomorrow'));
    await new Promise(resolve => setImmediate(resolve));
    const second = handlers.message(msg('Get water heater'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    release(); await Promise.all([first, second]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].text, 'Get water heater');
    assert.equal(calls[1].telegramId, '1');
    assert.equal(calls[1].telegramMessage.text, 'Get water heater');
    assert.equal(calls[1].telegramMessage.from.id, 1);
    assert.equal(typeof calls[1].onApproval, 'function');
    assert.equal(sent[0].options.reply_markup,undefined);
    assert.deepEqual(sent[1].options.reply_markup.inline_keyboard,[[{text:'Review on Financial website',url:'https://financial-ten-inky.vercel.app/?financeProposal=22222222-2222-4222-8222-222222222222'}]]);
  } finally {
    release(); brain.processMessage = originalProcess; brain.isAllowed = originalAllowed;
    require.cache[apiPath].exports = originalApi;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});
