/**
 * channels/telegram.js — Telegram Bot API
 * Handles DMs only via node-telegram-bot-api.
 */
'use strict';

const TelegramBot = require('node-telegram-bot-api').default;
const brain = require('../brain');

let bot = null;
let running = false;
let botName = '';
let lastError = '';

async function start() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[TG] No TELEGRAM_BOT_TOKEN — Telegram disabled');
    lastError = 'Telegram token is not configured';
    return false;
  }

  bot = new TelegramBot(token, { polling: true });
  try {
    const profile = await bot.getMe();
    running = true;
    botName = profile.username || profile.first_name || '';
    lastError = '';
    console.log(`[TG] @${botName} started (polling)`);
  } catch (error) {
    running = false;
    lastError = error.message;
    console.error('[TG] Start failed:', error.message);
    try { await bot.stopPolling(); } catch (_) {}
    bot = null;
    return false;
  }

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
    running = false;
    lastError = err.message;
    console.error('[TG] Polling error:', err.code || err.message);
  });

  return true;
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

function isRunning() { return running; }

function getStatus() {
  return {
    configured: !!process.env.TELEGRAM_BOT_TOKEN,
    running,
    botName,
    lastError,
  };
}

module.exports = { start, sendToChat, isRunning, getStatus };
