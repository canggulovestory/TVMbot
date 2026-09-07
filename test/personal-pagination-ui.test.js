'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('failed pagination restores the last successful page and leaves navigation usable',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'../personal/index.html'),'utf8');
  let rendered=false,error;
  const context={loadVersion:0,recordOffset:80,recordQuery:'new query',loadedQuery:'old query',data:{offset:40},document:{querySelectorAll:()=>[]},URLSearchParams,api:async()=>{throw Error('Offline')},render:()=>{rendered=true},showError:e=>{error=e.message},login(){}};
  vm.createContext(context);vm.runInContext(html.slice(html.indexOf('async function load(){'),html.lastIndexOf('load();')),context);
  await context.load();
  assert.equal(context.recordOffset,40);assert.equal(context.recordQuery,'old query');assert.equal(rendered,true);assert.equal(error,'Offline');
});
