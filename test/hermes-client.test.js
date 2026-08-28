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

test('respond preserves Responses image input', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ output_text: 'Image read.' }), { status: 200 });
  };
  try {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Read this' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,AA==' }] }];
    await hermes.respond({ input, instructions: '', userKey: 'afni' });
    assert.deepEqual(captured.input, input);
  } finally { global.fetch = originalFetch; }
});
