'use strict';
const crypto=require('node:crypto');
const normalized=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const keyQuestion=text=>/\b(key\s*(?:box|code)|kode\s*kunci|sleutelcode)\b/i.test(text)&&! /\b(save|set|change|update|delete|remove|task|todo|remind|reminder|tugas|herinner|simpan|ubah|ganti|verander|wijzig)\b/i.test(text);
const financeQuestion=text=>/\b(finance|deposit|quotation|invoice|payment|rekening|saldo|aanbetaling|offerte|factuur)\b/i.test(text)&&! /\b(task|todo|remind|reminder|tugas|herinner)\b/i.test(text);
async function keyAnswer(text,invoke,signal){
 const records=[];let offset=0;
 do{
  const response=await invoke({action:'list_villas',input:{offset,limit:50}},{signal});
  if(response?.ok!==true||!Array.isArray(response.result?.items))throw Error('service_unavailable');
  records.push(...response.result.items);
  const next=response.result.nextOffset;
  if(next===null||next===undefined)break;
  if(!Number.isInteger(next)||next<=offset||next>1000)throw Error('service_unavailable');
  offset=next;
 }while(true);
 const query=' '+normalized(text)+' ';
 const matches=records.filter(v=>{
  const name=normalized(v.name).replace(/^villa\s+/,''),code=normalized(v.code);
  return name&&query.includes(' '+name+' ')||code&&query.includes(' '+code+' ');
 });
 if(matches.length>1)return `Which villa do you mean: ${matches.map(v=>v.name).join(' or ')}?`;
 if(!matches.length)return null; // Unrecognized names stay with the conversational resolver; never guess a key.
 const villa=matches[0];
 return villa.keyBoxCode?`${villa.name} — key box code: ${villa.keyBoxCode}.`:`${villa.name} has no key box code in its current saved record.`;
}
function taskTools(invoke,beforeWrite){
 return Object.fromEntries(['list_tasks','list_villas','create_task','complete_task'].map(action=>['tvm_'+action,async(input,options={})=>{
  if(!action.startsWith('list_'))await beforeWrite();
  return invoke({action,input},options);
 }]));
}
function createOperationsChat({chat,channels,turns,finance}){
 async function respond(id,text,history,invoke,signal,financeTools={}){
  if(keyQuestion(text)){
   const answer=await keyAnswer(text,invoke,signal);if(answer)return answer;
  }
  const previous=history.filter(item=>item.role==='user').at(-1)?.content||'';
  if(!financeTools.finance_read&&(financeQuestion(text)||(/^villa\s+\S+(?:\s+\S+)?[?.!]?$/i.test(text.trim())&&financeQuestion(previous))))return 'The Financial connection is not configured in this chat, so I cannot look up that amount yet. This does not mean the saved record is missing. Please check Financial: https://financial-ten-inky.vercel.app/';
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
