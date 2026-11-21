/**
 * Read-only connection to Afni's PRIVATE Gmail, used only to read bank payment
 * notification mails (Binky, 21-11-2026). Separate from google-workspace.js:
 * own encrypted token file, gmail.readonly only, one allowed mailbox, and every
 * search is forced to the bank-sender list below. Mail bodies are never stored.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
// Sender domains of Afni's banks / wallets. Searches can never leave this list.
const BANK_SENDERS = [
  'bca.co.id', 'klikbca.com', 'permatabank.co.id', 'permatabank.com', 'cimbniaga.co.id', 'cimbniaga.com',
  'jago.com', 'ovo.id', 'gojek.com', 'gopay.co.id', 'shopee.co.id', 'shopeepay.co.id',
];
let tokenFile = '';

function init(dataDir) { tokenFile = path.join(dataDir, 'bank-gmail.json'); }
function setting(name) { return String(process.env[name] || '').trim(); }
function config() {
  const clientId = setting('GOOGLE_CLIENT_ID'), clientSecret = setting('GOOGLE_CLIENT_SECRET'), tokenKey = setting('GOOGLE_TOKEN_ENCRYPTION_KEY');
  return {
    clientId, clientSecret, tokenKey,
    redirectUri: setting('GOOGLE_OAUTH_REDIRECT_URI') || 'https://thevillamanagers.cloud/admin/integrations/google/callback',
    allowedEmail: (setting('BANK_GMAIL_ALLOWED_EMAIL') || 'harfiyanafni@gmail.com').toLowerCase(),
    configured: Boolean(clientId && clientSecret && tokenKey && tokenFile),
  };
}
function requireConfig() { const c = config(); if (!c.configured) throw new Error('Bank Gmail is not configured on the server yet.'); return c; }
function key(secret) { return crypto.createHash('sha256').update('bank-gmail:' + secret, 'utf8').digest(); }
function encrypt(value, secret) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decrypt(p, secret) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(secret), Buffer.from(p.iv, 'base64'));
  d.setAuthTag(Buffer.from(p.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(p.ciphertext, 'base64')), d.final()]).toString('utf8'));
}
async function load() {
  const { tokenKey } = requireConfig();
  try { return decrypt(JSON.parse(await fs.readFile(tokenFile, 'utf8')), tokenKey); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function save(conn) {
  const { tokenKey } = requireConfig();
  const tmp = tokenFile + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(encrypt(conn, tokenKey)), { mode: 0o600 });
  await fs.rename(tmp, tokenFile);
}
async function gfetch(url, options = {}) {
  const r = await fetch(url, options);
  if (!r.ok) { const b = await r.text().catch(() => ''); throw new Error(`Google request failed (${r.status})${b ? ': ' + b.slice(0, 200) : ''}`); }
  return r.json();
}

function buildAuthorizationUrl(state) {
  const { clientId, redirectUri, allowedEmail } = requireConfig();
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', login_hint: allowedEmail, state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function completeAuthorization(code) {
  const { clientId, clientSecret, redirectUri, allowedEmail } = requireConfig();
  const token = await gfetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
  if (!token.refresh_token) throw new Error('Google did not issue a refresh token. Open the link again and approve.');
  const granted = String(token.scope || '').split(/\s+/);
  if (granted.some(s => /gmail\.(compose|modify|send)|mail\.google\.com|drive|calendar|spreadsheets/.test(s))) throw new Error('Too many permissions were granted. Only read-only Gmail is allowed.');
  if (!granted.includes('https://www.googleapis.com/auth/gmail.readonly')) throw new Error('Read-only Gmail permission was not granted. Tick the Gmail box and try again.');
  const who = await gfetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
  const email = String(who.email || '').toLowerCase();
  if (!who.email_verified || email !== allowedEmail) throw new Error(`Use the approved mailbox: ${allowedEmail}.`);
  const conn = { email, refreshToken: token.refresh_token, scopes: granted, connectedAt: new Date().toISOString() };
  await save(conn);
  return { email, connectedAt: conn.connectedAt };
}

async function accessToken() {
  const { clientId, clientSecret } = requireConfig();
  const conn = await load();
  if (!conn) throw new Error('Bank Gmail is not connected.');
  const t = await gfetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: conn.refreshToken, grant_type: 'refresh_token' }) });
  return t.access_token;
}

async function status() {
  const c = config();
  if (!c.configured) return { configured: false, connected: false, allowedEmail: c.allowedEmail };
  const conn = await load().catch(() => null);
  return { configured: true, connected: Boolean(conn), allowedEmail: c.allowedEmail, email: conn?.email || '', connectedAt: conn?.connectedAt || '' };
}

/** Gmail query that can only ever match the bank senders. */
function bankQuery(extra = '') {
  const from = `from:(${BANK_SENDERS.join(' OR ')})`;
  const safe = String(extra || '').replace(/[(){}"\\]/g, ' ').replace(/\bfrom:\S*/gi, ' ').trim().slice(0, 120);
  return safe ? `${from} ${safe}` : from;
}

/** Metadata only (sender, subject, date) for messages from bank senders. */
async function listBankMessages({ extra = 'newer_than:90d', max = 500 } = {}) {
  const tok = await accessToken();
  const H = { Authorization: `Bearer ${tok}` };
  const ids = []; let pageToken = '';
  do {
    const q = new URLSearchParams({ q: bankQuery(extra), maxResults: '100' }); if (pageToken) q.set('pageToken', pageToken);
    const r = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`, { headers: H });
    ids.push(...(r.messages || []).map(m => m.id)); pageToken = r.nextPageToken || '';
  } while (pageToken && ids.length < max);
  const out = [];
  for (const id of ids.slice(0, max)) {
    const m = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: H });
    const h = Object.fromEntries((m.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    const domain = (String(h.from || '').match(/@([\w.-]+)/) || [])[1] || '';
    if (!BANK_SENDERS.some(d => domain === d || domain.endsWith('.' + d))) continue; // belt and braces
    out.push({ id, from: h.from || '', domain, subject: h.subject || '', date: h.date || '' });
  }
  return out;
}

module.exports = { init, status, buildAuthorizationUrl, completeAuthorization, listBankMessages, bankQuery, BANK_SENDERS, SCOPES };
