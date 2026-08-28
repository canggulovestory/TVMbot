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
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
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
  return { configured: true, connected: Boolean(connection), allowedEmail: current.allowedEmail, email: connection?.email || '', connectedAt: connection?.connectedAt || '', scopes: connection?.scopes || SCOPES };
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
    const message = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers });
    const values = Object.fromEntries((message.payload?.headers || []).map(header => [String(header.name || '').toLowerCase(), header.value || '']));
    return { id: item.id, from: values.from || '', subject: values.subject || '(no subject)', date: values.date || '' };
  }));
  return { mailbox: auth.email, unread: Number(inbox.messagesUnread || 0), messages };
}

module.exports = { init, status, buildAuthorizationUrl, completeAuthorization, gmailInbox, SCOPES };
