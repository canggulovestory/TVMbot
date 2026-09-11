'use strict';
// Read-only application entry-point check; never sends a Telegram message or prints codes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
async function main(){
 const config=JSON.parse(fs.readFileSync('/etc/zuzu-runtime/operations-chat.json','utf8'));
 const channels=require('../operations-channel-client').createOperationsChannels(config.operations);
 const owner=Number(process.env.AFNI_TELEGRAM_ID),message={message_id:Date.now(),from:{id:owner,is_bot:false},chat:{id:owner,type:'private'}};
 const records=(await channels.fromTelegram(message,{action:'list_villas',input:{search:'Alysaa'}})).result.items;
 assert.equal(records.length,1);assert.ok(records[0].keyBoxCode);
 const brain=require('../brain');require('../assistant').init(path.join(root,'data'));require('../villa-data').init(path.join(root,'data'));brain.init();
 for(const text of ['Alysaa key code?','kode kunci Alysaa?','sleutelcode Alysaa?']){
  const reply=await brain.processMessage({telegramId:String(owner),telegramMessage:message,text});
  assert.equal(reply,`${records[0].name} — key box code: ${records[0].keyBoxCode}.`);
 }
 const rejected=await brain.processMessage({telegramId:String(owner),telegramMessage:{...message,chat:{id:-1,type:'group'}},text:'Alysaa key code?'});
 assert.equal(rejected,null);
 if(!fs.existsSync('/etc/zuzu-finance/telegram.json')){
  for(const text of ['For rob berawa project, how much is deposit for cabinet?','Villa lakshmi']){
   const reply=await brain.processMessage({telegramId:String(owner),telegramMessage:message,text});
   assert.match(reply,/connection.*not configured/i);assert.match(reply,/does not mean.*missing/i);
  }
 }
 console.log('PASS: actual Telegram application path reads the current Alysaa key in English, Indonesian and Dutch, denies group access, and handles the finance question/follow-up honestly. No business writes or Telegram messages.');
}
main().catch(error=>{console.error('Live retrieval check failed:',error.code||error.name);process.exitCode=1;});
