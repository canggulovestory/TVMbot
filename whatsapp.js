// whatsapp.js — TVMbot WhatsApp Integration via Baileys
// Direct WhatsApp Web connection (no Meta API / no Twilio)
// QR scan once → session stored → persistent connection
//
// GROUP FILTERING — 2 layers:
//   Layer 1 (whatsapp-config.json): hardware allowlist — unknown groups are ignored before AI
//   Layer 2 (per-group rules): triggerKeywords / requireMention / respondToAll

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidGroup
} = require('@whiskeysockets/baileys');

const QRCode   = require('qrcode');
const path     = require('path');
const fs       = require('fs');
const { EventEmitter } = require('events');

// ── Config paths ──────────────────────────────────────────────────────────────
const SESSION_DIR   = '/data/whatsapp-session';
const CONFIG_PATH   = path.join(__dirname, 'whatsapp-config.json');
const BOT_NUMBER    = '+6282115111211';

// ── State ─────────────────────────────────────────────────────────────────────
let sock            = null;
let qrCodeBase64    = null;
let isConnected     = false;
let connectionState = 'disconnected';
let reconnectTimer  = null;

const emitter = new EventEmitter();
let _messageHandler = null;
let _voiceHandler = null;
function setMessageHandler(fn) { _messageHandler = fn; }
function setVoiceHandler(fn) { _voiceHandler = fn; }

// ── Load / reload config ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    log('Config not found or invalid — using open defaults');
    return { groupPolicy: 'all', groups: [], dmPolicy: 'all', settings: {} };
  }
}

// ── Layer 1: Is this group JID allowed? ───────────────────────────────────────
function isGroupAllowed(jid) {
  const cfg = loadConfig();
  if (cfg.groupPolicy !== 'allowlist') return true; // open policy
  const groups = cfg.groups || [];
  return groups.some(g => g.jid === jid && g.active !== false);
}

// ── Layer 2: Does this message pass per-group rules? ─────────────────────────
function passesGroupRules(jid, text) {
  const cfg = loadConfig();
  const groups = cfg.groups || [];
  const group = groups.find(g => g.jid === jid);

  if (!group) return false; // not in config = blocked

  // respondToAll overrides everything
  if (group.respondToAll) return true;

  const lc = text.toLowerCase();
  const botKeywords = (cfg.settings?.botMentionKeywords || ['@bot', 'agent']);

  // requireMention: only respond if @bot or agent keyword present
  if (group.requireMention) {
    if (!botKeywords.some(kw => lc.includes(kw.toLowerCase()))) return false;
  }

  // triggerKeywords: if set, message must contain at least one
  if (group.triggerKeywords && group.triggerKeywords.length > 0) {
    const hasKeyword = group.triggerKeywords.some(kw => lc.includes(kw.toLowerCase()));
    const hasBotMention = botKeywords.some(kw => lc.includes(kw.toLowerCase()));
    if (!hasKeyword && !hasBotMention) return false;
  }

  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[WhatsApp] ${msg}`); }

function getStatus() {
  const cfg = loadConfig();
  return {
    state: connectionState,
    connected: isConnected,
    qr: qrCodeBase64,
    botNumber: BOT_NUMBER,
    config: {
      groupPolicy: cfg.groupPolicy,
      groups: (cfg.groups || []).filter(g => g.jid),
      dmPolicy: cfg.dmPolicy
    }
  };
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    null
  );
}

// Extract quoted (replied-to) message text from Baileys message object
function extractQuotedText(msg) {
  const m = msg.message;
  if (!m) return null;
  const ctx = m.extendedTextMessage?.contextInfo;
  if (!ctx || !ctx.quotedMessage) return null;
  const q = ctx.quotedMessage;
  return (
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    null
  );
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function sendMessage(jid, text) {
  if (!isConnected || !sock) throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, { text });
}

async function sendToNumber(phoneNumber, text) {
  const digits = phoneNumber.replace(/\D/g, '');
  const jid = `${digits}@s.whatsapp.net`;
  await sendMessage(jid, text);
}

// Send a document/file via WhatsApp (PDF, DOCX, images, etc.)
async function sendDocument(jid, buffer, mimeType, fileName, caption = '') {
  if (!isConnected || !sock) throw new Error('WhatsApp not connected');
  const msg = {
    document: buffer,
    mimetype: mimeType,
    fileName: fileName,
  };
  if (caption) msg.caption = caption;
  await sock.sendMessage(jid, msg);
  log(`📎 Sent document: ${fileName} (${mimeType}) to ${jid}`);
}

// Send an image via WhatsApp
async function sendImage(jid, buffer, caption = '') {
  if (!isConnected || !sock) throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, {
    image: buffer,
    caption: caption || undefined,
  });
  log(`🖼️ Sent image to ${jid}`);
}

// ── Get list of joined groups ──────────────────────────────────────────────────
async function getGroups() {
  if (!isConnected || !sock) throw new Error('WhatsApp not connected');
  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.subject,
      participants: g.participants?.length || 0
    }));
  } catch (e) {
    log(`Could not fetch groups: ${e.message}`);
    return [];
  }
}

// ── Update group config (add/edit group rule) ─────────────────────────────────
function updateGroupConfig(jid, settings) {
  const cfg = loadConfig();
  if (!cfg.groups) cfg.groups = [];
  const idx = cfg.groups.findIndex(g => g.jid === jid);
  if (idx >= 0) {
    cfg.groups[idx] = { ...cfg.groups[idx], ...settings, jid };
  } else {
    cfg.groups.push({ jid, active: true, respondToAll: true, requireMention: false, triggerKeywords: [], ...settings });
  }
  // Remove _example placeholder
  cfg.groups = cfg.groups.filter(g => g.jid && !g._comment);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ── Connect ───────────────────────────────────────────────────────────────────
async function connect() {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    log(`Connecting with WA v${version.join('.')}`);
    connectionState = 'connecting';
    emitter.emit('state', connectionState);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['TVMbot', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      getMessage: async () => ({ conversation: '' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log('QR code received — scan now');
        connectionState = 'qr_ready';
        qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        emitter.emit('qr', qrCodeBase64);
        emitter.emit('state', connectionState);
      }

      if (connection === 'open') {
        log('✅ Connected to WhatsApp');
        isConnected     = true;
        connectionState = 'connected';
        qrCodeBase64    = null;
        emitter.emit('state', connectionState);
        emitter.emit('connected');
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      }

      if (connection === 'close') {
        isConnected     = false;
        connectionState = 'disconnected';
        emitter.emit('state', connectionState);

        const code = lastDisconnect?.error?.output?.statusCode;
        log(`Disconnected — code: ${code}`);

        if (code === DisconnectReason.loggedOut) {
          log('Logged out — clearing session');
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR, { recursive: true });
        }

        if (code !== 'INTENTIONAL_STOP') {
          log('Reconnecting in 5s…');
          reconnectTimer = setTimeout(connect, 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const cfg = loadConfig();

      for (const msg of messages) {
        if (msg.key.remoteJid === 'status@broadcast') continue;
        if (msg.key.fromMe) continue;

        const text = extractText(msg);
        const quotedText = extractQuotedText(msg);
        
        // ── Voice/Audio message handling ─────────────────────────────────────
        const m = msg.message;
        if (m && (m.audioMessage || m.pttMessage) && _voiceHandler) {
          const isGroup = isJidGroup(msg.key.remoteJid);
          const senderJid = isGroup ? (msg.key.participant || msg.participant) : msg.key.remoteJid;
          const senderPhone = senderJid?.split('@')[0] || 'unknown';
          const replyJid = isGroup ? msg.key.remoteJid : senderJid;
          
          try {
            log(`🎤 Voice note from +${senderPhone} (${(m.audioMessage || m.pttMessage).seconds || '?'}s)`);
            const reply = await _voiceHandler(msg, {
              senderPhone,
              isGroup,
              replyJid,
              quotedText
            });
            if (reply) await sendMessage(replyJid, reply);
          } catch(e) {
            log('Voice handler error: ' + e.message);
          }
          continue;
        }
        
        if (!text) continue;

        const isGroup   = isJidGroup(msg.key.remoteJid);
        const groupJid  = isGroup ? msg.key.remoteJid : null;
        const senderJid = isGroup
          ? (msg.key.participant || msg.participant)
          : msg.key.remoteJid;

        const senderPhone = senderJid?.split('@')[0] || 'unknown';

        // ── DM handling ──────────────────────────────────────────────────────
        if (!isGroup) {
          if (cfg.dmPolicy === 'none') {
            log(`DM from ${senderPhone} blocked by dmPolicy`);
            continue;
          }
          log(`📩 [DM] from +${senderPhone}: ${text.substring(0, 80)}`);
          if (_messageHandler) {
            try {
              const reply = await _messageHandler({
                text, senderPhone, isGroup: false, groupJid: null, replyJid: senderJid, quotedText
              });
              if (reply) await sendMessage(senderJid, reply);
            } catch (err) { log(`DM handler error: ${err.message}`); }
          }
          continue;
        }

        // ── Layer 1: Group allowlist check ───────────────────────────────────
        if (!isGroupAllowed(groupJid)) {
          log(`🚫 [Layer 1] Group ${groupJid} not in allowlist — ignored`);
          continue;
        }

        // ── Layer 2: Per-group message rules ─────────────────────────────────
        if (!passesGroupRules(groupJid, text)) {
          log(`🔕 [Layer 2] Group ${groupJid} — message filtered by group rules`);
          continue;
        }

        const groupName = (cfg.groups || []).find(g => g.jid === groupJid)?.name || groupJid;
        log(`📩 [GROUP: ${groupName}] from +${senderPhone}: ${text.substring(0, 80)}`);

        if (_messageHandler) {
          try {
            const reply = await _messageHandler({
              text, senderPhone, isGroup: true, groupJid, replyJid: groupJid, quotedText
            });
            if (reply) await sendMessage(groupJid, reply);
          } catch (err) { log(`Group handler error: ${err.message}`); }
        }
      }
    });

  } catch (err) {
    log(`Connection error: ${err.message}`);
    connectionState = 'disconnected';
    emitter.emit('state', connectionState);
    reconnectTimer = setTimeout(connect, 8000);
  }
}

async function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (sock) { await sock.logout().catch(() => {}); sock = null; }
  isConnected     = false;
  connectionState = 'disconnected';
  log('Disconnected by request');
}

async function resetSession() {
  await disconnect();
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  log('Session cleared — will show QR on next connect');
  setTimeout(connect, 1000);
}

module.exports = {
  connect, disconnect, resetSession,
  sendMessage, sendToNumber, sendDocument, sendImage,
  getStatus, getGroups,
  updateGroupConfig, loadConfig,
  setMessageHandler,
  setVoiceHandler, emitter
};
