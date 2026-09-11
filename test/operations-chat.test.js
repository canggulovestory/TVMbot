'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createOperationsHandler}=require('../operations-connector'),{createOperationsChannels}=require('../operations-channel-client'),{createTurns}=require('../protected-turns');
test('key questions read the authenticated live records without accepting a model false-negative',async()=>{
 const {createOperationsChat}=require('../operations-chat');let models=0,reads=0;
 const channels={telegramIdentity:m=>{if(m.chat.type!=='private'||m.from.id!==100)throw Error('unauthorized');return '100';},async fromTelegram(m,tool){reads++;assert.equal(tool.action,'list_villas');return {ok:true,result:{items:[{id:'v1',name:'Villa Alysaa',keyBoxCode:'TEST-1234'},{id:'v2',name:'Villa Lysa',keyBoxCode:'TEST-5678'}],nextOffset:null}};}};
 const runner=createOperationsChat({channels,chat:{async respond(){models++;return {response:'No saved key code.'};}},turns:async(id,text,work)=>work({beforeWrite(){}})});
 const message={message_id:1,from:{id:100},chat:{id:100,type:'private'}};
 for(const text of ['Alysaa key code?','kode kunci villa alysaa?','sleutelcode Alysaa?']) assert.equal(await runner.telegram({message,text}),'Villa Alysaa — key box code: TEST-1234.');
 assert.equal(models,0);assert.equal(reads,3);
 await assert.rejects(runner.telegram({message:{...message,chat:{type:'group'}},text:'Alysaa key code?'}),/unauthorized/);
 assert.equal(reads,3);
});
test('unconfigured finance reports access unavailable rather than claiming the record is absent',async()=>{
 const {createOperationsChat}=require('../operations-chat');let models=0;
 const runner=createOperationsChat({channels:{telegramIdentity:()=> '100'},chat:{async respond(){models++;return {response:'Not found'};}},turns:async(id,text,work)=>work({beforeWrite(){}})});
 const message={message_id:1,from:{id:100},chat:{id:100,type:'private'}};
 const response=await runner.telegram({message,text:'For rob berawa project, how much is deposit for cabinet?'});
 assert.match(response,/connection.*not configured/i);assert.match(response,/does not mean.*missing/i);assert.equal(models,0);
});
test('key retrieval paginates, refreshes values, rejects ambiguity and propagates lookup failure',async()=>{
 const {createOperationsChat}=require('../operations-chat');let value='FIRST',fail=false;
 const runner=createOperationsChat({channels:{telegramIdentity:()=> '100',async fromTelegram(m,{input}){if(fail)throw Error('service_unavailable');return {ok:true,result:input.offset===0?{items:[{name:'Villa Lysa',keyBoxCode:'OTHER'}],nextOffset:50}:{items:[{name:'Villa Alysaa',keyBoxCode:value}],nextOffset:null}};}},chat:{async respond(){throw Error('model must not answer key lookup');}},turns:async(id,text,work)=>work({beforeWrite(){}})});
 const message={message_id:1,from:{id:100},chat:{id:100,type:'private'}};
 assert.match(await runner.telegram({message,text:'Alysaa key code?'}),/FIRST/);
 value='SECOND';assert.match(await runner.telegram({message,text:'Alysaa key code?'}),/SECOND/);
 const ambiguous=await runner.telegram({message,text:'Lysa or Alysaa key code?'});assert.match(ambiguous,/which villa/i);assert.doesNotMatch(ambiguous,/SECOND|OTHER/);
 fail=true;await assert.rejects(runner.telegram({message,text:'Alysaa key code?'}),/service_unavailable/);
});
test('Telegram chat binds the real sender, writes once per delivery, and exposes no finance tools',async t=>{
 let api;try{api=require('../operations-chat');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}assert.equal(typeof api?.createOperationsChat,'function');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ops-chat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const token='synthetic-telegram-token'.repeat(3);let writes=0,models=0;
 const server=http.createServer(createOperationsHandler({enabled:true,bindings:[{token,actor:'afni',channel:'telegram',canWriteTasks:true}],journalDir:path.join(dir,'broker'),tasks:{async getTasks(){return [];},async createTask(input){writes++;return {id:'12345678-1234-1234-1234-123456789abc',...input};}},villas:{async getAll(){return {villas:[]};}}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();server.closeAllConnections();});
 const channels=createOperationsChannels({enabled:true,url:`http://127.0.0.1:${server.address().port}/v1/operations`,telegramBindings:[{senderId:'100',token}]});
 const chat={async respond({tools}){models++;assert.deepEqual(Object.keys(tools).sort(),['tvm_complete_task','tvm_create_task','tvm_list_tasks','tvm_list_villas']);const saved=await tools.tvm_create_task({name:'Check synthetic villa'},{toolIndex:0});return {response:saved.result.name};}};
 const runner=api.createOperationsChat({chat,channels,turns:createTurns(path.join(dir,'turns'))});
 const message={message_id:1,from:{id:100},chat:{id:100,type:'private'}};
 assert.equal(await runner.telegram({message,text:'Add a TVM task'}),'Check synthetic villa');
 assert.equal(await runner.telegram({message:{...message,message_id:2},text:'Add a TVM task'}),'Check synthetic villa');
 assert.equal(await runner.telegram({message,text:'Add a TVM task'}),'Check synthetic villa');
 assert.equal(writes,1);assert.equal(models,1);
 await assert.rejects(runner.telegram({message:{...message,from:{id:101}},text:'Read villas'}),/unauthorized/);
 assert.equal(models,1);
});
test('Telegram dispatch exposes owner-bound finance tools without changing Admin or task access',async()=>{
 const {createOperationsChat}=require('../operations-chat');let attached=0;
 const channels={telegramIdentity:m=>String(m.from.id),webIdentity:async()=> 'afni',fromTelegram(){},fromWeb(){}};
 const finance={telegram:m=>m.chat.type==='private'&&m.from.id===100?{finance_read:async()=>({revision:9,items:[]})}:{}};
 const chat={async respond({tools}){if(tools.finance_read){attached++;assert.equal((await tools.finance_read({resource:'accounts'})).revision,9);}assert.equal(tools.finance_confirm,undefined);return {response:'Checked'};}};
 const runner=createOperationsChat({chat,channels,finance,turns:async(id,text,work)=>work({beforeWrite(){}})});
 await runner.telegram({message:{from:{id:100},chat:{type:'private'},message_id:1},text:'saldo rekening?'});
 await runner.telegram({message:{from:{id:101},chat:{type:'private'},message_id:1},text:'accounts'});
 await runner.web({req:{},text:'accounts'});assert.equal(attached,1);
});
