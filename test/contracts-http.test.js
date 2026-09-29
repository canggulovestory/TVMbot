'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createStore}=require('../contracts/store');
const {createHandler,createPageHandler}=require('../contracts/routes');
test('real contract HTTP API enforces session, origin, object access and revision checks',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-http-'));
 const users={staff:{user:'staff',role:'staff'},other:{user:'other',role:'staff'},owner:{user:'owner',role:'owner'}};
 const store=createStore(root);await store.setCompany({user:'admin',role:'admin'},{name:'Synthetic Company'});
 const handler=createHandler({store,origin:'https://thevillamanagers.cloud',resolveActor:async req=>users[req.headers['x-test-user']]||null});
 const server=http.createServer((req,res)=>handler(req,res).catch(()=>{res.writeHead(500);res.end();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}/api/admin/contracts`;
 const request=(suffix='',method='GET',body,user='staff',origin='https://thevillamanagers.cloud')=>fetch(base+suffix,{method,headers:{'x-test-user':user,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 assert.equal((await request('','GET',undefined,'nobody')).status,401);
 assert.equal((await request('','GET',undefined,'owner')).status,403);
 assert.equal((await request('','POST',{},'staff','https://evil.test')).status,403);
 assert.equal((await request('','POST',{},'staff','')).status,403);
 const made=await request('','POST',{});assert.equal(made.status,201);const draft=await made.json();
 assert.equal((await request('/'+draft.id,'GET',undefined,'other')).status,404);
 const update=await request('/'+draft.id,'PATCH',{revision:0,fields:{'property.name':'Synthetic Villa'}});assert.equal(update.status,200);
 assert.equal((await update.json()).data['property.name'],'Synthetic Villa');
 assert.equal((await request('/'+draft.id,'PATCH',{revision:0,fields:{'property.name':'Stale'}})).status,409);
 assert.equal((await request('/'+draft.id,'PATCH',{revision:1,fields:{'bank.name':'Changed'}})).status,422);
 assert.equal((await request('/'+draft.id,'PATCH',{revision:1,fields:{},createdBy:'other'})).status,422);
 const read=await request('/'+draft.id);assert.equal(read.headers.get('cache-control'),'no-store');
 assert.equal((await read.json()).revision,1);
 assert.equal((await request('/not-a-contract')).status,404);
 const preview=await request('/'+draft.id+'/preview');assert.equal(preview.status,200);assert.match(await preview.text(),/Synthetic Villa/);
 assert.equal((await request('/'+draft.id+'/preview','GET',undefined,'other')).status,404);
 assert.equal((await request('/'+draft.id+'/pdf','POST',{revision:1,reviewed:true})).status,422);
 assert.ok((await (await request('/schema')).json()).fields['property.name']);
 const completed=await request('/'+draft.id,'PATCH',{revision:1,fields:{
  'lessee.full_name':'Synthetic Guest','lessee.passport_number':'TEST123','lessee.nationality':'Synthetic',
  'property.address':'Synthetic Street','property.bedrooms':'2','property.bathrooms':'2',
  'lease.agreement_date':'2026-09-29','lease.checkin_date':'2026-11-01','lease.checkout_date':'2027-10-31','lease.duration_months':'12',
  'payment.yearly_rent':'150000000','payment.total_rent':'150000000','payment.deposit_percentage':'20','payment.deposit':'30000000','payment.first_payment':'150000000','payment.first_payment_due_date':'2026-11-01'
 }});assert.equal(completed.status,200);
 const prior=process.env.CONTRACT_CHROME_PATH;process.env.CONTRACT_CHROME_PATH='/not-an-installed-contract-renderer';
 try{const failed=await request('/'+draft.id+'/pdf','POST',{revision:2,reviewed:true});assert.equal(failed.status,503);assert.match((await failed.json()).error,/draft is saved/);}
 finally{if(prior===undefined)delete process.env.CONTRACT_CHROME_PATH;else process.env.CONTRACT_CHROME_PATH=prior;}
 assert.equal((await (await request('/'+draft.id)).json()).versions.length,0);
});
test('contract editor and assets are private and do not expose arbitrary files',async t=>{
 const handler=createPageHandler({resolveActor:async req=>req.headers['x-test-user']==='staff'?{user:'staff',role:'staff'}:req.headers['x-test-user']==='owner'?{user:'owner',role:'owner'}:null});
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const root='http://127.0.0.1:'+server.address().port;
 const request=(url,user)=>fetch(root+url,{redirect:'manual',headers:{'x-test-user':user||''}});
 assert.equal((await request('/contract')).status,302);
 assert.equal((await request('/contract','owner')).status,403);
 const page=await request('/contract','staff');assert.equal(page.status,200);assert.match(await page.text(),/Generate PDF/);
 assert.equal((await request('/contract/editor.js','staff')).status,200);
 assert.equal((await request('/contract/secrets.json','staff')).status,404);
});
test('company changes require administrator role and passport removal requires owner and origin',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-release-http-')),store=createStore(root),admin={user:'admin',role:'admin'},staff={user:'staff',role:'staff'};
 const handler=createHandler({store,origin:'https://thevillamanagers.cloud',resolveActor:async req=>req.headers['x-test-user']==='admin'?admin:staff});
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true})});
 const base='http://127.0.0.1:'+server.address().port+'/api/admin/contracts';
 const request=(suffix,method,body,user='admin',origin='https://thevillamanagers.cloud')=>fetch(base+suffix,{method,headers:{'Content-Type':'application/json','x-test-user':user,origin},body:body===undefined?undefined:JSON.stringify(body)});
 assert.equal((await request('/company','POST',{name:'Synthetic Company'},'staff')).status,403);
 assert.equal((await request('/company','POST',{name:'Synthetic Company'})).status,200);
 assert.equal((await request('/company','GET',undefined,'staff')).status,403);
 const draft=await store.create(admin);await store.addExtraction(admin,draft.id,0,Buffer.from('synthetic'),'image/png',{fields:{},warnings:[]});
 assert.equal((await request('/'+draft.id+'/passport','DELETE',{revision:1},'admin','https://evil.test')).status,403);
 assert.equal((await request('/'+draft.id+'/passport','DELETE',{revision:1},'staff')).status,404);
 assert.equal((await request('/'+draft.id+'/passport','DELETE',{revision:1})).status,200);
 assert.equal((await request('/'+draft.id+'/passport','GET')).status,404);
});
