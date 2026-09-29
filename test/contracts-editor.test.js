'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createStore}=require('../contracts/store');
test('edits typed while preview refreshes are persisted before autosave finishes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-editor-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=createStore(root),actor={user:'test',role:'staff'},draft=await store.create(actor);
 let release,entered;const refreshing=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let refreshes=0;
 const context={draft,pending:{'lessee.full_name':'Synthetic first edit'},saving:null,timer:null,blocked:false,clearTimeout,status:()=>{},issueList:()=>{},
  api:async(suffix,options)=>{assert.equal(suffix,'/'+draft.id);const input=JSON.parse(options.body);return store.update(actor,draft.id,input.revision,input.fields);},
  preview:async()=>{if(refreshes++===0){entered();await gate;}}
 };
 vm.createContext(context);const source=await fs.readFile(path.join(__dirname,'../admin/contract.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('async function save(){'),source.indexOf('async function list(){')),context);
 const saving=context.save();await refreshing;context.pending={'property.name':'Edit made during preview'};release();await saving;
 assert.equal((await store.get(actor,draft.id)).data['property.name'],'Edit made during preview');
 assert.equal(Object.keys(context.pending).length,0);
});
