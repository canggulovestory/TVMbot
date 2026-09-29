'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs');
const path=require('node:path'),crypto=require('node:crypto');
const {blankContract,applyFields}=require('./schema');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// One store instance per directory/process. Multi-process writers require a database lock.
function createStore(root){
 root=path.resolve(root);let queue=Promise.resolve();
 function actorAllowed(actor){if(!actor||!['admin','staff'].includes(actor.role)||typeof actor.user!=='string'||!actor.user.trim())throw Error('Access denied');}
 function file(id){if(typeof id!=='string'||!ID.test(id))throw Error('Invalid contract ID');return path.join(root,id+'.json');}
 function authorize(actor,record){actorAllowed(actor);if(actor.role!=='admin'&&record.createdBy!==actor.user)throw Error('Not found');}
 async function read(id){
  let handle;
  try{handle=await fs.open(file(id),constants.O_RDONLY|constants.O_NOFOLLOW);const r=JSON.parse(await handle.readFile('utf8'));
   if(r.id!==id||!Number.isSafeInteger(r.revision)||!r.data||!Array.isArray(r.history))throw Error('Invalid contract storage');return r;
  }catch(e){if(e.code==='ENOENT')throw Error('Not found');throw e;}finally{await handle?.close();}
 }
 function mutate(work){const result=queue.then(work);queue=result.catch(()=>{});return result;}
 async function save(record){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const dir=await fs.lstat(root);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))throw Error('Contract directory must be private');
  const target=file(record.id),temp=target+'.'+crypto.randomUUID()+'.tmp';let handle;
  try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(record));await handle.sync();await handle.close();handle=null;await fs.rename(temp,target);}
  finally{await handle?.close();await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 return {
  async create(actor){actorAllowed(actor);return mutate(async()=>{
   const now=new Date().toISOString(),r={id:crypto.randomUUID(),templateId:'tvm-standard-lease-v1',revision:0,status:'DRAFT',createdBy:actor.user,createdAt:now,updatedAt:now,data:blankContract(),history:[{revision:0,actor:actor.user,at:now,action:'created'}],versions:[]};
   await save(r);return r;
  });},
  async get(actor,id){actorAllowed(actor);const r=await read(id);authorize(actor,r);return r;},
  async list(actor){
   actorAllowed(actor);let names;try{names=await fs.readdir(root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
   const result=[];for(const name of names){if(!name.endsWith('.json')||!ID.test(name.slice(0,-5)))continue;
    const r=await read(name.slice(0,-5));if(actor.role!=='admin'&&r.createdBy!==actor.user)continue;
    result.push({id:r.id,status:r.status,revision:r.revision,createdBy:r.createdBy,updatedAt:r.updatedAt,propertyName:r.data['property.name'],tenantName:r.data['lessee.full_name']});
   }return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  },
  async update(actor,id,revision,patch){actorAllowed(actor);file(id);return mutate(async()=>{
   const r=await read(id);authorize(actor,r);
   if(!Number.isSafeInteger(revision)||r.revision!==revision)throw Error('Conflict: reload the saved draft before editing');
   const data=applyFields(r.data,patch),changed=Object.keys(data).filter(k=>data[k]!==r.data[k]);
   if(!changed.length)return r;
   r.data=data;r.revision++;r.status='DRAFT';r.updatedAt=new Date().toISOString();
   r.history.push({revision:r.revision,actor:actor.user,at:r.updatedAt,action:'fields updated',fields:changed});
   await save(r);return r;
  });}
 };
}
module.exports={createStore};
