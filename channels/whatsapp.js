/**
 * WhatsApp channel via Baileys.
 * Direct messages only, allowlisted users only, with pairing status exposed to
 * the protected admin HQ.
 */
'use strict';

const pino = require('pino');
const brain = require('../brain');

const baileysModule = import('baileys');

let sock = null;
let connected = false;
let starting = null;
let reconnectTimer = null;
let status = 'disconnected';
let lastError = '';
let lastConnectedAt = null;
let qrAvailable = false;
let pairingReadyPromise = Promise.resolve();
let pairingReadyResolve = null;

async function start() {
  if (starting) return starting;
  starting = createConnection().finally(() => { starting = null; });
  return starting;
}

async function createConnection() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, Browsers } = await baileysModule;
  clearTimeout(reconnectTimer);
  status = 'connecting';
  pairingReadyPromise = new Promise(resolve => {
    pairingReadyResolve = resolve;
    setTimeout(resolve, 5000);
  });
  const sessionPath = process.env.WA_SESSION_PATH || './wa-session';
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.macOS('Google Chrome'),
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'connecting' || qr) {
      pairingReadyResolve?.();
      pairingReadyResolve = null;
    }
    if (qr) {
      qrAvailable = true;
      status = 'pairing_required';
    }
    if (connection === 'open') {
      connected = true;
      qrAvailable = false;
      status = 'connected';
      lastError = '';
      lastConnectedAt = new Date().toISOString();
      console.log('[WA] Connected');
    }
    if (connection === 'close') {
      connected = false;
      sock = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      lastError = lastDisconnect?.error?.message || `Disconnected (${code || 'unknown'})`;
      if (code !== DisconnectReason.loggedOut) {
        status = 'reconnecting';
        console.log('[WA] Reconnecting in 5 seconds...');
        reconnectTimer = setTimeout(() => start().catch(error => {
          status = 'error';
          lastError = error.message;
        }), 5000);
      } else {
        status = 'logged_out';
        qrAvailable = false;
        // Stale credentials block re-pairing — clear them so the next
        // "Get pairing code" from Admin HQ starts a clean session.
        try {
          require('fs').rmSync(process.env.WA_SESSION_PATH || './wa-session', { recursive: true, force: true });
          console.log('[WA] Logged out — stale session cleared, pair again from Admin HQ');
        } catch (error) {
          console.log('[WA] Logged out — could not clear session:', error.message);
        }
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        if (jid.includes('@g.us') || jid.includes('@broadcast')) continue;
        const phone = jid.split('@')[0].split(':')[0];
        if (!brain.isAllowed({ phone })) {
          console.log(`[WA] Blocked: ${phone}`);
          continue;
        }
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || '';
        if (!text.trim()) continue;
        console.log(`[WA] ${phone}: ${text.substring(0, 60)}`);
        const reply = await brain.processMessage({ text, phone });
        if (reply) await sock.sendMessage(jid, { text: reply });
      } catch (error) {
        console.error('[WA] Message error:', error.message);
      }
    }
  });

  return true;
}

async function requestPairingCode(phone) {
  if (connected) return { connected: true, message: 'WhatsApp is already connected.' };
  if (!sock) await start();
  await pairingReadyPromise;
  if (!sock || typeof sock.requestPairingCode !== 'function') {
    throw new Error('Pairing is not ready. Restart the bot and try again.');
  }
  status = 'pairing_required';
  const code = await sock.requestPairingCode(String(phone).replace(/\D/g, ''));
  return {
    connected: false,
    pairingCode: String(code || '').match(/.{1,4}/g)?.join('-') || code,
    message: 'Open WhatsApp → Linked devices → Link with phone number, then enter this code.',
  };
}

async function sendToPhone(phone, text) {
  if (!sock || !connected) {
    console.log('[WA] Not connected — skipping send');
    return false;
  }
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
    return true;
  } catch (error) {
    lastError = error.message;
    console.error(`[WA] Send failed to ${phone}:`, error.message);
    return false;
  }
}

function isConnected() { return connected; }

function getStatus() {
  return { connected, status, qrAvailable, lastError, lastConnectedAt };
}

module.exports = { start, sendToPhone, isConnected, getStatus, requestPairingCode };
