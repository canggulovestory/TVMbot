/**
 * Google Workspace OAuth connection for the private TVM operating system.
 *
 * OAuth credentials stay in the VPS environment. The long-lived refresh token
 * is encrypted at rest in DATA_DIR and is never returned by this module.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.events',
];

let tokenFile = '';

function init(dataDir) {
  tokenFile = path.join(dataDir, 'google-workspace.json');
}

function setting(name) {
  return String(process.env[name] || '').trim();
}

function config() {
  const clientId = setting('GOOGLE_CLIENT_ID');
  const clientSecret = setting('GOOGLE_CLIENT_SECRET');
  const redirectUri = setting('GOOGLE_OAUTH_REDIRECT_URI') || 'https://thevillamanagers.cloud/admin/integrations/google/callback';
  const tokenKey = setting('GOOGLE_TOKEN_ENCRYPTION_KEY');
  return {
    clientId, clientSecret, redirectUri, tokenKey,
    allowedEmail: (setting('GOOGLE_ALLOWED_EMAIL') || 'info@thevillamanagers.com').toLowerCase(),
    configured: Boolean(clientId && clientSecret && tokenKey && tokenFile),
  };
}

function requireConfig() {
  const value = config();
  if (!value.configured) throw new Error('Google integration is not configured on the server yet.');
  return value;
}

function encryptionKey(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function encrypt(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decrypt(payload, secret) {
  if (!payload || payload.version !== 1) throw new Error('Google connection data is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

async function loadConnection() {
  const { tokenKey } = requireConfig();
  try {
    return decrypt(JSON.parse(await fs.readFile(tokenFile, 'utf8')), tokenKey);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveConnection(connection) {
  const { tokenKey } = requireConfig();
  await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const temp = `${tokenFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(encrypt(connection, tokenKey)), { mode: 0o600 });
  await fs.rename(temp, tokenFile);
}

function buildAuthorizationUrl(state) {
  const { clientId, redirectUri } = requireConfig();
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    // Do not merge any historical permissions from this Google client into the
    // new grant. TVM must request only the narrow scopes declared above.
    access_type: 'offline', prompt: 'consent select_account', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

async function googleFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Google request failed (${response.status})${body ? `: ${body.slice(0, 240)}` : ''}`);
  }
  return response.json();
}

async function completeAuthorization(code) {
  const { clientId, clientSecret, redirectUri, allowedEmail } = requireConfig();
  const token = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!token.refresh_token) throw new Error('Google did not issue a refresh token. Reconnect and approve access again.');
  const identity = await googleFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
  const email = String(identity.email || '').toLowerCase();
  if (!identity.email_verified || email !== allowedEmail) throw new Error(`Use the approved mailbox: ${allowedEmail}.`);
  const connection = { email, refreshToken: token.refresh_token, scopes: String(token.scope || SCOPES.join(' ')).split(/\s+/).filter(Boolean), connectedAt: new Date().toISOString() };
  await saveConnection(connection);
  return { email: connection.email, connectedAt: connection.connectedAt, scopes: connection.scopes };
}

async function status() {
  const current = config();
  if (!current.configured) return { configured: false, connected: false, allowedEmail: current.allowedEmail, scopes: SCOPES };
  const connection = await loadConnection();
  const missingScopes = requiredScopes(connection);
  return { configured: true, connected: Boolean(connection), allowedEmail: current.allowedEmail, email: connection?.email || '', connectedAt: connection?.connectedAt || '', scopes: connection?.scopes || SCOPES, missingScopes, requiresReconnect: Boolean(connection && missingScopes.length) };
}

async function accessToken() {
  const { clientId, clientSecret } = requireConfig();
  const connection = await loadConnection();
  if (!connection) throw new Error('Google is not connected. Connect the approved mailbox in TVM Admin first.');
  const token = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: connection.refreshToken, grant_type: 'refresh_token' }),
  });
  return { token: token.access_token, email: connection.email };
}

async function gmailInbox() {
  const auth = await accessToken();
  const headers = { Authorization: `Bearer ${auth.token}` };
  const [inbox, list] = await Promise.all([
    googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX', { headers }),
    googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10', { headers }),
  ]);
  const messages = await Promise.all((list.messages || []).slice(0, 10).map(async item => {
    const message = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`, { headers });
    const values = Object.fromEntries((message.payload?.headers || []).map(header => [String(header.name || '').toLowerCase(), header.value || '']));
    return { id: item.id, threadId: message.threadId || '', from: values.from || '', subject: values.subject || '(no subject)', date: values.date || '', snippet: String(message.snippet || '').slice(0, 600), attachments: attachmentParts(message.payload) };
  }));
  return { mailbox: auth.email, unread: Number(inbox.messagesUnread || 0), messages };
}

function attachmentParts(part, found = []) {
  if (!part) return found;
  if (part.body?.attachmentId) found.push({ attachmentId: part.body.attachmentId, name: String(part.filename || 'attachment').slice(0, 180), mimeType: part.mimeType || 'application/octet-stream', size: Number(part.body.size || 0) });
  (part.parts || []).forEach(child => attachmentParts(child, found));
  return found;
}

function emailAddress(value) {
  const email = String(value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email address is required.');
  return email;
}

function requiredScopes(connection) {
  const granted = new Set(connection?.scopes || []);
  return SCOPES.filter(scope => !['openid', 'email', 'profile'].includes(scope) && !granted.has(scope));
}

function rawEmail({ to, subject, body }) {
  const lines = [
    `To: ${emailAddress(to)}`,
    `Subject: ${String(subject || '').replace(/[\r\n]/g, ' ').slice(0, 180)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '', String(body || '').slice(0, 12000),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

async function createEmailDraft({ to, subject, body }) {
  const auth = await accessToken();
  const result = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: rawEmail({ to, subject, body }) } }),
  });
  return { id: result.id || '', messageId: result.message?.id || '', to: emailAddress(to), subject: String(subject || '').slice(0, 180), status: 'Draft created — not sent' };
}

function witaDateTime(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) throw new Error('Use YYYY-MM-DDTHH:MM in WITA.');
  return `${text}:00+08:00`;
}

async function calendarUpcoming() {
  const auth = await accessToken();
  const query = new URLSearchParams({ timeMin: new Date().toISOString(), maxResults: '10', singleEvents: 'true', orderBy: 'startTime' });
  const result = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, { headers: { Authorization: `Bearer ${auth.token}` } });
  return (result.items || []).map(item => ({ id: item.id, title: item.summary || '(untitled)', start: item.start?.dateTime || item.start?.date || '', end: item.end?.dateTime || item.end?.date || '', link: item.htmlLink || '' }));
}

async function createCalendarHold({ title, start, end, description = '' }) {
  const auth = await accessToken();
  const event = {
    summary: String(title || 'TVM hold').slice(0, 180), description: String(description || '').slice(0, 2000),
    start: { dateTime: witaDateTime(start), timeZone: 'Asia/Makassar' },
    end: { dateTime: witaDateTime(end), timeZone: 'Asia/Makassar' },
  };
  const result = await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event),
  });
  return { id: result.id || '', title: event.summary, start, end, link: result.htmlLink || '', status: 'Calendar hold created' };
}

async function uploadPrivateFile({ name, mimeType, buffer }) {
  const auth = await accessToken();
  const boundary = `tvm-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: String(name || 'TVM document').slice(0, 180), description: 'Uploaded through private TVM Admin / Zuzu intake.' });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
    Buffer.from(buffer), Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);
  const result = await googleFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  return { id: result.id || '', name: result.name || name, url: result.webViewLink || (result.id ? `https://drive.google.com/open?id=${encodeURIComponent(result.id)}` : '') };
}

/** Explicit-only action: copies one selected Gmail attachment into the private Drive. */
async function saveGmailAttachmentToDrive({ messageId, attachmentId }) {
  const auth = await accessToken();
  const headers = { Authorization: `Bearer ${auth.token}` };
  const message = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`, { headers });
  const attachment = attachmentParts(message.payload).find(item => item.attachmentId === String(attachmentId));
  if (!attachment) throw new Error('The selected Gmail attachment was not found.');
  if (attachment.size > 6 * 1024 * 1024) throw new Error('That attachment is over the 6 MB private-upload limit.');
  const content = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, { headers });
  const buffer = Buffer.from(String(content.data || ''), 'base64url');
  if (!buffer.length) throw new Error('Google returned an empty attachment.');
  return uploadPrivateFile({ name: attachment.name, mimeType: attachment.mimeType, buffer });
}

module.exports = { init, status, buildAuthorizationUrl, completeAuthorization, gmailInbox, createEmailDraft, calendarUpcoming, createCalendarHold, uploadPrivateFile, saveGmailAttachmentToDrive, SCOPES, requiredScopes };
