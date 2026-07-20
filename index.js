/**
 * TVM digital HQ entry point.
 * Runs the WhatsApp + Telegram assistants, protected admin API, public enquiry
 * capture, health monitoring, and the daily WITA briefing.
 */
'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const cron = require('node-cron');
const notion = require('./notion');
const assistant = require('./assistant');
const brain = require('./brain');
const villaData = require('./villa-data');
const whatsapp = require('./channels/whatsapp');
const telegram = require('./channels/telegram');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'afni';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const SESSION_COOKIE = 'tvm_admin';
const SESSION_AGE_SECONDS = 60 * 60 * 8;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ENQUIRIES_FILE = path.join(DATA_DIR, 'enquiries.json');
const ADMIN_DIR = path.join(__dirname, 'admin');
const loginAttempts = new Map();
let enquiryWriteQueue = Promise.resolve();

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function sendHtml(res, fileName, status = 200) {
  try {
    const html = await fs.readFile(path.join(ADMIN_DIR, fileName));
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  } catch (error) {
    console.error('[HTTP] Admin file error:', error.message);
    sendJson(res, 500, { error: 'Admin interface unavailable.' });
  }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySession(token) {
  if (!token || !ADMIN_SESSION_SECRET || !token.includes('.')) return false;
  const [encoded, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.user === ADMIN_USERNAME && payload.exp > Date.now();
  } catch (_) {
    return false;
  }
}

function isAuthenticated(req) {
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

function sessionCookie(value, maxAge = SESSION_AGE_SECONDS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > limit) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function clean(value, max = 500) {
  return String(value || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

async function readEnquiries() {
  try {
    return JSON.parse(await fs.readFile(ENQUIRIES_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function saveEnquiry(input, req) {
  enquiryWriteQueue = enquiryWriteQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const enquiries = await readEnquiries();
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      source: clean(input.source, 40) || 'tvm',
      business: clean(input.business, 100),
      name: clean(input.name, 120),
      email: clean(input.email, 160),
      phone: clean(input.phone, 80),
      message: clean(input.message, 2000),
      status: 'new',
      ip: clean((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 80),
    };
    enquiries.unshift(record);
    const next = enquiries.slice(0, 500);
    const temp = `${ENQUIRIES_FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temp, ENQUIRIES_FILE);
    return record;
  });
  return enquiryWriteQueue;
}

function loginRateLimited(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter(time => now - time < 15 * 60 * 1000);
  loginAttempts.set(ip, recent);
  return recent.length >= 5;
}

function recordLoginFailure(ip) {
  loginAttempts.set(ip, [...(loginAttempts.get(ip) || []), Date.now()]);
}

async function adminOverview() {
  const results = await Promise.allSettled([
    notion.getTasks(),
    notion.getProjects(),
    notion.getPayments(),
    readEnquiries(),
    villaData.getAll(),
  ]);
  const value = (index, fallback = []) => results[index].status === 'fulfilled' ? results[index].value : fallback;
  return {
    generatedAt: new Date().toISOString(),
    tasks: value(0),
    projects: value(1),
    payments: value(2),
    enquiries: value(3),
    villaData: value(4, { villas: [], tenancies: [], installments: [], deposits: [], documents: [] }),
    bots: { whatsapp: whatsapp.getStatus(), telegram: telegram.getStatus() },
    errors: results.map((result, index) => result.status === 'rejected'
      ? ['tasks', 'projects', 'payments', 'enquiries', 'villa records'][index]
      : null).filter(Boolean),
  };
}

async function handlePublicEnquiry(req, res) {
  const body = await readBody(req);
  const name = clean(body.name, 120);
  const message = clean(body.message, 2000);
  const contact = clean(body.email || body.phone, 160);
  if (!name || !message || !contact) {
    return sendJson(res, 422, { error: 'Name, message, and email or phone are required.' });
  }
  const record = await saveEnquiry(body, req);
  return sendJson(res, 201, { ok: true, id: record.id });
}

async function handleAdminApi(req, res, url) {
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = clean((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 80);
    if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) {
      return sendJson(res, 503, { error: 'Admin access has not been configured.' });
    }
    if (loginRateLimited(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readBody(req);
    if (!safeEqual(body.username || '', ADMIN_USERNAME) || !safeEqual(body.password || '', ADMIN_PASSWORD)) {
      recordLoginFailure(ip);
      return sendJson(res, 401, { error: 'Incorrect username or password.' });
    }
    loginAttempts.delete(ip);
    const token = signSession({ user: ADMIN_USERNAME, exp: Date.now() + SESSION_AGE_SECONDS * 1000, nonce: crypto.randomUUID() });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (!isAuthenticated(req)) return sendJson(res, 401, { error: 'Authentication required.' });

  if (url.pathname === '/api/admin/session' && req.method === 'GET') {
    return sendJson(res, 200, { authenticated: true, user: ADMIN_USERNAME });
  }
  if (url.pathname === '/api/admin/overview' && req.method === 'GET') {
    return sendJson(res, 200, await adminOverview());
  }
  if (url.pathname === '/api/admin/tasks' && req.method === 'POST') {
    const body = await readBody(req);
    if (!clean(body.name, 200)) return sendJson(res, 422, { error: 'Task name is required.' });
    const task = await notion.createTask({
      name: clean(body.name, 200),
      priority: ['High', 'Mid', 'Low'].includes(body.priority) ? body.priority : 'Mid',
      dueDate: clean(body.dueDate, 20) || undefined,
      projectId: clean(body.projectId, 80) || undefined,
    });
    return sendJson(res, 201, { ok: true, task });
  }
  if (url.pathname === '/api/admin/tasks/complete' && req.method === 'POST') {
    const body = await readBody(req);
    await notion.completeTaskById(clean(body.id, 80));
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/payments/paid' && req.method === 'POST') {
    const body = await readBody(req);
    await notion.markPaymentPaidById(clean(body.id, 80));
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/records' && req.method === 'POST') {
    const body = await readBody(req);
    const collection = clean(body.collection, 40);
    if (!['villas', 'tenancies', 'installments', 'deposits', 'documents'].includes(collection)) {
      return sendJson(res, 422, { error: 'Unknown record type.' });
    }
    const record = collection === 'tenancies'
      ? await villaData.createTenancyBundle(body.record || {})
      : await villaData.upsert(collection, body.record || {});
    return sendJson(res, 201, { ok: true, record });
  }
  if (url.pathname === '/api/admin/bots/whatsapp/pair' && req.method === 'POST') {
    const body = await readBody(req);
    const phone = clean(body.phone, 30).replace(/\D/g, '');
    if (phone.length < 9) return sendJson(res, 422, { error: 'Enter the WhatsApp number with country code.' });
    return sendJson(res, 200, await whatsapp.requestPairingCode(phone));
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok', version: '5.1.0',
        whatsapp: whatsapp.isConnected(), telegram: telegram.isRunning(),
        uptime: Math.floor(process.uptime()),
      });
    }
    if (url.pathname === '/api/public/enquiries' && req.method === 'POST') {
      return await handlePublicEnquiry(req, res);
    }
    if (url.pathname.startsWith('/api/admin/')) {
      return await handleAdminApi(req, res, url);
    }
    if ((url.pathname === '/admin/login' || url.pathname === '/admin/login/') && req.method === 'GET') {
      if (isAuthenticated(req)) return redirect(res, '/admin/');
      return await sendHtml(res, 'login.html');
    }
    if ((url.pathname === '/admin' || url.pathname === '/admin/') && req.method === 'GET') {
      if (!isAuthenticated(req)) return redirect(res, '/admin/login');
      return await sendHtml(res, 'index.html');
    }
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error('[HTTP] Request failed:', error.message);
    const status = error.message === 'Request too large' ? 413 : 500;
    return sendJson(res, status, { error: status === 500 ? 'Request failed.' : error.message });
  }
});

async function sendMorningDMs() {
  console.log('[Cron] Sending morning DMs...');
  for (const userKey of ['afni', 'syifa']) {
    try {
      const briefing = await brain.buildMorningDM(userKey);
      const villaActions = await villaData.getActionSummary();
      const message = [briefing, villaActions].filter(Boolean).join('\n\n');
      if (!message) continue;
      const user = brain.USERS[userKey];
      const waSent = await whatsapp.sendToPhone(user.phone, message);
      const tgSent = user.telegramId ? await telegram.sendToChat(user.telegramId, message) : false;
      console.log(`[Cron] ${user.name}: WA=${waSent} TG=${tgSent}`);
    } catch (error) {
      console.error(`[Cron] ${userKey} morning DM failed:`, error.message);
    }
  }
}

async function deliverDueReminders() {
  try {
    const due = await assistant.collectDueReminders();
    for (const reminder of due) {
      const user = brain.USERS[reminder.userKey];
      if (!user) continue;
      const message = `⏰ *Reminder:* ${reminder.text}`;
      const waSent = await whatsapp.sendToPhone(user.phone, message).catch(() => false);
      const tgSent = user.telegramId ? await telegram.sendToChat(user.telegramId, message).catch(() => false) : false;
      console.log(`[Reminder] ${user.name}: "${reminder.text}" WA=${waSent} TG=${tgSent}`);
    }
  } catch (error) {
    console.error('[Reminder] Delivery failed:', error.message);
  }
}

async function boot() {
  console.log('=== TVM Digital HQ v5.2 starting ===');
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  villaData.init(DATA_DIR);
  assistant.init(DATA_DIR);
  notion.init();
  brain.init();
  if (process.env.DISABLE_CHANNELS !== 'true') {
    await whatsapp.start();
    await telegram.start();
  }
  cron.schedule('0 9 * * *', sendMorningDMs, { timezone: 'Asia/Makassar' });
  cron.schedule('* * * * *', deliverDueReminders); // minute-level reminder delivery
  server.listen(PORT, '127.0.0.1', () => console.log(`[HTTP] http://127.0.0.1:${PORT}`));
  console.log('=== TVM Digital HQ v5.2 running ===');
}

boot().catch(error => {
  console.error('[FATAL]', error);
  process.exit(1);
});
