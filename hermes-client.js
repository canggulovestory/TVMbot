/**
 * AI client for Zuzu.
 *
 * The API server must remain bound to loopback on the same VPS. Hermes owns
 * model routing, tools, skills, memory, and its agent loop; TVMbot only owns
 * channel authentication and delivery. All AI calls stay on the configured
 * Hermes provider; there is no external fallback or automatic model switching.
 */
'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8642';
const DEFAULT_MODEL = 'tvm';
// Keep this below nginx's proxy timeout so the admin receives a clear Zuzu
// response instead of an HTML 504 page when the model service is slow.
const DEFAULT_TIMEOUT_MS = 15000;
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

function isProviderFailure(text) {
  const value = String(text || '').trim();
  return /^Operation interrupted:/i.test(value)
    || /^API call failed after \d+ retries: HTTP (?:401|429|5\d{2}):/i.test(value)
    || /^HTTP 401: Model .+ is not supported\.?$/i.test(value)
    || /^HTTP 400: Error from provider\b/i.test(value)
    || /\binvalid_request_error\b.*\b(?:duplicate )?function_call_output\b/i.test(value)
    || /\bupstream request failed\b.*\bfunction_call_output\b/i.test(value);
}

async function request(path, body, { userKey, signal } = {}) {
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
        'X-Hermes-Session-Key': `agent:tvm:tvmbot:dm:${identity}`,
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });

    const raw = await response.text();
    signal?.throwIfAborted();
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

async function runWithApprovals(body, userKey, onApproval, signal) {
  signal?.throwIfAborted();
  const current = getConfig();
  const started = await request('/v1/runs', body, { userKey });
  if (!/^run_[a-zA-Z0-9_]+$/.test(started.run_id || '')) throw new HermesError('Hermes did not start a run');
  const path = `/v1/runs/${started.run_id}`;
  const controller = new AbortController();
  let stopPromise;
  const stop=()=>stopPromise||(stopPromise=request(`${path}/stop`,{}, {userKey}).catch(()=>{}));
  const cancel=()=>{controller.abort();void stop();};
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  // Telegram is not behind the Admin HTTP proxy. Bound the whole tool run,
  // including user approval time, instead of abandoning it after 15 seconds.
  const timeout = setTimeout(() => controller.abort(), 180000);
  let completed = false;
  try {
    const response = await fetch(`${current.baseUrl}${path}/events`, {
      headers: { Authorization: `Bearer ${current.apiKey}` }, signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new HermesError('Hermes run stream unavailable');
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
      if (pending.length > 1024 * 1024) throw new HermesError('Hermes run event too large');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        controller.signal.throwIfAborted();
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.run_id !== started.run_id) throw new HermesError('Hermes run identity mismatch');
        if (event.event === 'approval.request') {
          const decision = await onApproval(event, { signal: controller.signal });
          const choice = decision === 'once' && event.choices?.includes('once') ? 'once' : 'deny';
          if (controller.signal.aborted) throw new HermesError('Approval expired');
          await request(`${path}/approval`, { choice }, { userKey, signal:controller.signal });
        } else if (event.event === 'run.completed') {
          const text = String(event.output || '').trim();
          if (!text || isProviderFailure(text)) throw new HermesError('Hermes run returned no usable answer');
          completed = true;
          return text;
        } else if (['run.failed', 'run.cancelled'].includes(event.event)) {
          throw new HermesError('Hermes could not complete this run', { code: 'HERMES_RUN_FAILED' });
        }
      }
    }
    throw new HermesError('Hermes disconnected before completing the run');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort',cancel);
    controller.abort();
    // Never leave a potentially mutating run executing after delivery failed.
    // Do not retry/fallback: the first run might already have changed a record.
    if (!completed) await stop();
  }
}

async function respond({ input, instructions, userKey, onApproval, signal, conversationHistory = [] }) {
  const current = getConfig();
  const body = {
    model: current.model,
    input: Array.isArray(input) ? input : String(input || ''),
    instructions: String(instructions || ''),
    // TVM records and relevant memories are injected for every request. Do not
    // reuse Hermes' tool-call transcript: one malformed provider response can
    // otherwise poison every later Telegram message for this user.
    store: false,
  };
  if (conversationHistory.length) body.conversation_history = conversationHistory;
  if (onApproval) {
    // /runs accepts Chat-style multimodal content, not Responses input blocks.
    if (Array.isArray(input)) body.input = input.map(message => ({ ...message, content: message.content.map(part =>
      part.type === 'input_text' ? { type: 'text', text: part.text } :
        part.type === 'input_image' ? { type: 'image_url', image_url: { url: part.image_url, detail: part.detail || 'auto' } } : part) }));
    return runWithApprovals(body, userKey, onApproval, signal);
  }

  const response = await request('/v1/responses', body, { userKey });
  const text = extractResponseText(response);
  if (!text || isProviderFailure(text)) throw new HermesError('Hermes returned no usable assistant text', { code: 'HERMES_RESPONSE' });
  return text;
}

module.exports = { init, respond, extractResponseText, isProviderFailure, HermesError };
