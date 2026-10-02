'use strict';
// Real model, synthetic reminder receipt; never schedules or sends a reminder.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {createChat}=require('../isolated-chat'),{createOperationsChat}=require('../operations-chat');
(async()=>{
 const config=JSON.parse(fs.readFileSync('/etc/zuzu-runtime/operations-chat.json','utf8'));
 let saved=0,guarded=0;
 const runner=createOperationsChat({chat:createChat(config.hermes),channels:{telegramIdentity:()=> '100',fromTelegram:async()=>{throw Error('Unexpected TVM operation');}},turns:async(id,text,work)=>work({beforeWrite:async()=>{guarded++;}}),reminders:()=>({personal_add_reminder:async(input,{beforeWrite})=>{assert.match(input.text,/dentist/i);assert.match(input.when,/09:00/);await beforeWrite();saved++;return {ok:true,id:'synthetic',text:input.text,at:input.when,timeZone:'Asia/Makassar'};},personal_list_reminders:async()=>({ok:true,items:[]})})});
 const message={from:{id:100}};
 const first=await runner.telegram({message,text:'Remind me tomorrow to call my dentist. This is personal.'});
 assert.equal(saved,0);assert.match(first,/time|when/i);console.log(first);
 const second=await runner.telegram({message,text:'9 AM Bali time',history:[{role:'user',content:'Remind me tomorrow to call my dentist. This is personal.'},{role:'assistant',content:first}]});
 assert.equal(saved,1);assert.equal(guarded,1);assert.match(second,/dentist/i);console.log(second);
 console.log('PASS: asks for missing time, then creates one synthetic personal reminder with a receipt.');
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
