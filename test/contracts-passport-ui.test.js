'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

test('passport review uses one clear apply action and hides technical details',()=>{
 const source=fs.readFileSync(require.resolve('../admin/contract.js'),'utf8');
 assert.match(source,/Apply passport details/);
 assert.match(source,/document\.createElement\('details'\)/);
 assert.doesNotMatch(source,/Apply checked, reviewed fields/);
 assert.doesNotMatch(source,/check\.type='checkbox'/);
});
test('review displays warnings and clears stale identity fields when applying a replacement passport',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(require.resolve('../admin/contract.js'),'utf8');
 function element(tag){return {tag,children:[],value:'',append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},reportValidity(){return true;}};}
 const area=element('div'),calls=[];
 const context={base:'/api/contracts',draft:{id:'test',revision:2,extraction:{id:'new-passport',warnings:['Check passport number'],fields:{'lessee.full_name':{value:'Synthetic Tenant'},'lessee.passport_number':{value:null}}}},schema:{},fieldLabels:{},title:x=>x,$:()=>area,document:{createElement:element,createTextNode:x=>x},save:async()=>{},buildFields:()=>{},preview:async()=>{},status:()=>{},showError:e=>{throw e;},api:async(url,options)=>{calls.push(JSON.parse(options.body));return {...context.draft,extraction:null};}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function passportReview(){'),source.indexOf('async function upload(file){')),context);context.passportReview();
 assert.ok(area.children.some(x=>x.className==='warning'&&x.textContent==='Check passport number'));
 await area.children.find(x=>x.textContent==='Apply passport details').onclick();
 assert.equal(calls[0].fields['lessee.passport_number'],'');assert.equal(calls[0].fields['lessee.full_name'],'Synthetic Tenant');
 assert.equal(calls[0].reviewed,true);
});
