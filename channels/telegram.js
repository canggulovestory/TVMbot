/**
 * channels/telegram.js — Telegram Bot API
 * Handles DMs only via node-telegram-bot-api.
 */
'use strict';

const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot = TelegramBotModule.default || TelegramBotModule; // package exports the class directly (CJS)
const brain = require('../brain');
const zuzuIntake = require('../zuzu-intake');
const googleWorkspace = require('../google-workspace');

let bot = null;
let running = false;
let botName = '';
let lastError = '';
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const staleBot = bot;
    try { await staleBot?.stopPolling(); } catch (_) {}
    if (bot === staleBot) bot = null;
    await start();
  }, 5000);
}

async function sendReply(chatId, text) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (error) {
    // A model reply can contain an accidental Markdown character. The message
    // is still useful, so retry as ordinary text instead of dropping it.
    await bot.sendMessage(chatId, text);
  }
}

function attachmentMeta(msg) {
  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  if (photo) return { fileId: photo.file_id, fileName: `telegram-photo-${msg.message_id || Date.now()}.jpg`, mimeType: 'image/jpeg', isImage: true };
  const document = msg.document;
  if (document) return { fileId: document.file_id, fileName: document.file_name || `telegram-file-${msg.message_id || Date.now()}`, mimeType: document.mime_type || '', isImage: false };
  return null;
}

async function downloadAttachment(meta) {
  const link = await bot.getFileLink(meta.fileId);
  const response = await fetch(link);
  if (!response.ok) throw new Error('Telegram file download failed');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > zuzuIntake.MAX_BYTES) throw new Error('Keep photos and files under 6 MB.');
  const mimeType = zuzuIntake.normalizeMimeType(meta.fileName, meta.mimeType || response.headers.get('content-type'));
  const item = await zuzuIntake.ingest({
    fileName: meta.fileName, mimeType, dataBase64: buffer.toString('base64'), uploadedBy: 'telegram',
    driveUpload: (await googleWorkspace.status().catch(() => ({ connected: false }))).connected ? googleWorkspace.uploadPrivateFile : null,
  });
  return { item, mimeType, dataUrl: (meta.isImage || mimeType.startsWith('image/')) ? `data:${mimeType};base64,${buffer.toString('base64')}` : '' };
}

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
    scheduleReconnect();
    return false;
  }

  bot.on('message', async (msg) => {
    let typing = null;
    try {
      // Only private chats (DMs)
      if (msg.chat.type !== 'private') return;
      const telegramId = String(msg.from.id);

      // Check allowlist
      if (!brain.isAllowed({ telegramId })) {
        console.log(`[TG] Blocked: ${telegramId}`);
        return;
      }

      const meta = attachmentMeta(msg);
      const caption = String(msg.text || msg.caption || '').trim();
      if (!caption && !meta) return;
      console.log(`[TG] ${msg.from.first_name}: ${caption.substring(0, 60) || `[${meta.isImage ? 'photo' : 'file'}]`}`);

      await bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      typing = setInterval(() => {
        bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      }, 4000);
      let attachment;
      let text = caption;
      if (meta) {
        const uploaded = await downloadAttachment(meta);
        attachment = uploaded.dataUrl ? { mimeType: uploaded.mimeType, dataUrl: uploaded.dataUrl } : null;
        const preview = uploaded.item.draft?.extractedPreview ? `\n\nExtracted document text:\n${uploaded.item.draft.extractedPreview.slice(0, 5000)}` : '';
        text = `${caption || `Please review this ${meta.isImage ? 'photo' : 'file'} and tell me the important details.`}\n\nAttached file: ${uploaded.item.fileName}${preview}`;
        await sendReply(msg.chat.id, `I received **${uploaded.item.fileName}** and added it to your private review inbox. I’m reviewing it now.`);
      }
      const reply = await brain.processMessage({ text, telegramId, attachment });
      clearInterval(typing);
      typing = null;
      if (reply) {
        await sendReply(msg.chat.id, reply);
      }
    } catch (err) {
      console.error('[TG] Message error:', err.message);
      try {
        await bot.sendMessage(msg.chat.id, 'Something went wrong. Try again.');
      } catch (_) {}
    } finally {
      if (typing) clearInterval(typing);
    }
  });

  bot.on('polling_error', (err) => {
    running = false;
    lastError = err.message;
    console.error('[TG] Polling error:', err.code || err.message);
    scheduleReconnect();
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
    try { await bot.sendMessage(chatId, text); return true; }
    catch (fallbackError) { console.error(`[TG] Send failed to ${chatId}:`, fallbackError.message); return false; }
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

module.exports = { start, sendToChat, isRunning, getStatus, attachmentMeta };
