/**
 * channels/telegram.js — Telegram Bot API
 * Handles DMs only via node-telegram-bot-api.
 */
'use strict';

const TelegramBot = require('node-telegram-bot-api');
const brain = require('../brain');

let bot = null;

function start() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[TG] No TELEGRAM_BOT_TOKEN — Telegram disabled');
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log('[TG] Bot started (polling)');

  bot.on('message', async (msg) => {
    try {
      // Only private chats (DMs)
      if (msg.chat.type !== 'private') return;
      if (!msg.text) return;

      const telegramId = String(msg.from.id);

      // Check allowlist
      if (!brain.isAllowed({ telegramId })) {
        console.log(`[TG] Blocked: ${telegramId}`);
        return;
      }

      console.log(`[TG] ${msg.from.first_name}: ${msg.text.substring(0, 60)}`);

      const reply = await brain.processMessage({ text: msg.text, telegramId });
      if (reply) {
        await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error('[TG] Message error:', err.message);
      try {
        await bot.sendMessage(msg.chat.id, 'Something went wrong. Try again.');
      } catch (_) {}
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[TG] Polling error:', err.code || err.message);
  });
}

async function sendToChat(chatId, text) {
  if (!bot) {
    console.log('[TG] Bot not running — skipping send');
    return false;
  }
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    return true;
  } catch (err) {
    console.error(`[TG] Send failed to ${chatId}:`, err.message);
    return false;
  }
}

function isRunning() { return !!bot; }

module.exports = { start, sendToChat, isRunning };
