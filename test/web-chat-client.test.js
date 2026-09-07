'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const createWebChat=require('../admin/web-chat');
test('browser chat surfaces approval then delivers the reply without reposting the prompt',async()=>{
  const calls=[];let approved=false,client;
  const api=async(path,options={})=>{
    calls.push([path,options.method||'GET']);
    if(path==='/runs')return {id:'run',status:'running'};
    if(path.endsWith('/decision')){approved=true;return {ok:true}}
    return approved?{id:'run',status:'completed',reply:'Saved once'}:{id:'run',status:'approval',approval:{token:'token',command:'synthetic'}};
  };
  client=createWebChat(api,'/runs',state=>{if(state.run?.approval&&!state.deciding)void client.decide('once')},{pollMs:1});
  const result=await client.send('Test');
  assert.equal(result.reply,'Saved once');
  assert.equal(calls.filter(([p])=>p==='/runs').length,1);
  assert.equal(client.busy,false);
});
test('a poll failure requests cancellation and never repeats the action',async()=>{
  const paths=[];
  const client=createWebChat(async(path)=>{
    paths.push(path);if(path==='/runs')return {id:'r',status:'running'};
    if(path.endsWith('/cancel'))return {ok:true};
    throw Error('Offline');
  },'/runs',()=>{},{pollMs:1});
  await assert.rejects(client.send('Test'),/Offline/);
  assert.equal(paths.filter(p=>p==='/runs').length,1);
  assert.ok(paths.includes('/runs/r/cancel'));
});
