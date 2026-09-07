'use strict';
const {randomUUID}=require('node:crypto');

// Short-lived delivery state, not a permanent transcript. A disconnected browser
// loses its lease; approval is never inferred from a missing response.
function createRuns({approvalMs=90000,runMs=180000,leaseMs=45000}={}){
  const records=new Map();
  const key=(owner,id)=>JSON.stringify([owner,id]);
  const publicRun=r=>({id:r.id,status:r.status,reply:r.reply||'',error:r.error||'',approval:r.approval});
  function find(owner,id){return records.get(key(owner,id))}
  function cancel(owner,id){
    const r=find(owner,id);
    if(!r||!['running','approval','cancelling'].includes(r.status))return false;
    r.status='cancelling';r.controller.abort();return true;
  }
  function start({owner,id,message,work}){
    if(!/^[a-f0-9-]{36}$/i.test(id||''))throw Error('Invalid chat request ID.');
    const old=find(owner,id);
    if(old){if(old.message!==message)throw Error('Request ID already used.');return publicRun(old)}
    for(const [k,r] of records)if(r.finished&&Date.now()-r.finished>600000)records.delete(k);
    if(records.size>=200||[...records.values()].some(r=>r.owner===owner&&!r.finished))throw Error('A chat request is already running. Wait or cancel it first.');
    const r={id,owner,message,status:'running',approval:null,controller:new AbortController(),seen:Date.now()};
    records.set(key(owner,id),r);
    const deadline=setTimeout(()=>cancel(owner,id),runMs);
    const lease=setInterval(()=>{if(Date.now()-r.seen>leaseMs)cancel(owner,id)},Math.min(leaseMs,5000));
    deadline.unref?.();lease.unref?.();
    const onApproval=(event,{signal})=>{
      const command=String(event.command||'');
      if(signal.aborted||r.controller.signal.aborted||event.smart_denied||!event.choices?.includes('once')||!command||command.length>2500)return Promise.resolve('deny');
      return new Promise(resolve=>{
        const approval={token:randomUUID(),command,expiresAt:Date.now()+approvalMs};
        r.approval=approval;r.status='approval';
        const finish=choice=>{
          if(r.approval!==approval)return;
          clearTimeout(timer);signal.removeEventListener('abort',deny);r.controller.signal.removeEventListener('abort',deny);
          r.approval=null;r.finishApproval=null;if(!r.controller.signal.aborted)r.status='running';
          resolve(choice);
        };
        const deny=()=>finish('deny'),timer=setTimeout(deny,approvalMs);
        r.finishApproval=finish;
        signal.addEventListener('abort',deny,{once:true});r.controller.signal.addEventListener('abort',deny,{once:true});
        if(signal.aborted||r.controller.signal.aborted)deny();
      });
    };
    Promise.resolve().then(()=>work({onApproval,signal:r.controller.signal})).then(reply=>{
      if(!String(reply||'').trim())throw Error('No reply received.');
      r.reply=String(reply).slice(0,6000);r.status='completed';
    }).catch(()=>{
      r.status='failed';r.error='The request could not finish. Check saved records before repeating an action.';
    }).finally(()=>{
      if(r.controller.signal.aborted){r.status='cancelled';r.reply='';r.error='Request cancelled or expired. Check saved records before repeating an action.'}
      r.finished=Date.now();clearTimeout(deadline);clearInterval(lease);
    });
    return publicRun(r);
  }
  function get(owner,id){const r=find(owner,id);if(!r)return null;r.seen=Date.now();return publicRun(r)}
  function decide(owner,id,token,choice){
    const r=find(owner,id);
    if(!r||r.status!=='approval'||r.approval?.token!==token||r.approval.expiresAt<=Date.now()||!['once','deny'].includes(choice))return false;
    r.finishApproval(choice);return true;
  }
  return {start,get,decide,cancel};
}
module.exports={createRuns};
