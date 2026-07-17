/**
 * index.js — TVMbot v4 entry point
 * Wires WhatsApp + Telegram + morning cron.
 * ~100 lines. That's the whole app.
 */
'use strict';

require('dotenv').config();

const cron = require('node-cron');
const notion = require('./notion');
const brain = require('./brain');
const whatsapp = require('./channels/whatsapp');
const telegram = require('./channels/telegram');

// ─── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  console.log('=== TVMbot v4 starting ===');

  // Init services
  notion.init();
  brain.init();
  console.log('[Boot] Notion + Brain ready');

  // Start channels
  await whatsapp.start();
  telegram.start();

  // Schedule morning DMs — 9:00 AM WITA (Asia/Makassar)
  cron.schedule('0 9 * * *', sendMorningDMs, { timezone: 'Asia/Makassar' });
  console.log('[Boot] Morning cron set: 9:00 AM WITA');

  console.log('=== TVMbot v4 running ===');
}

// ─── Morning DMs ───────────────────────────────────────────────────────────────

async function sendMorningDMs() {
  console.log('[Cron] Sending morning DMs...');

  // Afni
  try {
    const afniMsg = await brain.buildMorningDM('afni');
    if (afniMsg) {
      const user = brain.USERS.afni;
      const waSent = await whatsapp.sendToPhone(user.phone, afniMsg);
      const tgSent = user.telegramId
        ? await telegram.sendToChat(user.telegramId, afniMsg)
        : false;
      console.log(`[Cron] Afni: WA=${waSent} TG=${tgSent}`);
    }
  } catch (err) {
    console.error('[Cron] Afni morning DM failed:', err.message);
  }

  // Syifa
  try {
    const syifaMsg = await brain.buildMorningDM('syifa');
    if (syifaMsg) {
      const user = brain.USERS.syifa;
      const waSent = await whatsapp.sendToPhone(user.phone, syifaMsg);
      const tgSent = user.telegramId
        ? await telegram.sendToChat(user.telegramId, syifaMsg)
        : false;
      console.log(`[Cron] Syifa: WA=${waSent} TG=${tgSent}`);
    }
  } catch (err) {
    console.error('[Cron] Syifa morning DM failed:', err.message);
  }
}

// ─── Health endpoint (optional — for PM2 monitoring) ───────────────────────────

const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '4.0.0',
      whatsapp: whatsapp.isConnected(),
      telegram: telegram.isRunning(),
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[Health] http://localhost:${PORT}/health`);
});

// ─── Go ────────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
