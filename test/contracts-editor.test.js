'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createStore}=require('../contracts/store');
test('edits typed while preview refreshes are persisted before autosave finishes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-editor-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=createStore(root),actor={user:'test',role:'staff'},draft=await store.create(actor);
 let release,entered;const refreshing=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let refreshes=0;
 const context={draft,pending:{'lessee.full_name':'Synthetic first edit'},saving:null,timer:null,blocked:false,clearTimeout,$:()=>({hidden:true}),status:()=>{},issueList:()=>{},
  api:async(suffix,options)=>{assert.equal(suffix,'/'+draft.id);const input=JSON.parse(options.body);return store.update(actor,draft.id,input.revision,input.fields);},
  preview:async()=>{if(refreshes++===0){entered();await gate;}}
 };
 vm.createContext(context);const source=await fs.readFile(path.join(__dirname,'../admin/contract.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('async function save(){'),source.indexOf('async function list(){')),context);
 const saving=context.save();await refreshing;context.pending={'property.name':'Edit made during preview'};release();await saving;
 assert.equal((await store.get(actor,draft.id)).data['property.name'],'Edit made during preview');
 assert.equal(Object.keys(context.pending).length,0);
});
test('opening the editor resumes the latest contract and creates one only when none exist',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../admin/contract.js'),'utf8');
 const start=source.indexOf('async function initialize(){');assert.notEqual(start,-1);
 const init=source.slice(start,source.indexOf('\ninitialize().catch',start));
 for(const items of [[{id:'existing-contract'}],[]]){
  const calls=[],buttons={new:{disabled:true}};
  const context={schema:{},$:id=>buttons[id],api:async(suffix,options)=>{calls.push([suffix,options?.method]);return suffix==='/schema'?{fields:{}}:{id:'new-contract'};},list:async()=>items,open:async id=>calls.push(['open',id])};
  vm.createContext(context);vm.runInContext(init,context);await context.initialize();
  assert.deepEqual(calls.filter(c=>c[0]==='open'),[['open',items.length?'existing-contract':'new-contract']]);
  assert.equal(calls.filter(c=>c[1]==='POST').length,items.length?0:1);
  assert.equal(buttons.new.disabled,false);
 }
});
