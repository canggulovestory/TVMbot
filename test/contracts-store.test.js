'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createStore}=require('../contracts/store');
const afni={user:'afni',role:'admin'},staff={user:'staff',role:'staff'},other={user:'other',role:'staff'};
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-store-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,store:createStore(root)};}
test('drafts survive restart with private permissions and revision history',async t=>{
 const {root,store}=await setup(t),d=await store.create(staff);
 const changed=await store.update(staff,d.id,0,{'property.name':'External property'});
 assert.equal(changed.revision,1);assert.equal(changed.status,'DRAFT');
 const restored=await createStore(root).get(staff,d.id);
 assert.equal(restored.data['property.name'],'External property');
 assert.equal(restored.history.length,2);assert.equal(restored.history[0].revision,0);
 assert.equal((await fs.stat(path.join(root,d.id+'.json'))).mode&0o777,0o600);
 assert.equal((await fs.stat(root)).mode&0o777,0o700);
});
test('access checks reject owner roles, other staff and traversal without leaking records',async t=>{
 const {store}=await setup(t),d=await store.create(staff);
 for(const actor of [null,{user:'staff',role:'owner'},{user:'staff',role:'unknown'},other])await assert.rejects(store.get(actor,d.id),/Access denied|Not found/);
 await assert.rejects(store.get(afni,'../users'),/Invalid/);
 assert.equal((await store.get(afni,d.id)).id,d.id);
 assert.equal((await store.list(other)).length,0);
 await assert.rejects(store.create({user:'guest',role:'owner'}),/Access denied/);
});
test('concurrent autosaves produce one success and one conflict, never lost updates',async t=>{
 const {store}=await setup(t),d=await store.create(staff);
 const results=await Promise.allSettled([
  store.update(staff,d.id,0,{'property.name':'First'}),store.update(staff,d.id,0,{'property.name':'Second'})
 ]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.match(results.find(x=>x.status==='rejected').reason.message,/Conflict/);
 assert.equal((await store.get(staff,d.id)).data['property.name'],'First');
 await assert.rejects(store.update(staff,d.id,1,{'template.html':'changed'}),/Invalid/);
 assert.equal((await store.get(staff,d.id)).revision,1);
});
test('corrupt storage fails visibly and records are not capped at 200',async t=>{
 const {root,store}=await setup(t);
 for(let n=0;n<201;n++)await store.create(staff);
 assert.equal((await store.list(afni)).length,201);
 const d=(await store.list(staff))[0];
 await fs.writeFile(path.join(root,d.id+'.json'),'{broken');
 await assert.rejects(store.get(staff,d.id));
 assert.equal(await fs.readFile(path.join(root,d.id+'.json'),'utf8'),'{broken');
});
