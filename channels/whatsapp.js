/**
 * channels/whatsapp.js — WhatsApp via Baileys
 * Connects, handles DMs, sends messages. Zero group interaction.
 */
'use strict';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('baileys');
const pino = require('pino');
const brain = require('../brain');

let sock = null;
let connected = false;

async function start() {
  const sessionPath = process.env.WA_SESSION_PATH || './wa-session';
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: ['TVMbot', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connected = true;
      console.log('[WA] Connected');
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('[WA] Reconnecting...');
        setTimeout(start, 5000);
      } else {
        console.log('[WA] Logged out — delete wa-session and restart to re-scan QR');
      }
    }
  });

  // Handle incoming messages — DMs only, never groups
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;

        // BLOCK all groups — only process DMs
        if (jid.includes('@g.us') || jid.includes('@broadcast')) continue;

        // Extract sender phone
        const phone = jid.split('@')[0].split(':')[0];

        // Check allowlist
        if (!brain.isAllowed({ phone })) {
          console.log(`[WA] Blocked: ${phone}`);
          continue;
        }

        // Extract text
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!text.trim()) continue;

        console.log(`[WA] ${phone}: ${text.substring(0, 60)}`);

        // Process through brain
        const reply = await brain.processMessage({ text, phone });
        if (reply) {
          await sock.sendMessage(jid, { text: reply });
        }
      } catch (err) {
        console.error('[WA] Message error:', err.message);
      }
    }
  });
}

async function sendToPhone(phone, text) {
  if (!sock || !connected) {
    console.log('[WA] Not connected — skipping send');
    return false;
  }
  try {
    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error(`[WA] Send failed to ${phone}:`, err.message);
    return false;
  }
}

function isConnected() { return connected; }

module.exports = { start, sendToPhone, isConnected };
