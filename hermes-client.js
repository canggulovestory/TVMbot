/**
 * AI client for Zuzu.
 *
 * The API server must remain bound to loopback on the same VPS. Hermes owns
 * model routing, tools, skills, memory, and its agent loop; TVMbot only owns
 * channel authentication and delivery. A small OpenCode fallback keeps
 * read-only chat available while Hermes or its model route is recovering.
 */
'use strict';

const { execFile } = require('node:child_process');

const DEFAULT_URL = 'http://127.0.0.1:8642';
const DEFAULT_MODEL = 'tvm';
// Keep this below nginx's proxy timeout so the admin receives a clear Zuzu
// response instead of an HTML 504 page when the model service is slow.
const DEFAULT_TIMEOUT_MS = 15000;
const FALLBACK_URL = 'https://opencode.ai/zen/v1/chat/completions';
const FALLBACK_MODELS = ['mimo-v2.5-free', 'ling-3.0-flash-fin-free'];
const FALLBACK_TIMEOUT_MS = 12000;
const HERMES_RETRY_DELAY_MS = 5 * 60 * 1000;

let config = null;
let hermesRetryAfter = 0;
const fallbackHistory = new Map();

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
    fallbackUrl: String(process.env.ZUZU_FALLBACK_URL || FALLBACK_URL).trim(),
    fallbackModels: String(process.env.ZUZU_FALLBACK_MODELS || FALLBACK_MODELS.join(','))
      .split(',').map(value => value.trim()).filter(Boolean).slice(0, 3),
  };
  hermesRetryAfter = 0;
  fallbackHistory.clear();
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

function isProviderFailure(text) {
  const value = String(text || '').trim();
  return /^API call failed after \d+ retries: HTTP (?:401|429|5\d{2}):/i.test(value)
    || /^HTTP 401: Model .+ is not supported\.?$/i.test(value);
}

function scheduleModelRecovery() {
  if (process.platform !== 'linux') return;
  const child = execFile('systemctl', ['start', '--no-block', 'tvm-hermes-model-watchdog.service'], () => {});
  child.unref();
}

function fallbackContent(input) {
  if (!Array.isArray(input)) return String(input || '');
  const content = [];
  for (const message of input) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === 'input_text' && part.text) content.push({ type: 'text', text: String(part.text) });
      if (part?.type === 'input_image' && part.image_url) {
        content.push({ type: 'image_url', image_url: { url: String(part.image_url) } });
      }
    }
  }
  return content.length ? content : String(input || '');
}

function fallbackHistoryText(input) {
  if (!Array.isArray(input)) return String(input || '');
  const texts = input.flatMap(message => Array.isArray(message?.content) ? message.content : [])
    .filter(part => part?.type === 'input_text' && part.text)
    .map(part => String(part.text));
  return `${texts.join('\n')}${input.some(message => message?.content?.some?.(part => part?.type === 'input_image')) ? '\n[image attached]' : ''}`.trim();
}

function fallbackInstructions(instructions) {
  const source = String(instructions || '');
  const withoutToolGuide = source.replace(
    /\nYou are running inside the Hermes Agent harness and can help with:[\s\S]*?\nConfirm completed actions with one line\./,
    '',
  );
  return `${withoutToolGuide}\n\nYou have no tools in fallback mode. The matching TVM records are already included above. Answer directly from those records. Never output a tool call, XML, JSON, or claim that you changed data. If the records do not contain the answer, say what is missing.`;
}

async function fallbackRespond({ input, instructions, userKey }) {
  const current = getConfig();
  const identity = safeId(userKey);
  const history = fallbackHistory.get(identity) || [];
  let lastError = null;

  for (const model of current.fallbackModels) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
    try {
      const response = await fetch(current.fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: fallbackInstructions(instructions) },
            ...history,
            { role: 'user', content: fallbackContent(input) },
          ],
          max_tokens: 900,
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      const text = String(body?.choices?.[0]?.message?.content || '').trim();
      if (!response.ok || !text || /<tool_call>|<arg_key>|<function=/i.test(text)) {
        throw new Error(body?.error?.message || (!text ? `HTTP ${response.status}` : 'model attempted a tool call'));
      }

      const nextHistory = [...history,
        { role: 'user', content: fallbackHistoryText(input) },
        { role: 'assistant', content: text },
      ].slice(-6);
      fallbackHistory.set(identity, nextHistory);
      return text;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new HermesError(`Zuzu fallback is unavailable: ${lastError?.message || 'no model responded'}`, {
    code: 'HERMES_FALLBACK', status: 503,
  });
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
  const body = {
    model: current.model,
    input: Array.isArray(input) ? input : String(input || ''),
    instructions: String(instructions || ''),
    conversation: `tvmbot-${identity}`,
    store: true,
  };

  let hermesError = null;
  if (Date.now() >= hermesRetryAfter) {
    try {
      let response = await request('/v1/responses', body, { userKey });
      let text = extractResponseText(response);
      if (isProviderFailure(text)) throw new HermesError('Hermes provider returned an unavailable model', { code: 'HERMES_RESPONSE', status: 503 });
      if (!text || isProviderFailure(text)) throw new HermesError('Hermes returned no usable assistant text', { code: 'HERMES_EMPTY' });
      return text;
    } catch (error) {
      hermesError = error;
      scheduleModelRecovery();
    }
  }

  try {
    const text = await fallbackRespond({ input, instructions, userKey });
    hermesRetryAfter = Date.now() + HERMES_RETRY_DELAY_MS;
    return text;
  } catch (_) {
    hermesRetryAfter = 0;
    if (hermesError) throw hermesError;
    throw new HermesError('Zuzu AI providers are unavailable', { code: 'HERMES_UNAVAILABLE', status: 503 });
  }
}

module.exports = { init, respond, fallbackRespond, extractResponseText, isProviderFailure, HermesError };
