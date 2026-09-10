'use strict';
const {createFinanceAdapter}=require('./finance-adapter.cjs');
const {financeTools}=require('./finance-tools.cjs');
const ORIGIN='https://mmvublmtgggppsyqwvkz.supabase.co';
const RPCS=new Set(['finance_assistant_read','finance_assistant_prepare','finance_assistant_receipt']);
// Server-only transport. No service-role key, owner session, arbitrary URL or RPC.
function createFinanceRpc({publicKey,email,password,bridgeUserId},fetcher=fetch){
 let anon=false;try{anon=JSON.parse(Buffer.from(String(publicKey).split('.')[1],'base64url')).role==='anon';}catch(_){}
 if(!/^sb_publishable_[\w-]+$/.test(publicKey||'')&&!anon)throw Error('Financial transport requires a public key');
 if(typeof email!=='string'||!email.includes('@')||typeof password!=='string'||password.length<16||!/^[-a-f0-9]{36}$/i.test(bridgeUserId||''))throw Error('Invalid financial bridge configuration');
 let session=null,login=null;
 async function request(route,body,token,signal){
  const response=await fetcher(ORIGIN+route,{method:'POST',redirect:'error',headers:{apikey:publicKey,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal});
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw Error('Financial response too large');chunks.push(chunk);}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!response.ok){if(response.status===401)session=null;throw Error(typeof result.message==='string'?result.message:'Financial transport unavailable');}
  return result;
 }
 async function authenticate(){
  if(session&&session.until>Date.now())return session.token;
  if(!login)login=(async()=>{
   const result=await request('/auth/v1/token?grant_type=password',{email,password},null,AbortSignal.timeout(10000));
   if(result.user?.id!==bridgeUserId||typeof result.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<60)throw Error('Financial bridge identity mismatch');
   session={token:result.access_token,until:Date.now()+(result.expires_in-30)*1000};return session.token;
  })().finally(()=>{login=null;});
  return login;
 }
 return async(name,args,{signal}={})=>{
  if(!RPCS.has(name))throw Error('Financial RPC not allowed');
  const token=await authenticate();signal?.throwIfAborted();
  // An uncertain prepare is never automatically retried with a new identity.
  return request('/rest/v1/rpc/'+name,args,token,signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000));
 };
}
function createFinanceHost(config,{rpc,authenticateWeb}={}){
 const enabled=config.enabled===true;
 const adapter=createFinanceAdapter({...config,rpc:rpc||(enabled?createFinanceRpc(config):async()=>{throw Error('Disabled');})});
 function tools(user,delivery){
  if(!enabled||user!==config.externalOwnerId)return {};
  const ctx={authenticated:true,externalUserId:user,sourceRequestId:delivery};
  return Object.fromEntries(financeTools.filter(t=>t.name!=='finance_prepare'||config.prepareEnabled===true).map(t=>[t.name,async(input)=>{
   try{return await adapter[t.name.slice(8)](ctx,input);}catch(e){return {ok:false,error:e.message};}
  }]));
 }
 return Object.freeze({
  enabled,prepareEnabled:enabled&&config.prepareEnabled===true,
  definitions:Object.fromEntries(financeTools.map(t=>[t.name,t.description+' Input schema: '+JSON.stringify(t.input_schema)])),
  telegram(message){
   if(config.channel!=='telegram'||!Number.isSafeInteger(message?.from?.id)||message.from.is_bot||message.from.id<1||message.chat?.type!=='private'||message.chat.id!==message.from.id||!Number.isSafeInteger(message.message_id)||message.message_id<1)return {};
   return tools(String(message.from.id),`telegram:${message.chat.id}:${message.message_id}`);
  },
  async web(req,delivery){
   if(config.channel!=='web'||typeof authenticateWeb!=='function')return {};
   const user=await authenticateWeb(req);
   if(typeof delivery!=='string'||!delivery||delivery.length>240)return {};
   return tools(user?.id,delivery);
  },
 });
}
function loadFinanceHost(file,authenticateWeb){
 const fs=require('node:fs');let fd;
 try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return null;throw Error('Financial credentials must be private');}
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||(stat.mode&0o077)||stat.uid!==process.getuid())throw Error('Financial credentials must be private');
  return createFinanceHost(JSON.parse(fs.readFileSync(fd,'utf8')),{authenticateWeb});
 }finally{fs.closeSync(fd);}
}
module.exports={createFinanceRpc,createFinanceHost,loadFinanceHost};
