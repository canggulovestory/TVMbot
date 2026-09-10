'use strict';
const {createHash}=require('node:crypto');
const {intentFields}=require('./finance-tools.cjs');
const ORIGIN='https://financial-ten-inky.vercel.app/';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function object(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('Invalid financial arguments.');
}
function validateIntent(intent){
 object(intent,intentFields);
 if(Object.values(intent).some(v=>v!==null&&typeof v!=='string'))throw Error('Invalid transaction fields.');
 if(!['income','expense','bill_payment'].includes(intent.kind)||intent.currency!=='IDR'||
   !/^[0-9]{1,14}(\.[0-9]{1,2})?$/.test(intent.amount||'')||!/[1-9]/.test(intent.amount)||
   !/^\d{4}-\d{2}-\d{2}$/.test(intent.date||'')||!intent.description?.trim()||intent.description.length>1000)throw Error('Invalid transaction. Provide an exact positive IDR amount, date and description.');
}
function safeFailure(error){
 const messages={
  'Account not found':'Choose an existing account before preparing this transaction.',
  'Invalid category':'Choose an existing category matching the transaction type.',
  'Villa not found':'Choose an existing villa, or leave villa empty for a personal expense.',
  'Bill not found':'Look up the bill again before preparing payment.',
  'Invalid bill period or amount':'Check the current unpaid bill period and remaining amount.',
  'Invalid existing expense':'Select a matching already-recorded expense.',
  'Invalid existing expense: already linked':'That expense is already linked to a payment receipt.',
  'Invalid future payment date':'Only expenses can be scheduled. Record income or bill payments after the money moves.',
  'Unsupported account currency':'This connection supports IDR accounts only.',
  'Unsupported category currency':'This connection cannot post to separate-currency trackers.',
  'Conflict: records or date changed; restart lookup':'Financial records changed. Restart the lookup.',
  'Request ID already used':'This message already prepared different details. Send the corrected transaction as a new message.',
  'Access denied':'Financial access is not authorized.',
  'Proposal not found':'This proposal is unavailable to your account.'
 };
 if(Object.hasOwn(messages,error?.message))return Error(messages[error.message]);
 const prefix='Duplicate entry: review previous receipt ',reference=String(error?.message||'').slice(prefix.length);
 if(error?.message?.startsWith(prefix)&&uuid(reference))return Error('A matching entry is already saved. Review receipt '+reference+' before requesting an additional transaction.');
 return Error('Financial service unavailable. No other provider was contacted.');
}
function createFinanceAdapter({rpc,externalOwnerId,channel,enabled=false,prepareEnabled=false,timeoutMs=15000}){
 if(typeof rpc!=='function'||!['telegram','web'].includes(channel)||typeof externalOwnerId!=='string'||!externalOwnerId)throw Error('Invalid financial adapter configuration.');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('Invalid financial deadline.');
 function authorize(ctx){
  if(ctx?.authenticated!==true||ctx.externalUserId!==externalOwnerId)throw Error('Access denied.');
  if(enabled!==true)throw Error('Financial connection is disabled.');
 }
 async function call(name,args){
  const controller=new AbortController();let timer;
  try{
   return await Promise.race([
    Promise.resolve().then(()=>rpc(name,args,{signal:controller.signal})),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Deadline'));},timeoutMs);})
   ]);
  }catch(error){throw safeFailure(error);}
  finally{clearTimeout(timer);}
 }
 function resultLink(result){
  if(!result||!uuid(result.proposalId))throw Error('Invalid financial service response.');
  // Ignore confirmationPath/URLs from RPC or model; only this fixed site may confirm.
  return {...result,confirmationUrl:ORIGIN+'?financeProposal='+result.proposalId};
 }
 return Object.freeze({
  async read(ctx,args){
   authorize(ctx);object(args,['resource','filters','pageSize','cursor']);
   if(!['accounts','villas','categories','transactions','unpaid_bills'].includes(args.resource))throw Error('Invalid financial resource.');
   if(args.pageSize!=null&&(!Number.isInteger(args.pageSize)||args.pageSize<1||args.pageSize>50))throw Error('Invalid page size.');
   if(args.filters!=null){
    const keys=args.resource==='transactions'?['query','accountId','villaId','categoryId','dateFrom','dateTo']:args.resource==='unpaid_bills'?['query','villaId','categoryId','dateFrom','dateTo']:['query'];
    object(args.filters,keys);
    if(Object.values(args.filters).some(v=>typeof v!=='string'||!v||v.length>150))throw Error('Invalid filters.');
   }
   if(args.cursor!=null&&(typeof args.cursor!=='object'||Array.isArray(args.cursor)))throw Error('Invalid cursor.');
   return call('finance_assistant_read',{resource:args.resource,filters:args.filters||{},page_size:args.pageSize||20,cursor:args.cursor||null});
  },
  async prepare(ctx,args){
   authorize(ctx);if(prepareEnabled!==true)throw Error('Transaction preparation is disabled.');
   object(args,['intent','duplicateOf']);validateIntent(args.intent);
   if(args.duplicateOf!=null&&!uuid(args.duplicateOf))throw Error('Invalid duplicate reference.');
   if(typeof ctx.sourceRequestId!=='string'||!ctx.sourceRequestId||ctx.sourceRequestId.length>240)throw Error('A trusted delivery ID is required.');
   const source=channel+':'+createHash('sha256').update(JSON.stringify([externalOwnerId,ctx.sourceRequestId])).digest('hex');
   return resultLink(await call('finance_assistant_prepare',{source_request_id:source,intent:args.intent,duplicate_of:args.duplicateOf||null}));
  },
  async receipt(ctx,args){
   authorize(ctx);object(args,['proposalId']);if(!uuid(args.proposalId))throw Error('Invalid proposal reference.');
   return resultLink(await call('finance_assistant_receipt',{proposal_id:args.proposalId}));
  }
 });
}
module.exports={createFinanceAdapter};
