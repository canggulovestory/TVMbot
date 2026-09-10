'use strict';
const crypto=require('node:crypto');
function taskTools(invoke,beforeWrite){
 return Object.fromEntries(['list_tasks','list_villas','create_task','complete_task'].map(action=>['tvm_'+action,async(input,options={})=>{
  if(!action.startsWith('list_'))await beforeWrite();
  return invoke({action,input},options);
 }]));
}
function createOperationsChat({chat,channels,turns,finance}){
 async function respond(id,text,history,invoke,signal,financeTools={}){
  const result=await turns(id,text,async({beforeWrite})=>chat.respond({scope:id,message:text,history,signal,tools:{...taskTools(invoke,beforeWrite),...financeTools}}));
  return result.response;
 }
 return {
  authenticateTelegram:channels.telegramIdentity,
  async telegram({message,text,history=[],signal}){
   const user=channels.telegramIdentity(message),day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Makassar'});
   const id=`telegram:${user}:${day}:${crypto.createHash('sha256').update(text).digest('hex')}`;
   return respond(id,text,history,(tool,options)=>channels.fromTelegram(message,tool,options),signal,finance?.telegram(message)||{});
  },
  async web({req,text,history=[],signal}){
   const user=await channels.webIdentity(req);
   // Server-derived daily delivery protects a repeated send after a lost reply.
   const day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Makassar'});
   const id=`admin:${user}:${day}:${crypto.createHash('sha256').update(text).digest('hex')}`;
   return respond(id,text,history,(tool,options)=>channels.fromWeb(req,tool,{...options,deliveryId:id}),signal);
  },
 };
}
module.exports={createOperationsChat,taskTools};
