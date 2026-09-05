'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HERMES_API_KEY = 'test-harness-key';
process.env.HERMES_API_URL = 'http://127.0.0.1:8642';
process.env.HERMES_API_MODEL = 'tvm';

const hermes = require('../hermes-client');

test('extractResponseText reads Responses API message output', () => {
  assert.equal(hermes.extractResponseText({
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'TVM Hermes ready' }],
    }],
  }), 'TVM Hermes ready');
});

test('provider failure detector catches model, endpoint, and malformed tool-call failures', () => {
  assert.equal(hermes.isProviderFailure('HTTP 401: Model hy3-free is not supported'), true);
  assert.equal(hermes.isProviderFailure('API call failed after 3 retries: HTTP 503: Endpoint is unavailable.'), true);
  assert.equal(hermes.isProviderFailure("HTTP 400: Error from provider (Console): Upstream request failed: [invalid_request_error] Duplicate function_call_output for call_id 'call_123'."), true);
  assert.equal(hermes.isProviderFailure('HTTP 503 is an upstream error.'), false);
  assert.equal(hermes.isProviderFailure('Zuzu is ready.'), false);
});

test('respond sends an authenticated request with stable memory scope and no stored transcript', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    hermes.init();
    const result = await hermes.respond({ input: 'hello', instructions: 'brief', userKey: 'afni' });
    assert.equal(result, 'Done.');
    assert.equal(captured.url, 'http://127.0.0.1:8642/v1/responses');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-harness-key');
    assert.equal(captured.options.headers['X-Hermes-Session-Id'], undefined);
    assert.equal(captured.options.headers['X-Hermes-Session-Key'], 'agent:tvm:tvmbot:dm:afni');
    assert.deepEqual(JSON.parse(captured.options.body), {
      model: 'tvm',
      input: 'hello',
      instructions: 'brief',
      store: false,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('respond exposes a bounded Hermes API error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    error: { message: 'provider unavailable' },
  }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  try {
    await assert.rejects(
      () => hermes.respond({ input: 'hello', instructions: '', userKey: 'syifa' }),
      error => error.code === 'HERMES_RESPONSE'
        && error.status === 503
        && /provider unavailable/.test(error.message),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('respond uses the read-only fallback when Hermes fails', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (String(url).startsWith('http://127.0.0.1')) {
      return new Response(JSON.stringify({ error: { message: 'model route down' } }), { status: 503 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Fallback ready.' } }],
    }), { status: 200 });
  };

  try {
    hermes.init();
    const result = await hermes.respond({ input: 'hello', instructions: 'Be brief.', userKey: 'afni' });
    assert.equal(result, 'Fallback ready.');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://opencode.ai/zen/v1/chat/completions');
    assert.match(calls[1].body.messages[0].content, /general conversation only/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('respond never returns a raw provider tool-call error to the user', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async url => {
    calls += 1;
    if (String(url).startsWith('http://127.0.0.1')) {
      return new Response(JSON.stringify({
        output_text: "HTTP 400: Error from provider (Console): Upstream request failed: [invalid_request_error] Duplicate function_call_output for call_id 'call_123'.",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Safe fallback reply.' } }] }), { status: 200 });
  };

  try {
    hermes.init();
    const result = await hermes.respond({ input: 'Zuzu', instructions: '', userKey: 'afni' });
    assert.equal(result, 'Safe fallback reply.');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('respond preserves Responses image input', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ output_text: 'Image read.' }), { status: 200 });
  };
  try {
    hermes.init();
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Read this' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,AA==' }] }];
    await hermes.respond({ input, instructions: '', userKey: 'afni' });
    assert.deepEqual(captured.input, input);
  } finally { global.fetch = originalFetch; }
});

test('fallback never receives private instructions or attachments', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (String(url).startsWith('http://127.0.0.1')) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Public fallback reply.' } }] }), { status: 200 });
  };
  try {
    hermes.init();
    await hermes.respond({
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,PRIVATEIMAGE' }] }],
      instructions: 'Current private TVM records: Wi-Fi password is SECRET-PASSWORD.', userKey: 'afni',
    });
    const sent = JSON.stringify(calls[1].body);
    assert.doesNotMatch(sent, /SECRET-PASSWORD|PRIVATEIMAGE|image_url/);
    assert.match(calls[1].body.messages[0].content, /no access to TVM records/i);
  } finally { global.fetch = originalFetch; }
});

test('secure requests do not use the external fallback', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 }); };
  try {
    hermes.init();
    await assert.rejects(() => hermes.respond({ input: 'private', instructions: 'secret', userKey: 'afni', allowFallback: false }), error => error.code === 'HERMES_RESPONSE');
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});
