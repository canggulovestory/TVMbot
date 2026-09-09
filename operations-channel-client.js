'use strict';
const crypto = require('node:crypto');
const ACTIONS = new Set(['list_tasks', 'list_villas', 'create_task', 'complete_task']);
const SAFE_ERRORS = new Set(['unauthorized', 'action_not_allowed', 'invalid_arguments', 'request_conflict', 'outcome_uncertain', 'task_not_found', 'connector_disabled', 'service_unavailable']);
const error = code => Object.assign(new Error(code), { code });

// Server module, not a browser/model tool. Call only with trusted Telegram updates
// or the real HTTP request authenticated by privateAuth.authenticate. The host
// tool loop supplies deliveryId/toolIndex; these are never model arguments.
function createOperationsChannels({ enabled = false, url, telegramBindings = [], webBindings = [], authenticateWeb }) {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/v1/operations' || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('Connector requires HTTPS or exact loopback');
  const usedTokens = new Set();
  function bindings(items, field) {
    const map = new Map();
    for (const item of items) {
      if (typeof item[field] !== 'string' || !item[field] || map.has(item[field]) || typeof item.token !== 'string' || item.token.length < 32 || usedTokens.has(item.token)) throw new Error('Invalid channel binding');
      map.set(item[field], item.token); usedTokens.add(item.token);
    }
    return map;
  }
  const telegram = bindings(telegramBindings, 'senderId'), web = bindings(webBindings, 'userId');
  async function invoke(token, tool, deliveryId, { toolIndex = 0, signal } = {}) {
    if (!token) throw error('unauthorized');
    if (!enabled) throw error('connector_disabled');
    if (!tool || Array.isArray(tool) || Object.keys(tool).some(key => !['action', 'input'].includes(key))) throw error('invalid_arguments');
    if (!ACTIONS.has(tool.action)) throw error('action_not_allowed');
    const body = { action: tool.action, input: tool.input };
    const write = !tool.action.startsWith('list_');
    if (write) {
      if (typeof deliveryId !== 'string' || !deliveryId || deliveryId.length > 300 || !Number.isInteger(toolIndex) || toolIndex < 0 || toolIndex > 100) throw error('trusted_delivery_required');
      body.requestId = crypto.createHash('sha256').update(JSON.stringify([deliveryId, toolIndex])).digest('hex');
    }
    const raw = JSON.stringify(body);
    if (Buffer.byteLength(raw) > 8192) throw error('invalid_arguments');
    try {
      const timeout = AbortSignal.timeout(15000);
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: raw, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 262144) throw error('service_unavailable'); chunks.push(chunk); }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok || parsed.ok !== true) throw error(SAFE_ERRORS.has(parsed.error) ? parsed.error : 'service_unavailable');
      return parsed;
    } catch (failure) {
      if (SAFE_ERRORS.has(failure.code)) throw failure;
      // A lost write reply is not permission to submit another task.
      throw error(write ? 'outcome_uncertain' : 'service_unavailable');
    }
  }
  function telegramIdentity(message) {
    if (!Number.isSafeInteger(message?.message_id) || message.message_id < 1 || !Number.isSafeInteger(message?.from?.id) || message.from.is_bot || message.chat?.type !== 'private' || message.chat.id !== message.from.id || !telegram.has(String(message.from.id))) throw error('unauthorized');
    return String(message.from.id);
  }
  async function webIdentity(req) {
    const user = typeof authenticateWeb === 'function' ? await authenticateWeb(req) : null;
    if (!user || !web.has(user.id)) throw error('unauthorized');
    return user.id;
  }
  return Object.freeze({
    telegramIdentity, webIdentity,
    async fromTelegram(message, tool, options) {
      return invoke(telegram.get(telegramIdentity(message)), tool, `telegram:${message.chat.id}:${message.message_id}`, options);
    },
    async fromWeb(req, tool, options = {}) {
      return invoke(web.get(await webIdentity(req)), tool, options.deliveryId, options);
    },
  });
}
module.exports = { createOperationsChannels };
