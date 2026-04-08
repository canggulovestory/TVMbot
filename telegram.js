// telegram.js — TVMbot Telegram Channel Integration
// Same AI brain as WhatsApp, parallel channel support
// Uses Telegram Bot API via HTTPS (no extra dependencies needed)

const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// ── State ─────────────────────────────────────────────────────────────────────
let botToken = null;
let botInfo = null;
let isPolling = false;
let pollOffset = 0;
let _messageHandler = null;
let _voiceHandler = null;
const emitter = new EventEmitter();

// ── Telegram API Helpers ──────────────────────────────────────────────────────
function apiCall(method, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok) resolve(parsed.result);
          else reject(new Error(parsed.description || 'Telegram API error'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Send message (with auto-split for long messages) ──────────────────────────
async function sendMessage(chatId, text, options = {}) {
  // Telegram max is 4096 chars per message
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_LEN) {
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);

  let lastResult;
  for (const chunk of chunks) {
    lastResult = await apiCall('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: options.parse_mode || 'Markdown',
      ...options
    }).catch(async (e) => {
      // If Markdown fails, retry without parse_mode
      if (e.message && e.message.includes("can't parse")) {
        return apiCall('sendMessage', { chat_id: chatId, text: chunk });
      }
      throw e;
    });
  }
  return lastResult;
}

// ── Download file from Telegram ───────────────────────────────────────────────
async function downloadFile(fileId) {
  const file = await apiCall('getFile', { file_id: fileId });
  const filePath = file.file_path;
  
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), filePath }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Long Polling ──────────────────────────────────────────────────────────────
async function startPolling() {
  if (!botToken) {
    console.log('[Telegram] No bot token configured — skipping');
    return;
  }

  try {
    botInfo = await apiCall('getMe');
    console.log(`[Telegram] Connected as @${botInfo.username} (${botInfo.first_name})`);
    isPolling = true;
  } catch(e) {
    console.error('[Telegram] Failed to connect:', e.message);
    return;
  }

  poll();
}

async function poll() {
  if (!isPolling) return;

  try {
    const updates = await apiCall('getUpdates', {
      offset: pollOffset,
      timeout: 30,
      allowed_updates: ['message']
    });

    for (const update of updates) {
      pollOffset = update.update_id + 1;
      if (update.message) {
        handleUpdate(update.message).catch(e => 
          console.error('[Telegram] Handler error:', e.message)
        );
      }
    }
  } catch(e) {
    if (!e.message?.includes('ETIMEDOUT')) {
      console.error('[Telegram] Poll error:', e.message);
    }
    // Wait before retrying on error
    await new Promise(r => setTimeout(r, 5000));
  }

  // Continue polling
  setImmediate(poll);
}

// ── Message Handler ───────────────────────────────────────────────────────────
async function handleUpdate(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id?.toString() || chatId.toString();
  const userName = msg.from?.first_name || 'User';
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const text = msg.text || msg.caption || '';
  
  // Handle voice/audio messages
  if (msg.voice || msg.audio) {
    const fileId = (msg.voice || msg.audio).file_id;
    const duration = (msg.voice || msg.audio).duration || 0;
    
    if (_voiceHandler) {
      try {
        const { buffer, filePath } = await downloadFile(fileId);
        const reply = await _voiceHandler({
          buffer,
          filePath,
          duration,
          caption: text,
          userId: `tg_${userId}`,
          chatId: chatId.toString(),
          userName,
          isGroup,
          channel: 'telegram'
        });
        if (reply) await sendMessage(chatId, reply);
      } catch(e) {
        console.error('[Telegram] Voice handler error:', e.message);
        await sendMessage(chatId, 'Sorry, I could not process that voice message.');
      }
    } else {
      await sendMessage(chatId, 'Voice message processing is not yet configured.');
    }
    return;
  }

  // Skip non-text messages (stickers, etc)
  if (!text) return;

  // In groups, only respond when mentioned or replied to
  if (isGroup) {
    const botMention = botInfo ? `@${botInfo.username}` : '@tvmbot';
    const isReplyToBot = msg.reply_to_message?.from?.id === botInfo?.id;
    if (!text.includes(botMention) && !isReplyToBot) return;
  }

  // Handle /start command
  if (text === '/start') {
    await sendMessage(chatId, 
      `Hi ${userName}! I'm TVMbot, your AI villa management assistant.\n\n` +
      `I can help with bookings, finances, maintenance, documents, and much more.\n\n` +
      `Just type your question or command and I'll handle it!`
    );
    return;
  }

  // Handle /reset command  
  if (text === '/reset') {
    await sendMessage(chatId, 'Session reset! Starting fresh.');
    return;
  }

  // Route to AI handler
  if (_messageHandler) {
    try {
      // Show "typing" indicator
      apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      
      const reply = await _messageHandler({
        text: text.replace(/@\w+/g, '').trim(), // Remove @mentions
        senderPhone: `tg_${userId}`,
        senderName: userName,
        isGroup,
        groupJid: isGroup ? `tg_group_${chatId}` : null,
        replyJid: chatId.toString(),
        quotedText: msg.reply_to_message?.text || null,
        channel: 'telegram',
        chatId: chatId.toString()
      });
      
      if (reply) {
        // Convert WhatsApp formatting to Telegram Markdown
        let tgReply = reply
          .replace(/\*([^*]+)\*/g, '*$1*') // Bold stays the same in Markdown
          .replace(/_([^_]+)_/g, '_$1_');   // Italic stays the same
        await sendMessage(chatId, tgReply);
      }
    } catch(e) {
      console.error('[Telegram] AI error:', e.message);
      await sendMessage(chatId, 'Sorry, something went wrong. Please try again.');
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function setMessageHandler(fn) { _messageHandler = fn; }
function setVoiceHandler(fn) { _voiceHandler = fn; }
function isConnected() { return isPolling && !!botInfo; }

function getStatus() {
  return {
    connected: isPolling && !!botInfo,
    username: botInfo?.username || null,
    firstName: botInfo?.first_name || null,
    botId: botInfo?.id || null
  };
}

function init(token) {
  if (!token) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN — Telegram channel disabled');
    return false;
  }
  botToken = token;
  return true;
}

async function connect() {
  if (!botToken) return false;
  await startPolling();
  return isPolling;
}

function disconnect() {
  isPolling = false;
  botInfo = null;
  console.log('[Telegram] Disconnected');
}

module.exports = {
  init,
  connect,
  disconnect,
  sendMessage,
  downloadFile,
  setMessageHandler,
  setVoiceHandler,
  isConnected,
  getStatus,
  emitter
};
