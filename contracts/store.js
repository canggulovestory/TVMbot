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
 function authorize(actor,record){actorAllowed(actor);if(actor.role!=='admin'&&actor.scope!=='contracts'&&record.createdBy!==actor.user)throw Error('Not found');}
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
 async function privateRoot(){
  await fs.mkdir(root,{recursive:true,mode:0o700});const dir=await fs.lstat(root);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))throw Error('Contract directory must be private');
 }
 return {
  async getCompany(actor){actorAllowed(actor);try{const h=await fs.open(path.join(root,'company.json'),constants.O_RDONLY|constants.O_NOFOLLOW);try{return JSON.parse(await h.readFile('utf8'));}finally{await h.close();}}catch(e){if(e.code==='ENOENT')return {};throw e;}},
  async setCompany(actor,input){actorAllowed(actor);if(actor.role!=='admin')throw Error('Access denied');
   const keys=['name','registered_address','country','nib','representative','header_address','contact','bank'];
   if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>!keys.includes(k))||Object.values(input).some(v=>typeof v!=='string'||v.length>2000))throw Error('Invalid company settings');
   return mutate(async()=>{await privateRoot();const temp=path.join(root,'company.'+crypto.randomUUID()+'.tmp');try{await fs.writeFile(temp,JSON.stringify(input),{mode:0o600,flag:'wx'});await fs.rename(temp,path.join(root,'company.json'));}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}return input;});
  },
  async removePassport(actor,id,revision){actorAllowed(actor);return mutate(async()=>{
   const r=await read(id);authorize(actor,r);if(r.revision!==revision)throw Error('Conflict: reload before removing passport');
   const ids=new Set(r.history.filter(h=>h.extractionId).map(h=>h.extractionId));if(r.extraction)ids.add(r.extraction.id);
   for(const source of ids){file(source);await fs.unlink(path.join(root,source+'.passport')).catch(e=>{if(e.code!=='ENOENT')throw e;});}
   delete r.extraction;r.revision++;r.updatedAt=new Date().toISOString();r.history.push({revision:r.revision,actor:actor.user,at:r.updatedAt,action:'passport sources removed'});await save(r);return r;
  });},
  async create(actor){actorAllowed(actor);return mutate(async()=>{
   const now=new Date().toISOString(),r={id:crypto.randomUUID(),templateId:'tvm-standard-lease-v1',revision:0,status:'DRAFT',createdBy:actor.user,createdAt:now,updatedAt:now,data:blankContract(),company:await this.getCompany(actor),history:[{revision:0,actor:actor.user,at:now,action:'created'}],versions:[]};
   await save(r);return r;
  });},
  async get(actor,id){actorAllowed(actor);const r=await read(id);authorize(actor,r);return r;},
  async addExtraction(actor,id,revision,bytes,mime,result){actorAllowed(actor);file(id);return mutate(async()=>{
   const r=await read(id);authorize(actor,r);if(r.revision!==revision)throw Error('Conflict: reload before uploading again');
   if(!Buffer.isBuffer(bytes)||bytes.length>10*1024*1024)throw Error('Invalid passport upload');
   const extraction={id:crypto.randomUUID(),mime,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString(),createdBy:actor.user,...result,reviewedBy:null};
   const handle=await fs.open(path.join(root,extraction.id+'.passport'),'wx',0o600);
   try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
   r.extraction=extraction;r.revision++;r.status='DRAFT';r.updatedAt=extraction.createdAt;
   r.history.push({revision:r.revision,actor:actor.user,at:r.updatedAt,action:'passport extracted',extractionId:extraction.id});await save(r);for(const old of r.history.filter(h=>h.extractionId&&h.extractionId!==extraction.id)){file(old.extractionId);await fs.unlink(path.join(root,old.extractionId+'.passport')).catch(e=>{if(e.code!=='ENOENT')throw e;});}return extraction;
  });},
  async getPassport(actor,id){actorAllowed(actor);const r=await read(id);authorize(actor,r);if(!r.extraction)throw Error('Not found');
   file(r.extraction.id);const handle=await fs.open(path.join(root,r.extraction.id+'.passport'),constants.O_RDONLY|constants.O_NOFOLLOW);
   try{return {bytes:await handle.readFile(),mime:r.extraction.mime};}finally{await handle.close();}
  },
  async approveExtraction(actor,id,revision,extractionId,patch){actorAllowed(actor);return mutate(async()=>{
   const r=await read(id);authorize(actor,r);
   if(r.revision!==revision||r.extraction?.id!==extractionId)throw Error('Conflict: review the latest uploaded passport');
   if(!patch||!Object.keys(patch).length||Object.keys(patch).some(k=>!k.startsWith('lessee.')))throw Error('Invalid passport review fields');
   r.data=applyFields(r.data,patch);r.revision++;r.status='DRAFT';r.updatedAt=new Date().toISOString();
   r.extraction.reviewedBy=actor.user;r.extraction.reviewedAt=r.updatedAt;r.extraction.approvedFields={...patch};
   r.history.push({revision:r.revision,actor:actor.user,at:r.updatedAt,action:'passport review approved',fields:Object.keys(patch)});await save(r);return r;
  });},
  async list(actor){
   actorAllowed(actor);let names;try{names=await fs.readdir(root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
   const result=[];for(const name of names){if(!name.endsWith('.json')||!ID.test(name.slice(0,-5)))continue;
    const r=await read(name.slice(0,-5));if(actor.role!=='admin'&&actor.scope!=='contracts'&&r.createdBy!==actor.user)continue;
    result.push({id:r.id,status:r.status,revision:r.revision,createdBy:r.createdBy,updatedAt:r.updatedAt,propertyName:r.data['property.name'],tenantName:r.data['lessee.full_name']});
   }return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  },
  async addVersion(actor,id,revision,pdf,templateHash){actorAllowed(actor);file(id);return mutate(async()=>{
   const r=await read(id);authorize(actor,r);
   if(!Number.isSafeInteger(revision)||revision!==r.revision)throw Error('Conflict: reload the saved draft before generating');
   const existing=r.versions.find(v=>v.revision===revision&&v.templateHash===templateHash);if(existing)return existing;
   if(!Buffer.isBuffer(pdf)||pdf.length>20*1024*1024||pdf.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid generated PDF');
   const version={id:crypto.randomUUID(),revision,templateHash,sha256:crypto.createHash('sha256').update(pdf).digest('hex'),createdAt:new Date().toISOString(),createdBy:actor.user,snapshot:{...r.data}};
   const handle=await fs.open(path.join(root,version.id+'.pdf'),'wx',0o600);
   try{await handle.writeFile(pdf);await handle.sync();}finally{await handle.close();}
   r.versions.push(version);r.status='GENERATED';r.updatedAt=version.createdAt;
   r.history.push({revision,actor:actor.user,at:version.createdAt,action:'PDF generated',versionId:version.id});
   await save(r);return version;
  });},
  async getVersion(actor,id,versionId){actorAllowed(actor);file(id);file(versionId);
   const r=await read(id);authorize(actor,r);const v=r.versions.find(x=>x.id===versionId);if(!v)throw Error('Not found');
   const handle=await fs.open(path.join(root,versionId+'.pdf'),constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const pdf=await handle.readFile();if(crypto.createHash('sha256').update(pdf).digest('hex')!==v.sha256)throw Error('Invalid PDF storage');return {...v,pdf};}finally{await handle.close();}
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
