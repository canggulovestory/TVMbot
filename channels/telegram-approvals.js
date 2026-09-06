'use strict';
const { randomBytes } = require('node:crypto');

function createApprovals(bot) {
  const pending = new Map();
  async function ask({ chatId, userId }, event, { signal }) {
    const command = String(event.command || '');
    // Never ask someone to approve an incomplete command or override a safety denial.
    if (signal.aborted || event.smart_denied || !event.choices?.includes('once') || !command || command.length > 2500) return 'deny';
    const token = randomBytes(12).toString('hex');
    let finish;
    const decision = new Promise(resolve => { finish = resolve; });
    const record = { chatId: String(chatId), userId: String(userId), finish, messageId: null };
    pending.set(token, record);
    const abort = () => finish('deny');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 90000);
    const clearButtons = () => {
      if (record.messageId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: record.messageId }).catch(() => {});
    };
    try {
      const delivery = bot.sendMessage(chatId,
        `Zuzu needs permission for this action. Review the full command below. Approving allows this action once; it does not grant permanent access.\n\n${command}\n\nExpires in 90 seconds.`,
        { reply_markup: { inline_keyboard: [[
          { text: 'Approve once', callback_data: `za:${token}:once` },
          { text: 'Deny', callback_data: `za:${token}:deny` },
        ]] } }).then(sent => {
        record.messageId = sent.message_id;
        if (!pending.has(token)) clearButtons();
        return decision;
      });
      if (signal.aborted) finish('deny');
      return await Promise.race([delivery, decision]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      pending.delete(token);
      clearButtons();
    }
  }
  async function handle(query) {
    const match = /^za:([a-f0-9]{24}):(once|deny)$/.exec(query.data || '');
    if (!match) return false;
    const item = pending.get(match[1]);
    const valid = item && query.message?.chat?.type === 'private'
      && item.userId === String(query.from?.id) && item.chatId === String(query.message.chat.id)
      && item.messageId === query.message.message_id;
    if (valid) {
      pending.delete(match[1]);
      item.finish(match[2]);
    }
    await bot.answerCallbackQuery(query.id, { text: valid ? 'Decision received.' : 'This approval is expired or belongs to another request.' }).catch(() => {});
    return Boolean(valid);
  }
  return { ask, handle };
}

module.exports = { createApprovals };
