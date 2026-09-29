'use strict';
const crypto=require('node:crypto'),{promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt),COOKIE='__Host-tvm_contract',AGE=8*60*60,WINDOW=15*60*1000;
function createContractAuth({passwordHash='',sessionSecret='',origin,now=Date.now}){
 const configured=/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)&&Boolean(sessionSecret);
 // Independent key and cookie: a contract token cannot authenticate to admin APIs.
 const key=crypto.createHmac('sha256',sessionSecret).update('contract-only\0'+passwordHash).digest();
 const sign=value=>crypto.createHmac('sha256',key).update(value).digest('base64url');
 const equal=(a,b)=>a.length===b.length&&crypto.timingSafeEqual(a,b);
 const cookie=(token,age=AGE)=>`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
 const attempts=new Map();
 function actor(req){
  if(!configured)return null;
  const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!token||token.length>1000)return null;
  const parts=token.split('.');if(parts.length!==2||!equal(Buffer.from(parts[1]),Buffer.from(sign(parts[0]))))return null;
  try{const p=JSON.parse(Buffer.from(parts[0],'base64url').toString());return p.scope==='contracts'&&Number.isFinite(p.exp)&&p.exp>now()?{user:'contract-team',role:'staff',scope:'contracts'}:null;}catch{return null;}
 }
 function json(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));}
 async function handle(req,res){
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(req.headers.origin!==origin)return json(res,403,{error:'Open the contract link to sign in.'});
  const pathname=new URL(req.url,origin).pathname;
  if(pathname==='/contract/logout')return json(res,200,{ok:true},{'Set-Cookie':cookie('',0)});
  if(pathname!=='/contract/login')return json(res,404,{error:'Not found'});
  if(!configured)return json(res,503,{error:'Contract access is not configured yet.'});
  const remote=req.socket.remoteAddress||'unknown';
  const ip=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)?String(req.headers['x-forwarded-for']||remote).split(',').pop().trim():remote;
  const time=now();for(const [address,entry] of attempts)if(time-entry.start>=WINDOW)attempts.delete(address);
  const entry=attempts.get(ip)||{start:time,count:0};
  if(entry.count>=5||(!attempts.has(ip)&&attempts.size>=10000)){
   const seconds=Math.max(1,Math.ceil((entry.start+WINDOW-time)/1000));
   return json(res,429,{error:`Too many attempts. Try again in ${Math.ceil(seconds/60)} minutes.`},{'Retry-After':String(seconds)});
  }
  entry.count++;attempts.set(ip,entry);
  try{
   if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'Use the password form.'});
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>4096)return json(res,413,{error:'Password is too long.'});chunks.push(chunk);}
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!input||typeof input.password!=='string'||input.password.length>256)return json(res,422,{error:'Enter your password.'});
   const [salt,stored]=passwordHash.split(':'),candidate=await scrypt(input.password,salt,64);
   if(!equal(candidate,Buffer.from(stored,'hex')))return json(res,401,{error:'Incorrect password. Please try again.'});
   attempts.delete(ip);
   const payload=Buffer.from(JSON.stringify({scope:'contracts',exp:now()+AGE*1000,nonce:crypto.randomUUID()})).toString('base64url');
   return json(res,200,{ok:true},{'Set-Cookie':cookie(payload+'.'+sign(payload))});
  }catch{return json(res,400,{error:'Could not sign in. Please try again.'});}
 }
 return {actor,handle};
}
module.exports={createContractAuth};
