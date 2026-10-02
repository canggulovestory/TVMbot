'use strict';
// Actual isolated model; synthetic facts only. No Telegram sends or record writes.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {createChat}=require('../isolated-chat');
(async()=>{
 const config=JSON.parse(fs.readFileSync('/etc/zuzu-runtime/operations-chat.json','utf8'));
 const chat=createChat(config.hermes),history=[];let unexpectedTools=0;
 const runner=require('../operations-chat').createOperationsChat({chat,channels:{telegramIdentity:()=> '100',fromTelegram:async()=>{unexpectedTools++;throw Error('Unexpected record access');}},turns:async(id,text,work)=>work({beforeWrite(){throw Error('No writes allowed in this probe');}})});
 for(const [message,pattern] of [
  ['Hi Zuzu',/\w/],
  ['The agreed phase amount is 154600 USDT. He paid 82480 USDT. How much payment is left?',/72[,. ]?120/],
  ['And if he pays another 10000 USDT, how much remains?',/62[,. ]?120/],
  ['What is the latest saved bank balance? Do not use the numbers above as a bank balance.',/not connected|not configured|unavailable|cannot|can.t|don.t have/i]
 ]){
  const r={response:await runner.telegram({message:{message_id:1,from:{id:100},chat:{id:100,type:'private'}},text:message,history})};
  assert.equal(unexpectedTools,0);
  assert.match(r.response,pattern);history.push({role:'user',content:message},{role:'assistant',content:r.response});console.log(JSON.stringify({message,response:r.response}));
 }
 let reads=0;
 const r=await chat.respond({scope:'quality-read-failure',message:'What TVM tasks are open?',tools:{tvm_list_tasks:async()=>{reads++;return {ok:false,error:'service_unavailable',message:'Records temporarily unavailable, not an empty task list.'};}}});
 assert.ok(reads>0);assert.match(r.response,/unavailable|couldn.t|cannot|can.t|unable|failed|trouble/i);assert.doesNotMatch(r.response,/no (?:open )?tasks/i);console.log(JSON.stringify({message:'Read unavailable',response:r.response}));
 console.log('PASS: real-model conversation checks');
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
