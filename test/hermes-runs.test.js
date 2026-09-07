'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.HERMES_API_KEY = 'test-key';
const hermes = require('../hermes-client');

test('Telegram runs deliver an approval, resolve it once, and return the completed answer', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push([url, options.body && JSON.parse(options.body)]);
    if (url.endsWith('/v1/runs')) return Response.json({ run_id: 'run_test', status: 'started' }, { status: 202 });
    if (url.endsWith('/events')) {
      const data = [
        { event: 'approval.request', run_id: 'run_test', command: 'node agent-tools.js search_operations afni', choices: ['once', 'deny'] },
        { event: 'run.completed', run_id: 'run_test', output: 'Sempol found.' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      // Deliberately split the SSE frame across network chunks.
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data.slice(0, 31))); c.enqueue(new TextEncoder().encode(data.slice(31))); c.close(); } }));
    }
    if (url.endsWith('/approval')) return Response.json({ resolved: 1 });
    throw new Error('Unexpected endpoint');
  };
  let approvals = 0;
  try {
    hermes.init();
    const answer = await hermes.respond({ input: 'Find Sempol', userKey: 'afni', allowFallback: false,
      onApproval: async event => { approvals++; assert.match(event.command, /search_operations/); return 'once'; },
    });
    assert.equal(answer, 'Sempol found.');
    assert.equal(approvals, 1);
    assert.deepEqual(calls.find(([url]) => url.endsWith('/approval'))[1], { choice: 'once' });
    assert.equal(calls[0][1].previous_response_id, undefined);
  } finally { global.fetch = original; }
});

test('an interrupted Telegram run is stopped and never retried through a fallback provider', async () => {
  const original = global.fetch;
  const urls = [];
  global.fetch = async url => {
    urls.push(url);
    if (url.endsWith('/v1/runs')) return Response.json({ run_id: 'run_failed', status: 'started' }, { status: 202 });
    if (url.endsWith('/events')) return new Response('data: {"event":"tool.started","run_id":"run_failed"}\n\n');
    if (url.endsWith('/stop')) return Response.json({ status: 'stopping' });
    throw new Error('Unexpected endpoint');
  };
  try {
    hermes.init();
    await assert.rejects(hermes.respond({ input: 'Save my note', userKey: 'afni', onApproval: async () => 'deny' }));
    assert.ok(urls.some(url => url.endsWith('/stop')));
    assert.ok(urls.every(url => url.startsWith('http://127.0.0.1')));
  } finally { global.fetch = original; }
});

test('web cancellation stops the Hermes run even while approval is pending',async()=>{
  const original=global.fetch,controller=new AbortController(),urls=[];
  global.fetch=async url=>{
    urls.push(url);
    if(url.endsWith('/v1/runs'))return Response.json({run_id:'run_cancel'});
    if(url.endsWith('/events'))return new Response([
      {event:'approval.request',run_id:'run_cancel',command:'synthetic',choices:['once','deny']},
      {event:'run.completed',run_id:'run_cancel',output:'Should not be delivered'}
    ].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
    return Response.json({});
  };
  try{
    hermes.init();
    await assert.rejects(hermes.respond({input:'test',userKey:'afni',signal:controller.signal,onApproval:async()=>{controller.abort();return 'deny'}}));
    assert.ok(urls.some(u=>u.endsWith('/stop')));
    assert.equal(urls.some(u=>u.endsWith('/approval')),false);
  }finally{global.fetch=original}
});

test('cancelling during the approval POST aborts it and ignores buffered completion',async()=>{
  const original=global.fetch,controller=new AbortController(),urls=[];
  let approvalSignal;
  global.fetch=async(url,options={})=>{
    urls.push(url);
    if(url.endsWith('/v1/runs'))return Response.json({run_id:'run_post'});
    if(url.endsWith('/events'))return new Response([
      {event:'approval.request',run_id:'run_post',command:'synthetic',choices:['once','deny']},
      {event:'run.completed',run_id:'run_post',output:'Must not be delivered'}
    ].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
    if(url.endsWith('/approval')){approvalSignal=options.signal;controller.abort();return Response.json({});}
    return Response.json({});
  };
  try{
    hermes.init();
    await assert.rejects(hermes.respond({input:'test',userKey:'afni',signal:controller.signal,onApproval:async()=>'once'}));
    assert.equal(approvalSignal.aborted,true);
    assert.ok(urls.some(u=>u.endsWith('/stop')));
  }finally{global.fetch=original}
});
