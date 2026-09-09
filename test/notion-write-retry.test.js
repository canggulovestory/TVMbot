'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('task write sends one request when Notion returns a retryable failure',async()=>{
 const {Client}=require('@notionhq/client');let attempts=0;
 const sandbox={module:{exports:{}},process:{env:{NOTION_TOKEN:'synthetic',NOTION_TASKS_DB:'synthetic'}},require(name){assert.equal(name,'@notionhq/client');return {Client:class extends Client{constructor(options){super({...options,logger:()=>{},fetch:async()=>{attempts++;return new Response(JSON.stringify({object:'error',status:503,code:'service_unavailable',message:'synthetic'}),{status:503,headers:{'content-type':'application/json','retry-after':'0'}});}});}}};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../notion'),'utf8'),sandbox);
 sandbox.module.exports.init();await assert.rejects(sandbox.module.exports.createTask({name:'synthetic'}));assert.equal(attempts,1);
});
