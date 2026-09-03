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

test('provider failure detector catches model and endpoint failures only', () => {
  assert.equal(hermes.isProviderFailure('HTTP 401: Model hy3-free is not supported'), true);
  assert.equal(hermes.isProviderFailure('API call failed after 3 retries: HTTP 503: Endpoint is unavailable.'), true);
  assert.equal(hermes.isProviderFailure('HTTP 503 is an upstream error.'), false);
  assert.equal(hermes.isProviderFailure('Zuzu is ready.'), false);
});

test('respond sends an authenticated, user-scoped Hermes request', async () => {
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
    assert.equal(captured.options.headers['X-Hermes-Session-Id'], 'tvmbot-afni');
    assert.equal(captured.options.headers['X-Hermes-Session-Key'], 'agent:tvm:tvmbot:dm:afni');
    assert.deepEqual(JSON.parse(captured.options.body), {
      model: 'tvm',
      input: 'hello',
      instructions: 'brief',
      conversation: 'tvmbot-afni',
      store: true,
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
    assert.match(calls[1].body.messages[0].content, /no tools in fallback mode/i);
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
