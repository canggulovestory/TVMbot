'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createStore}=require('../contracts/store');
const actor={user:'release-test',role:'admin'};
test('removing passports erases all uploaded sources and candidates but preserves approved fields',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-release-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=createStore(root),d=await store.create(actor);
 const first=await store.addExtraction(actor,d.id,0,Buffer.from('first'),'image/png',{fields:{},warnings:[]});
 await store.approveExtraction(actor,d.id,1,first.id,{'lessee.full_name':'Reviewed Person'});
 await store.addExtraction(actor,d.id,2,Buffer.from('second'),'image/png',{fields:{},warnings:[]});
 await assert.rejects(store.removePassport({user:'other',role:'staff'},d.id,3),/Not found/);
 await assert.rejects(store.removePassport(actor,d.id,2),/Conflict/);
 const removed=await store.removePassport(actor,d.id,3);
 assert.equal(removed.extraction,undefined);assert.equal(removed.data['lessee.full_name'],'Reviewed Person');
 assert.equal((await fs.readdir(root)).filter(n=>n.endsWith('.passport')).length,0);
 await assert.rejects(store.getPassport(actor,d.id),/Not found/);
});
test('private company settings are administrator-only and snapshotted at creation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-company-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=createStore(root);
 await assert.rejects(store.setCompany({user:'staff',role:'staff'},{name:'Example Company'}),/Access denied/);
 await store.setCompany(actor,{name:'Example Company',bank:'Synthetic bank instructions'});
 const first=await store.create(actor);await store.setCompany(actor,{name:'Changed Company',bank:'Changed instructions'});
 assert.equal((await store.get(actor,first.id)).company.name,'Example Company');
 const {renderContract}=require('../contracts/template');const html=renderContract(first.data,{company:first.company});
 assert.ok(html.includes('Example Company'));assert.ok(html.includes('Synthetic bank instructions'));assert.ok(!html.includes('Changed Company'));
});
