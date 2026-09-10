'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
test('isolated model receives finance schemas only when host enables them, never a confirm tool',async t=>{
 let calls=0,reply=0;const definitions={finance_read:'Read bound owner accounts',finance_prepare:'Prepare only',finance_receipt:'Read status'};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/toolsets')return res.end(JSON.stringify({platform:'api_server',data:[{enabled:false}]}));
  const body=JSON.parse(raw);assert.ok(body.instructions.includes('Read bound owner accounts'));assert.ok(!body.instructions.includes('Financial access is disabled'));
  res.end(JSON.stringify({output_text:JSON.stringify(reply++?{reply:'Recorded balance checked.'}:{tool:'finance_read',input:{resource:'accounts'}})}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();server.closeAllConnections();});
 const chat=require('../isolated-chat').createChat({url:`http://127.0.0.1:${server.address().port}`,key:'synthetic',financeDefinitions:definitions});
 const result=await chat.respond({scope:'test',message:'saldo?',tools:{finance_read:async()=>{calls++;return {items:[],revision:1};}}});
 assert.match(result.response,/balance/);assert.equal(calls,1);
 await assert.rejects(chat.respond({scope:'test',message:'yes',tools:{finance_confirm:async()=>{throw Error('must not run');}}}),/tool_not_allowed/);
});
