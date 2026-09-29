'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createContractAuth}=require('../contracts/auth');
const {createHandler,createPageHandler}=require('../contracts/routes');
const {createStore}=require('../contracts/store');
const salt='0123456789abcdef0123456789abcdef',password='Synthetic test password only',hash=salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
const origin='https://thevillamanagers.cloud',secret='synthetic-independent-signing-secret';
test('password-only contract session is scoped, expiring, tamper resistant, and revoked by password rotation',async t=>{
 let now=1000000;const auth=createContractAuth({passwordHash:hash,sessionSecret:secret,origin,now:()=>now});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contract-auth-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=createStore(root),admin={user:'existing-admin',role:'admin'};await store.setCompany(admin,{name:'Fixed Company'});const existing=await store.create(admin);
 const page=createPageHandler({resolveActor:auth.actor,auth}),api=createHandler({store,resolveActor:auth.actor,origin});
 const server=http.createServer((req,res)=>req.url.startsWith('/api/')?api(req,res):page(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(url,method='GET',body,cookie='',site=origin)=>fetch(base+url,{method,headers:{Origin:site,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const loginPage=await request('/contract');assert.equal(loginPage.status,200);const html=await loginPage.text();assert.match(html,/type="password"/);assert.doesNotMatch(html,/name="username"|Generate PDF/);
 assert.equal((await request('/contract/editor.js')).status,401);
 assert.equal((await request('/contract/login.js')).status,200);
 assert.equal((await request('/contract/login','POST',{password},'','https://evil.example')).status,403);
 assert.equal((await request('/contract/login','POST',{password:'wrong'})).status,401);
 const signed=await request('/contract/login','POST',{password});assert.equal(signed.status,200);
 const setCookie=signed.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(setCookie.includes(flag));
 const cookie=setCookie.split(';')[0],token=cookie.split('=')[1];assert.ok(cookie.startsWith('__Host-tvm_contract='));
 assert.deepEqual(auth.actor({headers:{cookie}}),{user:'contract-team',role:'staff',scope:'contracts'});
 const [encoded,signature]=token.split('.');assert.notEqual(signature,crypto.createHmac('sha256',secret).update(encoded).digest('base64url'));
 assert.equal(auth.actor({headers:{cookie:'tvm_admin='+token}}),null);
 assert.equal(auth.actor({headers:{cookie:cookie+'x'}}),null);
 assert.equal(createContractAuth({passwordHash:hash+'0',sessionSecret:secret,origin}).actor({headers:{cookie}}),null);
 assert.match(await (await request('/contract','GET',undefined,cookie)).text(),/Generate PDF/);
 const contracts=await (await request('/api/admin/contracts','GET',undefined,cookie)).json();assert.equal(contracts[0].id,existing.id);
 const updated=await request('/api/admin/contracts/'+existing.id,'PATCH',{revision:0,fields:{'property.name':'Synthetic shared contract'}},cookie);assert.equal(updated.status,200);
 assert.equal((await store.get(admin,existing.id)).company.name,'Fixed Company');
 assert.equal((await request('/api/admin/contracts/company','POST',{name:'Changed'},cookie)).status,403);
 assert.equal((await request('/api/admin/contracts/'+existing.id,'PATCH',{revision:1,fields:{}},cookie,'https://evil.example')).status,403);
 const loggedOut=await request('/contract/logout','POST',{},cookie);assert.match(loggedOut.headers.get('set-cookie'),/Max-Age=0/);
 now+=8*60*60*1000+1;assert.equal(auth.actor({headers:{cookie}}),null);
});
test('contract password attempts are limited and configuration fails closed',async t=>{
 const auth=createContractAuth({passwordHash:hash,sessionSecret:secret,origin});
 const server=http.createServer((req,res)=>auth.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 for(let i=0;i<5;i++)assert.equal((await fetch(base+'/contract/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':`spoof-${i}, 198.51.100.1`},body:JSON.stringify({password:'wrong'})})).status,401);
 const limited=await fetch(base+'/contract/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':'another-spoof, 198.51.100.1'},body:JSON.stringify({password})});assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
 assert.equal((await fetch(base+'/contract/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':'198.51.100.2'},body:JSON.stringify({password})})).status,200);
 assert.equal(createContractAuth({passwordHash:'',sessionSecret:secret,origin}).actor({headers:{cookie:''}}),null);
});

test('Nginx contract proxy supplies the real address for the login limiter',async()=>{
 const config=await fs.readFile(path.join(__dirname,'../ops/nginx-tvmbot.conf'),'utf8');
 for(const location of ['location = /contract {','location ^~ /contract/ {']){
  const block=config.slice(config.indexOf(location)).split('}')[0];
  assert.match(block,/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
 }
});
