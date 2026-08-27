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
const QRCode = require('qrcode');
const cron = require('node-cron');
const notion = require('./notion');
const assistant = require('./assistant');
const authUsers = require('./auth-users');
const audit = require('./audit');
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
  if (!token || !ADMIN_SESSION_SECRET || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch (_) {
    return null;
  }
}

/** Returns the session payload {user, role, name} or null. Revokes sessions of deleted users. */
async function getSession(req) {
  const payload = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!payload) return null;
  if (!(await authUsers.exists(payload.user))) return null;
  return payload;
}

async function isAuthenticated(req) {
  return !!(await getSession(req));
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

function isoDateInDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
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
  const task = enquiryWriteQueue.then(async () => {
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
      leadType: clean(input.leadType, 40) || 'General',
      villaName: clean(input.villaName, 160),
      rentalTerm: clean(input.rentalTerm, 60),
      moveInDate: clean(input.moveInDate || input.availableFrom, 20),
      budget: clean(input.budget, 80),
      projectTimeline: clean(input.projectTimeline, 100),
      preferredLanguage: clean(input.preferredLanguage, 30),
      utmSource: clean(input.utmSource, 100),
      utmMedium: clean(input.utmMedium, 100),
      utmCampaign: clean(input.utmCampaign, 160),
      landingPage: clean(input.landingPage, 500),
      assignee: '',
      nextFollowUp: clean(input.nextFollowUp, 20) || isoDateInDays(1),
      internalNotes: '',
      lastContactedAt: '',
      expectedValue: clean(input.expectedValue, 80),
      currency: ['IDR', 'USD'].includes(input.currency) ? input.currency : 'IDR',
      lostReason: '',
      status: 'New',
      ip: clean((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 80),
    };
    enquiries.unshift(record);
    const next = enquiries.slice(0, 500);
    const temp = `${ENQUIRIES_FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temp, ENQUIRIES_FILE);
    return record;
  });
  enquiryWriteQueue = task.catch(() => {}); // keep the queue healthy if a write fails
  return task;
}

const LEAD_STAGES = new Set(['New', 'Contacted', 'Qualified', 'Viewing', 'Negotiation', 'Won', 'Lost']);

function normalizeLeadStage(value) {
  const legacy = { new: 'New', replied: 'Contacted', won: 'Won', lost: 'Lost' };
  return legacy[String(value || '').toLowerCase()] || (LEAD_STAGES.has(value) ? value : 'New');
}

function updateEnquiry(input) {
  const task = enquiryWriteQueue.then(async () => {
    const enquiries = await readEnquiries();
    const record = enquiries.find(item => item.id === clean(input.id, 80));
    if (!record) return null;
    record.status = normalizeLeadStage(input.status || record.status);
    if ('assignee' in input) record.assignee = clean(input.assignee, 100);
    if ('nextFollowUp' in input) record.nextFollowUp = clean(input.nextFollowUp, 20);
    if ('budget' in input) record.budget = clean(input.budget, 80);
    if ('rentalTerm' in input) record.rentalTerm = clean(input.rentalTerm, 60);
    if ('moveInDate' in input) record.moveInDate = clean(input.moveInDate, 20);
    if ('internalNotes' in input) record.internalNotes = clean(input.internalNotes, 2000);
    if ('expectedValue' in input) record.expectedValue = clean(input.expectedValue, 80);
    if ('currency' in input) record.currency = ['IDR', 'USD'].includes(input.currency) ? input.currency : (record.currency || 'IDR');
    if ('lostReason' in input) record.lostReason = clean(input.lostReason, 500);
    if (record.status !== 'New' && !record.lastContactedAt) record.lastContactedAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    const temp = `${ENQUIRIES_FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(enquiries, null, 2), { mode: 0o600 });
    await fs.rename(temp, ENQUIRIES_FILE);
    return record;
  });
  enquiryWriteQueue = task.catch(() => {});
  return task;
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
    villaData: value(4, { villas: [], tenancies: [], installments: [], deposits: [], documents: [], transactions: [], villaTasks: [] }),
    bots: { whatsapp: whatsapp.getStatus(), telegram: telegram.getStatus() },
    errors: results.map((result, index) => result.status === 'rejected'
      ? ['tasks', 'projects', 'payments', 'enquiries', 'villa records'][index]
      : null).filter(Boolean),
  };
}

const enquiryHits = new Map();
function enquiryRateLimited(ip) {
  const now = Date.now();
  const recent = (enquiryHits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
  recent.push(now);
  enquiryHits.set(ip, recent);
  if (enquiryHits.size > 5000) enquiryHits.clear(); // memory guard
  return recent.length > 10;
}

async function handlePublicEnquiry(req, res) {
  const ip = clean((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 80);
  if (enquiryRateLimited(ip)) return sendJson(res, 429, { error: 'Too many submissions. Please try again later.' });
  const body = await readBody(req);
  const name = clean(body.name, 120);
  const message = clean(body.message, 2000);
  const contact = clean(body.email || body.phone, 160);
  if (!name || !message || !contact) {
    return sendJson(res, 422, { error: 'Name, message, and email or phone are required.' });
  }
  const record = await saveEnquiry(body, req);
  // Alerts are best-effort: a saved lead must never depend on a chat channel being online.
  void notifyNewLead(record).catch(error => console.error('[Lead] alert failed:', error.message));
  return sendJson(res, 201, { ok: true, id: record.id });
}

async function notifyNewLead(lead) {
  const user = brain.USERS.afni;
  if (!user) return;
  const contact = lead.phone || lead.email || 'No contact provided';
  const details = [lead.rentalTerm, lead.moveInDate, lead.budget, lead.projectTimeline].filter(Boolean).join(' · ');
  const message = [
    '✦ *New lead*',
    `*${lead.leadType || 'General'}* — ${lead.name || 'Unknown'}`,
    `${lead.business || lead.source || 'Website'}`,
    contact,
    details || null,
    lead.message ? `_${lead.message.slice(0, 500)}_` : null,
    'Open TVM HQ → Leads to qualify and schedule follow-up.',
  ].filter(Boolean).join('\n');
  const [wa, tg] = await Promise.allSettled([
    Promise.resolve().then(() => whatsapp.sendToPhone(user.phone, message)),
    user.telegramId ? Promise.resolve().then(() => telegram.sendToChat(user.telegramId, message)) : Promise.resolve(false),
  ]);
  console.log(`[Lead] ${lead.id} alert WA=${wa.status === 'fulfilled' && wa.value} TG=${tg.status === 'fulfilled' && tg.value}`);
}

async function leadActionSummary() {
  const leads = await readEnquiries();
  const today = new Date().toISOString().slice(0, 10);
  const stage = value => normalizeLeadStage(value);
  const open = leads.filter(lead => !['Won', 'Lost'].includes(stage(lead.status)));
  const fresh = leads.filter(lead => stage(lead.status) === 'New').length;
  const followUps = open.filter(lead => lead.nextFollowUp && lead.nextFollowUp <= today);
  if (!fresh && !followUps.length) return '';
  return `✦ *Leads*\n${fresh} new · ${followUps.length} follow-up${followUps.length === 1 ? '' : 's'} due today\n` +
    followUps.slice(0, 5).map(lead => `• ${lead.name || 'Unnamed'} — ${lead.leadType || 'General'}`).join('\n');
}

async function handleAdminApi(req, res, url) {
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = clean((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 80);
    if (!ADMIN_SESSION_SECRET) {
      return sendJson(res, 503, { error: 'Admin access has not been configured.' });
    }
    if (loginRateLimited(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readBody(req);
    const account = await authUsers.verify(body.username, body.password);
    if (!account) {
      recordLoginFailure(ip);
      return sendJson(res, 401, { error: 'Incorrect username or password.' });
    }
    loginAttempts.delete(ip);
    const token = signSession({ user: account.username, role: account.role, name: account.name, villaIds: account.villaIds || [], exp: Date.now() + SESSION_AGE_SECONDS * 1000, nonce: crypto.randomUUID() });
    audit.add(account.username, 'signed in', `role ${account.role}`);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const session = await getSession(req);
  if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
  if (session.role === 'owner') return sendJson(res, 403, { error: 'Owner accounts use the owner portal at /owner.' });
  const requireAdmin = () => session.role === 'admin';

  if (url.pathname === '/api/admin/session' && req.method === 'GET') {
    return sendJson(res, 200, { authenticated: true, user: session.user, role: session.role, name: session.name });
  }
  if (url.pathname === '/api/admin/overview' && req.method === 'GET') {
    const overview = await adminOverview();
    overview.session = { user: session.user, role: session.role, name: session.name };
    return sendJson(res, 200, overview);
  }

  // ── Team management (admin only) ──
  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    if (!requireAdmin()) return sendJson(res, 403, { error: 'Admin only.' });
    return sendJson(res, 200, await authUsers.listUsers());
  }
  if (url.pathname === '/api/admin/users' && req.method === 'POST') {
    if (!requireAdmin()) return sendJson(res, 403, { error: 'Admin only.' });
    const body = await readBody(req);
    try {
      const user = await authUsers.addUser(body);
      audit.add(session.user, 'added user', `${user.username} (${user.role})`);
      return sendJson(res, 201, { ok: true, user });
    } catch (error) { return sendJson(res, 422, { error: error.message }); }
  }
  if (url.pathname === '/api/admin/users/delete' && req.method === 'POST') {
    if (!requireAdmin()) return sendJson(res, 403, { error: 'Admin only.' });
    const body = await readBody(req);
    if (clean(body.username, 40).toLowerCase() === session.user) return sendJson(res, 422, { error: 'You cannot delete your own account.' });
    try {
      const removed = await authUsers.removeUser(body.username);
      if (!removed) return sendJson(res, 404, { error: 'User not found.' });
      audit.add(session.user, 'removed user', removed.username);
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendJson(res, 422, { error: error.message }); }
  }
  if (url.pathname === '/api/admin/users/password' && req.method === 'POST') {
    const body = await readBody(req);
    const target = clean(body.username, 40).toLowerCase() || session.user;
    if (target !== session.user && !requireAdmin()) return sendJson(res, 403, { error: 'Admin only.' });
    try {
      await authUsers.changePassword(target, body.password);
      audit.add(session.user, 'changed password', target === session.user ? 'own account' : `for ${target}`);
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendJson(res, 422, { error: error.message }); }
  }
  if (url.pathname === '/api/admin/audit' && req.method === 'GET') {
    if (!requireAdmin()) return sendJson(res, 403, { error: 'Admin only.' });
    return sendJson(res, 200, await audit.list(300));
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
    audit.add(session.user, 'added task', task.name);
    return sendJson(res, 201, { ok: true, task });
  }
  if (url.pathname === '/api/admin/tasks/complete' && req.method === 'POST') {
    const body = await readBody(req);
    await notion.completeTaskById(clean(body.id, 80));
    audit.add(session.user, 'completed task', clean(body.id, 80));
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/payments/paid' && req.method === 'POST') {
    const body = await readBody(req);
    await notion.markPaymentPaidById(clean(body.id, 80));
    audit.add(session.user, 'marked legacy payment paid', clean(body.id, 80));
    return sendJson(res, 200, { ok: true });
  }
  const RECORD_TYPES = ['villas', 'tenancies', 'installments', 'deposits', 'documents', 'transactions', 'villaTasks'];
  if (url.pathname === '/api/admin/records' && req.method === 'POST') {
    const body = await readBody(req);
    const collection = clean(body.collection, 40);
    if (!RECORD_TYPES.includes(collection)) {
      return sendJson(res, 422, { error: 'Unknown record type.' });
    }
    try {
      const record = collection === 'tenancies'
        ? await villaData.createTenancyBundle(body.record || {})
        : await villaData.upsert(collection, body.record || {});
      // Auto-book rent income when an installment is marked Paid
      if (collection === 'installments' && record.status === 'Paid') {
        await villaData.recordPaymentIncome(record).catch(err => console.error('[Finance] auto-income failed:', err.message));
      }
      audit.add(session.user, `saved ${collection.slice(0, -1)}`, record.name || record.guestName || record.title || record.code || record.description || record.id);
      return sendJson(res, 201, { ok: true, record });
    } catch (error) {
      if (error.statusCode === 409) return sendJson(res, 409, { error: error.message });
      throw error;
    }
  }
  if (url.pathname === '/api/admin/enquiries/status' && req.method === 'POST') {
    const body = await readBody(req);
    if (!LEAD_STAGES.has(body.status)) return sendJson(res, 422, { error: 'Invalid lead stage.' });
    const updated = await updateEnquiry(body);
    if (!updated) return sendJson(res, 404, { error: 'Enquiry not found.' });
    audit.add(session.user, 'lead stage', `${updated.name || updated.id} -> ${updated.status}`);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/enquiries/update' && req.method === 'POST') {
    const updated = await updateEnquiry(await readBody(req));
    if (!updated) return sendJson(res, 404, { error: 'Lead not found.' });
    audit.add(session.user, 'updated lead', updated.name || updated.id);
    return sendJson(res, 200, { ok: true, lead: updated });
  }
  if (url.pathname === '/api/admin/villas/photo' && req.method === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024); // photos are bigger than JSON
    const id = clean(body.id, 80);
    const match = String(body.image || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s);
    if (!id || !match) return sendJson(res, 422, { error: 'Need villa id and a JPEG/PNG/WebP image.' });
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) return sendJson(res, 413, { error: 'Image too large — keep it under 5 MB.' });
    const fileName = `${id.replace(/[^\w-]/g, '')}.jpg`;
    const repoDir = path.join(__dirname, 'website', 'villa-photos');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, fileName), buffer);
    // Also copy straight into the live web root so it serves immediately
    await fs.mkdir('/root/tvm-website/villa-photos', { recursive: true }).catch(() => {});
    await fs.writeFile(`/root/tvm-website/villa-photos/${fileName}`, buffer).catch(() => {});
    const record = await villaData.upsert('villas', { id, photoUrl: `https://thevillamanagers.cloud/villa-photos/${fileName}` });
    audit.add(session.user, 'uploaded villa photo', record.name || id);
    return sendJson(res, 200, { ok: true, photoUrl: record.photoUrl });
  }
  if (url.pathname === '/api/admin/records/delete' && req.method === 'POST') {
    if (!requireAdmin()) return sendJson(res, 403, { error: 'Only admins can delete records.' });
    const body = await readBody(req);
    const collection = clean(body.collection, 40);
    if (!RECORD_TYPES.includes(collection)) {
      return sendJson(res, 422, { error: 'Unknown record type.' });
    }
    try {
      const removed = await villaData.remove(collection, clean(body.id, 80));
      if (!removed) return sendJson(res, 404, { error: 'Record not found.' });
      audit.add(session.user, `deleted ${collection.slice(0, -1)}`, removed.name || removed.guestName || removed.title || removed.code || removed.id);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error.statusCode === 409) return sendJson(res, 409, { error: error.message });
      throw error;
    }
  }
  if (url.pathname === '/api/admin/bots/whatsapp/pair' && req.method === 'POST') {
    const body = await readBody(req);
    const phone = clean(body.phone, 30).replace(/\D/g, '');
    if (phone.length < 9) return sendJson(res, 422, { error: 'Enter the WhatsApp number with country code.' });
    return sendJson(res, 200, await whatsapp.requestPairingCode(phone));
  }
  if (url.pathname === '/api/admin/bots/whatsapp/qr' && req.method === 'GET') {
    if (!requireAdmin()) return sendJson(res, 403, { error: 'Admin only.' });
    const pairing = await whatsapp.requestPairingQr();
    if (pairing.connected) return sendJson(res, 200, pairing);
    const qrDataUrl = await QRCode.toDataURL(pairing.qr, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
      color: { dark: '#1c1915', light: '#ffffff' },
    });
    return sendJson(res, 200, { ...pairing, qr: qrDataUrl });
  }
  if (url.pathname === '/api/admin/bots/whatsapp/disconnect' && req.method === 'POST') {
    if (!requireAdmin()) return sendJson(res, 403, { error: 'Admin only.' });
    await whatsapp.disconnect();
    audit.add(session.user, 'disconnected WhatsApp bot', 'ready to pair the dedicated bot number');
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok', version: require('./package.json').version,
        whatsapp: whatsapp.isConnected(), telegram: telegram.isRunning(),
        uptime: Math.floor(process.uptime()),
      });
    }
    if (url.pathname === '/api/public/enquiries' && req.method === 'POST') {
      return await handlePublicEnquiry(req, res);
    }
    if (url.pathname === '/api/public/villas' && req.method === 'GET') {
      // Sanitized public list — no owner data, no rates, no internal notes.
      const data = await villaData.getAll();
      const publicVillas = data.villas
        .filter(v => v.published !== false && ['Available', 'Booked'].includes(v.status))
        .map(v => ({
          name: v.name, slug: v.slug || '', summary: v.summary || '', location: v.location || '', bedrooms: v.bedrooms || 0,
          bathrooms: v.bathrooms || 0, pool: !!v.pool, maxGuests: v.maxGuests || 0,
          status: v.status, photoUrl: v.photoUrl || '', facilities: v.facilities || '',
          // Sanitized availability: date ranges only, never guest details.
          bookedRanges: data.tenancies
            .filter(t => t.villaId === v.id && !['Cancelled', 'Enquiry'].includes(t.bookingStatus) && t.checkIn && t.checkOut)
            .map(t => ({ from: t.checkIn, to: t.checkOut })),
        }));
      return sendJson(res, 200, publicVillas, { 'Cache-Control': 'public, max-age=300' });
    }
    if (url.pathname === '/api/owner/overview' && req.method === 'GET') {
      const session = await getSession(req);
      if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
      const ids = session.role === 'owner' ? (session.villaIds || []) : null; // admins may preview all
      const data = await villaData.getAll();
      const villas = data.villas
        .filter(v => !ids || ids.includes(v.id))
        .map(({ marketingNotes, ownerAgreementUrl, photosFolderUrl, ...v }) => v);
      const allowed = new Set(villas.map(v => v.id));
      return sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        session: { user: session.user, role: session.role, name: session.name },
        villas,
        tenancies: data.tenancies.filter(t => allowed.has(t.villaId)).map(({ idDocumentUrl, notes, guestPhone, guestEmail, ...t }) => t),
        installments: data.installments.filter(p => allowed.has(p.villaId)).map(({ proofUrl, ...p }) => p),
        deposits: data.deposits.filter(d => allowed.has(d.villaId)).map(({ refundProofUrl, inventoryUrl, deductionNotes, ...d }) => d),
        transactions: data.transactions.filter(x => allowed.has(x.villaId)).map(({ proofUrl, notes, sourceId, ...x }) => x),
      });
    }
    if (url.pathname.startsWith('/api/admin/')) {
      return await handleAdminApi(req, res, url);
    }
    if ((url.pathname === '/admin/login' || url.pathname === '/admin/login/') && req.method === 'GET') {
      if (await isAuthenticated(req)) return redirect(res, '/admin/');
      return await sendHtml(res, 'login.html');
    }
    if ((url.pathname === '/admin' || url.pathname === '/admin/') && req.method === 'GET') {
      const session = await getSession(req);
      if (!session) return redirect(res, '/admin/login');
      if (session.role === 'owner') return redirect(res, '/owner');
      return await sendHtml(res, 'index.html');
    }
    if ((url.pathname === '/owner' || url.pathname === '/owner/') && req.method === 'GET') {
      const session = await getSession(req);
      if (!session) return redirect(res, '/admin/login');
      return await sendHtml(res, 'owner.html');
    }
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (!/Connection Closed|ECONNRESET|aborted/i.test(error.message)) {
      console.error('[HTTP] Request failed:', error.message);
    }
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
      const leadActions = userKey === 'afni' ? await leadActionSummary() : '';
      const message = [briefing, villaActions, leadActions].filter(Boolean).join('\n\n');
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
    const due = await assistant.peekDueReminders();
    for (const reminder of due) {
      const user = brain.USERS[reminder.userKey];
      if (!user) { await assistant.confirmReminderDelivered(reminder.id); continue; }
      const lateMs = Date.now() - reminder.at;
      const lateNote = lateMs > 60 * 60 * 1000
        ? `\n_(scheduled ${assistant.epochToWitaString(reminder.at)} WITA — delivered late, channel was offline)_`
        : '';
      const message = `⏰ *Reminder:* ${reminder.text}${lateNote}`;
      const waSent = await whatsapp.sendToPhone(user.phone, message).catch(() => false);
      const tgSent = user.telegramId ? await telegram.sendToChat(user.telegramId, message).catch(() => false) : false;
      // Only consume the reminder once at least one channel actually delivered it.
      if (waSent || tgSent) {
        await assistant.confirmReminderDelivered(reminder.id);
        console.log(`[Reminder] ${user.name}: "${reminder.text}" WA=${waSent} TG=${tgSent}`);
      }
    }
  } catch (error) {
    console.error('[Reminder] Delivery failed:', error.message);
  }
}

async function backupData() {
  try {
    const { execFile } = require('child_process');
    const backupDir = '/root/tvm-backups';
    const stamp = new Date().toISOString().slice(0, 10);
    await fs.mkdir(backupDir, { recursive: true, mode: 0o750 }); // group-readable for n8n off-site backup
    await new Promise((resolve, reject) => {
      execFile('tar', ['-czf', `${backupDir}/data-${stamp}.tar.gz`, '-C', DATA_DIR, '.'],
        err => err ? reject(err) : resolve());
    });
    // Keep the last 14 nightly data backups
    const files = (await fs.readdir(backupDir)).filter(f => f.startsWith('data-')).sort();
    for (const old of files.slice(0, -14)) await fs.unlink(`${backupDir}/${old}`).catch(() => {});
    console.log(`[Backup] data-${stamp}.tar.gz written (${files.length} kept)`);
  } catch (error) {
    console.error('[Backup] failed:', error.message);
  }
}

async function boot() {
  const version = require('./package.json').version;
  console.log(`=== TVM Digital HQ v${version} starting ===`);
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  villaData.init(DATA_DIR);
  assistant.init(DATA_DIR);
  audit.init(DATA_DIR);
  await authUsers.init(DATA_DIR);
  notion.init();
  brain.init();
  if (process.env.DISABLE_CHANNELS !== 'true') {
    await whatsapp.start();
    await telegram.start();
  }
  cron.schedule('0 9 * * *', sendMorningDMs, { timezone: 'Asia/Makassar' });
  cron.schedule('* * * * *', deliverDueReminders); // minute-level reminder delivery
  cron.schedule('0 2 * * *', backupData, { timezone: 'Asia/Makassar' }); // nightly data backup
  server.listen(PORT, '127.0.0.1', () => console.log(`[HTTP] http://127.0.0.1:${PORT}`));
  console.log(`=== TVM Digital HQ v${version} running ===`);
}

boot().catch(error => {
  console.error('[FATAL]', error);
  process.exit(1);
});
