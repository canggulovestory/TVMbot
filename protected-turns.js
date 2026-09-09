'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
// One trusted chat host owns this directory; never place it in the model home.
function createTurns(dir){
 if(!path.isAbsolute(dir))throw Error('Private run directory required');
 const inflight=new Map();
 async function execute(id,fingerprint,work){
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  if((await fs.stat(dir)).mode&0o077)throw Error('private_run_directory_required');
  const file=path.join(dir,hash(id)+'.json'),expected=hash(fingerprint);
  let existing;try{existing=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){if(existing.fingerprint!==expected)throw Error('request_conflict');if(existing.state==='done'&&existing.mayWrite)return existing.result;if(!['failed','done'].includes(existing.state))throw Error('outcome_uncertain');}
  async function save(value,first=false){
   const target=first?file:file+'.'+crypto.randomUUID()+'.tmp';
   const fd=await fs.open(target,'wx',0o600);try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}
   if(!first)await fs.rename(target,file);const folder=await fs.open(dir,'r');try{await folder.sync();}finally{await folder.close();}
  }
  const state={fingerprint:expected,state:'pending',at:new Date().toISOString(),mayWrite:false};
  await save(state,!existing);
  try{
   const result=await work({beforeWrite:async()=>{state.mayWrite=true;await save(state);}});
   await save({...state,state:'done',result});return result;
  }catch(e){if(!state.mayWrite)await save({...state,state:'failed'});throw e;}
 }
 return async(id,fingerprint,work)=>{
  if(typeof id!=='string'||!id||typeof fingerprint!=='string')throw Error('invalid_delivery');
  if(inflight.has(id)){await inflight.get(id).catch(()=>{});return execute(id,fingerprint,work);}
  const job=execute(id,fingerprint,work);inflight.set(id,job);try{return await job;}finally{inflight.delete(id);}
 };
}
module.exports={createTurns};
