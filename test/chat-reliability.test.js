'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createChat}=require('../isolated-chat'),{createOperationsChat}=require('../operations-chat'),{createOperationsChannels}=require('../operations-channel-client');
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.close();s.closeAllConnections();});return `http://127.0.0.1:${s.address().port}`;}
const message={message_id:1,from:{id:100},chat:{id:100,type:'private'}};
test('payment arithmetic uses conversation context even without a finance connection',async()=>{
 let called=false;const history=[{role:'user',content:'Phase is 154600 USDT; he paid 82480 USDT.'}];
 const runner=createOperationsChat({channels:{telegramIdentity:()=> '100'},turns:async(id,text,work)=>work({beforeWrite(){}}),chat:{async respond(input){called=true;assert.deepEqual(input.history,history);return {response:'72120 USDT remains, using your figures.'};}}});
 assert.match(await runner.telegram({message,text:'How much payment is left?',history}),/72120/);assert.ok(called);
});
test('transient record read retries once; writes and authorization errors never retry',async t=>{
 let calls=0,mode='read';const url=await server(t,async(req,res)=>{for await(const c of req){}calls++;res.setHeader('content-type','application/json');if(mode==='read'&&calls===2)return res.end(JSON.stringify({ok:true,result:{items:[]}}));res.statusCode=mode==='auth'?401:503;res.end(JSON.stringify({ok:false,error:mode==='auth'?'unauthorized':'service_unavailable'}));});
 const c=createOperationsChannels({enabled:true,url:url+'/v1/operations',telegramBindings:[{senderId:'100',token:'x'.repeat(40)}]});
 await c.fromTelegram(message,{action:'list_tasks',input:{}});assert.equal(calls,2);
 for(mode of ['write','auth']){calls=0;await assert.rejects(c.fromTelegram(message,{action:mode==='write'?'create_task':'list_tasks',input:{name:'Test'}}));assert.equal(calls,1);}
});
test('a malformed model reply is repaired without repeating a completed tool',async t=>{
 let requests=0,writes=0;const url=await server(t,async(req,res)=>{if(req.url==='/v1/toolsets')return res.end(JSON.stringify({platform:'api_server',data:[{enabled:false}]}));for await(const c of req){}requests++;res.end(JSON.stringify({output_text:requests===1?JSON.stringify({tool:'tvm_create_task',input:{name:'Test'}}):requests===2?'```json\n{"reply":"Saved Test"}\n```':JSON.stringify({reply:'Saved Test'})}));});
 const result=await createChat({url,key:'test'}).respond({scope:'test',message:'Create task Test',tools:{tvm_create_task:async()=>{writes++;return {id:'saved'};}}});assert.equal(result.response,'Saved Test');assert.equal(writes,1);assert.equal(requests,3);
});
test('record read failures reach the model as an unavailable result, never an empty record',async()=>{
 const {taskTools}=require('../operations-chat');let writes=0;
 const tools=taskTools(async()=>{throw Object.assign(Error('upstream private detail'),{code:'service_unavailable'});},async()=>{writes++;});
 assert.deepEqual(await tools.tvm_list_tasks({}),{ok:false,error:'service_unavailable',message:'The records could not be read. This does not mean there are no matching records.'});
 await assert.rejects(tools.tvm_create_task({name:'Test'}));assert.equal(writes,1);
});
test('failure replies distinguish failed reads from uncertain writes',()=>{
 const {failureReply}=require('../chat-errors');
 assert.doesNotMatch(failureReply({code:'service_unavailable'}),/already.*succeeded|check.*before.*repeat/i);
 assert.match(failureReply({code:'provider_unavailable',mayWrite:true}),/check.*before.*repeat/i);
 assert.match(failureReply({code:'outcome_uncertain'}),/check.*before.*repeat/i);
 assert.doesNotMatch(failureReply({message:'secret credential'}),/secret credential/);
});
test('a temporary model outage retries once without repeating host actions',async t=>{
 let requests=0;const url=await server(t,async(req,res)=>{if(req.url==='/v1/toolsets')return res.end(JSON.stringify({platform:'api_server',data:[{enabled:false}]}));for await(const c of req){}if(++requests===1){res.statusCode=503;return res.end('{}');}res.end(JSON.stringify({output_text:'{"reply":"Hello"}'}));});
 const r=await createChat({url,key:'test'}).respond({scope:'retry',message:'Hello',tools:{}});assert.equal(r.response,'Hello');assert.equal(requests,2);
});
