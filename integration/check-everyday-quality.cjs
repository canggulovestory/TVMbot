'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const {createChat}=require('../isolated-chat');
const {createOperationsChat}=require('../operations-chat');
(async()=>{
 const config=JSON.parse(fs.readFileSync('/etc/zuzu-runtime/operations-chat.json','utf8'));
 const chat=createChat(config.hermes);let reads=0,writes=0;
 const runner=createOperationsChat({chat,channels:{telegramIdentity:()=> '100',fromTelegram:async(m,{action,input})=>{if(!action.startsWith('list_')){writes++;throw Error('unexpected write');}reads++;return {ok:true,result:{items:action==='list_tasks'?[{id:'11111111-1111-4111-8111-111111111111',name:'Inspect Test Villa pool pump',done:false,dueDate:'2026-10-03'}]:[{id:'synthetic-villa',name:'Test Villa',code:'SYN001',cleaningSchedule:'Tuesday and Friday, 10 AM',keyBoxCode:'SYNTHETIC-4321'}],nextOffset:null}};}},turns:async(id,text,work)=>work({beforeWrite(){throw Error('Writes forbidden in probe');}})});
 const message={message_id:1,from:{id:100},chat:{id:100,type:'private'}};
 const cases=[
  {text:'Apa tugas TVM yang belum selesai?',match:/Inspect Test Villa pool pump/i,read:true},
  {text:'When does Test Villa get cleaned?',match:/Tuesday.*Friday|Friday.*Tuesday/i,read:true},
  {text:'What is the key box code for Test Villa?',match:/SYNTHETIC-4321/,read:true},
  {text:'Actually the payment was 83000 USDT, not 82480. How much is left?',history:[{role:'user',content:'This phase is 154600 USDT and he paid 82480 USDT.'},{role:'assistant',content:'72120 USDT remains.'}],match:/71[,. ]?600/},
  {text:'The total is 500000 AUD. Subtract 37500 and 17166 AUD, then divide the remainder into two equal phases.',match:/222[,. ]?667/},
  {text:'Convert 10000 AUD to USDT using today’s exchange rate.',match:/rate|live|current/i},
  {text:'Can you remind me tomorrow to call my dentist? This is personal, not a TVM task.',match:/remind|personal|cannot|can.t/i}
 ];
 for(const c of cases){const before=reads;const response=await runner.telegram({message,text:c.text,history:c.history||[]});console.log(JSON.stringify({question:c.text,response}));assert.match(response,c.match);if(c.read)assert.ok(reads>before);assert.equal(writes,0);}
 console.log('PASS: seven broader response cases; zero writes');
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
