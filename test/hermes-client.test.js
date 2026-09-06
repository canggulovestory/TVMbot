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
  assert.equal(hermes.isProviderFailure('Operation interrupted: waiting for model response (50.2s elapsed).'), true);
  assert.equal(hermes.isProviderFailure('HTTP 401: Model hy3-free is not supported'), true);
  assert.equal(hermes.isProviderFailure('API call failed after 3 retries: HTTP 503: Endpoint is unavailable.'), true);
  assert.equal(hermes.isProviderFailure("HTTP 400: Error from provider (Console): Upstream request failed: [invalid_request_error] Duplicate function_call_output for call_id 'call_123'."), true);
  assert.equal(hermes.isProviderFailure('HTTP 503 is an upstream error.'), false);
  assert.equal(hermes.isProviderFailure('Zuzu is ready.'), false);
});

test('a failed primary request never contacts a different provider', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async url => { urls.push(url); return Response.json({ error: { message: 'unavailable' } }, { status: 503 }); };
  try {
    hermes.init();
    await assert.rejects(hermes.respond({ input: 'hello', userKey: 'afni' }));
    assert.deepEqual(urls, ['http://127.0.0.1:8642/v1/responses']);
  } finally { global.fetch = originalFetch; }
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
