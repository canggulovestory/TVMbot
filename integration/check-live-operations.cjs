'use strict';
// Read-only check. Never sends Telegram messages or writes business records.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
async function main(){
 const config=JSON.parse(fs.readFileSync('/etc/zuzu-runtime/operations-chat.json','utf8'));
 const channels=require('../operations-channel-client').createOperationsChannels(config.operations);
 const owner=Number(process.env.AFNI_TELEGRAM_ID),message={message_id:Date.now(),from:{id:owner,is_bot:false},chat:{id:owner,type:'private'}};
 const villas=(await channels.fromTelegram(message,{action:'list_villas',input:{search:'Lourinka'}})).result.items;
 assert.ok(villas.length===1);assert.ok(villas[0].electricityDetails);
 assert.ok(!Object.hasOwn(villas[0],'yearlyRate'));assert.ok(!Object.hasOwn(villas[0],'internetPaymentDetails'));
 const tasks=await channels.fromTelegram(message,{action:'list_tasks',input:{limit:1}});assert.ok(Array.isArray(tasks.result.items));
 await assert.rejects(channels.fromTelegram({...message,chat:{id:-1,type:'group'}},{action:'list_villas',input:{}}),/unauthorized/);
 await assert.rejects(channels.fromTelegram(message,{action:'finance_read',input:{}}),/action_not_allowed/);
 const brain=require('../brain');require('../assistant').init(path.join(root,'data'));require('../villa-data').init(path.join(root,'data'));
 brain.init();
 const reply=await brain.processMessage({telegramId:String(owner),telegramMessage:message,text:'Read-only connection check. Look up Villa Lourinka using your TVM villa tool and report its saved PLN electricity meter number. Do not change any records.'});
 const digits=String(villas[0].electricityDetails).match(/\d{10,13}/)?.[0];
 assert.ok(digits&&reply.replace(/[\s.-]/g,'').includes(digits));
 console.log('PASS: live task/villa reads, Telegram host/model routing, group rejection and finance denial. No business writes or Telegram sends.');
}
main().catch(e=>{console.error('Live operations check failed:',e.code||e.name);process.exitCode=1;});
