'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('conversational reminders stay bound to the host user and validate time before saving',async()=>{
 const assistant=require('../assistant'),saved=[];
 const tools=require('../reminder-tools').createReminderTools({...assistant,addReminder:async r=>{saved.push(r);return {...r,id:'test-id'};},listReminders:async key=>[{id:'test-id',userKey:key,text:'Call dentist',at:Date.now()+100000}]},'afni');
 const result=await tools.personal_add_reminder({text:'Call dentist',when:'tomorrow 09:00'});
 assert.equal(result.ok,true);assert.equal(saved[0].userKey,'afni');assert.equal(result.timeZone,'Asia/Makassar');
 for(const input of [{text:'Call',when:'tomorrow'},{text:'Call',when:'2020-01-01 09:00'},{text:'Call',when:'tomorrow 09:00',userKey:'syifa'}])assert.equal((await tools.personal_add_reminder(input)).ok,false);
 assert.equal(saved.length,1);const list=await tools.personal_list_reminders({});assert.equal(list.items[0].userKey,undefined);
});
test('Telegram reminder writes use the durable guard and are never offered to Admin',async()=>{
 const {createOperationsChat}=require('../operations-chat');let guarded=0,saved=0;
 const runner=createOperationsChat({reminders:()=>({personal_add_reminder:async(input,{beforeWrite})=>{await beforeWrite();saved++;return {ok:true,id:'receipt'};}}),channels:{telegramIdentity:()=> '100',webIdentity:async()=> 'owner'},turns:async(id,text,work)=>work({beforeWrite:async()=>{guarded++;}}),chat:{respond:async({tools})=>{if(tools.personal_add_reminder)await tools.personal_add_reminder({text:'Call dentist',when:'tomorrow 09:00'});return {response:'Done'};}}});
 await runner.telegram({message:{from:{id:100}},text:'Remind me'});assert.equal(guarded,1);assert.equal(saved,1);
 await runner.web({req:{},text:'Remind me'});assert.equal(saved,1);
});
test('identical time replies for different reminder requests do not replay the wrong reminder',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reminder-context-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const {createOperationsChat}=require('../operations-chat');let count=0;
 const runner=createOperationsChat({channels:{telegramIdentity:()=> '100'},turns:require('../protected-turns').createTurns(dir),chat:{respond:async({history,tools})=>{const result=await tools.personal_add_reminder({text:history.filter(x=>x.role==='user'&&x.content!=='9 AM').at(-1).content});return {response:result.text};}},reminders:()=>({personal_add_reminder:async(input,{beforeWrite})=>{await beforeWrite();count++;return input;}})});
 const message={from:{id:100}},first=[{role:'user',content:'Remind me to call the dentist'}],second=[{role:'user',content:'Remind me to call the vet'}];
 assert.match(await runner.telegram({message,text:'9 AM',history:first}),/dentist/);
 assert.match(await runner.telegram({message,text:'9 AM',history:second}),/vet/);
 assert.match(await runner.telegram({message,text:'9 AM',history:[...second,{role:'user',content:'9 AM'}]}),/vet/);
 assert.equal(count,2);
});
