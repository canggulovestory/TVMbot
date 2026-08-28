/**
 * Local client for the Hermes Agent harness API.
 *
 * The API server must remain bound to loopback on the same VPS. Hermes owns
 * model routing, tools, skills, memory, and its agent loop; TVMbot only owns
 * channel authentication and delivery.
 */
'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8642';
const DEFAULT_MODEL = 'tvm';
// Keep this below nginx's proxy timeout so the admin receives a clear Zuzu
// response instead of an HTML 504 page when the model service is slow.
const DEFAULT_TIMEOUT_MS = 45000;

let config = null;

class HermesError extends Error {
  constructor(message, { code = 'HERMES_ERROR', status = 0 } = {}) {
    super(message);
    this.name = 'HermesError';
    this.code = code;
    this.status = status;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function init() {
  const apiKey = String(process.env.HERMES_API_KEY || '').trim();
  if (!apiKey) throw new Error('HERMES_API_KEY not set');

  const url = new URL(process.env.HERMES_API_URL || DEFAULT_URL);
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (!isLoopback && process.env.HERMES_ALLOW_REMOTE_API !== 'true') {
    throw new Error('HERMES_API_URL must use loopback unless HERMES_ALLOW_REMOTE_API=true');
  }

  config = {
    baseUrl: url.toString().replace(/\/$/, ''),
    apiKey,
    model: String(process.env.HERMES_API_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: Math.min(parsePositiveInt(process.env.HERMES_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS),
  };
}

function getConfig() {
  if (!config) init();
  return config;
}

function safeId(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80);
}

function extractResponseText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) {
    return body.output_text.trim();
  }

  const parts = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    if (item?.type !== 'message' && item?.role !== 'assistant') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      const text = content?.text || content?.output_text;
      if (typeof text === 'string' && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join('\n').trim();
}

async function request(path, body, { userKey } = {}) {
  const current = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), current.timeoutMs);
  const identity = safeId(userKey);

  try {
    const response = await fetch(`${current.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${current.apiKey}`,
        'Content-Type': 'application/json',
        'X-Hermes-Session-Id': `tvmbot-${identity}`,
        'X-Hermes-Session-Key': `agent:tvm:tvmbot:dm:${identity}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) {}

    if (!response.ok) {
      const detail = parsed?.error?.message || parsed?.detail || parsed?.error || `HTTP ${response.status}`;
      throw new HermesError(`Hermes request failed: ${String(detail).slice(0, 300)}`, {
        code: response.status === 401 ? 'HERMES_AUTH' : 'HERMES_RESPONSE',
        status: response.status,
      });
    }
    return parsed;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new HermesError('Hermes request timed out', { code: 'HERMES_TIMEOUT' });
    }
    if (error instanceof HermesError) throw error;
    throw new HermesError(`Hermes is unavailable: ${error.message}`, { code: 'HERMES_UNAVAILABLE' });
  } finally {
    clearTimeout(timeout);
  }
}

async function respond({ input, instructions, userKey }) {
  const current = getConfig();
  const identity = safeId(userKey);
  const body = await request('/v1/responses', {
    model: current.model,
    input: Array.isArray(input) ? input : String(input || ''),
    instructions: String(instructions || ''),
    conversation: `tvmbot-${identity}`,
    store: true,
  }, { userKey });

  const text = extractResponseText(body);
  if (!text) throw new HermesError('Hermes returned no assistant text', { code: 'HERMES_EMPTY' });
  return text;
}

module.exports = { init, respond, extractResponseText, HermesError };
