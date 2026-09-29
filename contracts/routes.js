'use strict';
const {validate,fields}=require('./schema');
const {renderContract,templateHash}=require('./template');
const {generatePdf}=require('./pdf');
const {extractPassport}=require('./extract');
const PREFIX='/api/admin/contracts';
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(value));}
async function body(req){
 if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('Invalid content type');
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('Request too large');chunks.push(chunk);}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Error('Invalid JSON');}
 if(!value||Array.isArray(value)||typeof value!=='object')throw Error('Invalid body');return value;
}
function createHandler({store,resolveActor,origin}){
 if(new URL(origin).origin!==origin)throw Error('Use a canonical trusted origin');
 return async(req,res)=>{
  try{
   const url=new URL(req.url,origin),suffix=url.pathname.slice(PREFIX.length);
   const match=suffix.match(/^\/([a-f0-9-]{36})(?:\/(preview|pdf|versions|passport|review)(?:\/([a-f0-9-]{36}))?)?$/);
   if(!url.pathname.startsWith(PREFIX)||(suffix&&suffix!=='/schema'&&suffix!=='/company'&&!match))return json(res,404,{error:'Not found'});
   // resolveActor must recheck the current account and role in the server user store.
   const actor=await resolveActor(req);
   if(!actor)return json(res,401,{error:'Authentication required'});
   if(!['staff','admin'].includes(actor.role))return json(res,403,{error:'Access denied'});
   if(!['GET','POST','PATCH','DELETE'].includes(req.method))return json(res,405,{error:'Method not allowed'});
   if(req.method!=='GET'&&req.headers.origin!==origin)return json(res,403,{error:'Use the authenticated contract editor'});
   if(suffix==='/company'){if(actor.role!=='admin')return json(res,403,{error:'Access denied'});if(req.method==='GET')return json(res,200,await store.getCompany(actor));if(req.method==='POST')return json(res,200,await store.setCompany(actor,await body(req)));return json(res,405,{error:'Method not allowed'});}
   if(req.method==='GET'){
    if(suffix==='/schema')return json(res,200,{fields});
    if(match?.[2]==='preview'){
     const draft=await store.get(actor,match[1]);
     res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'self'; frame-ancestors 'self'"});
     return res.end(renderContract(draft.data,{editable:true,company:draft.company}));
    }
    if(match?.[2]==='versions'&&match[3]){
     const version=await store.getVersion(actor,match[1],match[3]);
     res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="lease-agreement.pdf"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(version.pdf);
    }
    if(match?.[2]==='passport'){
     const source=await store.getPassport(actor,match[1]);res.writeHead(200,{'Content-Type':source.mime,'Content-Disposition':'attachment; filename="passport-source"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(source.bytes);
    }
    if(match?.[2])return json(res,405,{error:'Method not allowed'});
    return json(res,200,suffix?await store.get(actor,match[1]):await store.list(actor));
   }
   if(req.method==='POST'&&match?.[2]==='passport'){
    const draft=await store.get(actor,match[1]),revision=Number(req.headers['x-contract-revision']);
    if(!Number.isSafeInteger(revision)||revision!==draft.revision)throw Error('Conflict: reload before uploading');
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>10*1024*1024)throw Error('Request too large');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),mime=req.headers['content-type'];
    const result=await extractPassport(bytes,mime);
    await store.addExtraction(actor,draft.id,revision,bytes,mime,result);
    return json(res,201,await store.get(actor,draft.id));
   }
   const input=await body(req);
   if(req.method==='DELETE'&&match?.[2]==='passport')return json(res,200,await store.removePassport(actor,match[1],input.revision));
   if(req.method==='POST'&&match?.[2]==='review'){
    if(input.reviewed!==true)throw Error('Invalid passport review confirmation');
    return json(res,200,await store.approveExtraction(actor,match[1],input.revision,input.extractionId,input.fields));
   }
   if(req.method==='POST'&&match?.[2]==='pdf'){
    const draft=await store.get(actor,match[1]);
    if(!draft.company?.name?.trim())return json(res,422,{error:'Company settings are missing from this draft. Ask an administrator to save company settings, then create a new draft.'});
    if(input.revision!==draft.revision)throw Error('Conflict: reload the saved draft before generating');
    const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Makassar'}),issues=validate(draft.data,today);
    if(input.reviewed!==true||issues.some(x=>x.level==='error'))return json(res,422,{error:'Review the contract and complete required fields before generating.',issues});
    const existing=draft.versions.find(v=>v.revision===draft.revision&&v.templateHash===templateHash);
    if(existing)return json(res,200,existing);
    let pdf;
    try{({pdf}=await generatePdf(draft.data,{company:draft.company}));}catch{throw Error('PDF generation unavailable. Your draft is saved; no final PDF was created. Check the renderer setup or shorten oversized entries.');}
    return json(res,201,await store.addVersion(actor,draft.id,draft.revision,pdf,templateHash));
   }
   if(req.method==='POST'&&!suffix){
    if(Object.keys(input).length)throw Error('Invalid creation fields');
    return json(res,201,await store.create(actor));
   }
   if(req.method==='PATCH'&&match&&!match[2]){
    if(Object.keys(input).some(k=>!['revision','fields'].includes(k)))throw Error('Invalid update fields');
    const draft=await store.update(actor,suffix.slice(1),input.revision,input.fields);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Makassar',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    return json(res,200,{...draft,issues:validate(draft.data,today)});
   }
   return json(res,405,{error:'Method not allowed'});
  }catch(e){
   if(e.message==='Not found')return json(res,404,{error:'Not found'});
   if(e.message==='Access denied')return json(res,403,{error:'Access denied'});
   if(e.message.startsWith('Conflict:'))return json(res,409,{error:e.message});
   if(e.message==='Request too large')return json(res,413,{error:e.message});
   if(/^Passport (processing|could not)|^PDF generation/.test(e.message))return json(res,503,{error:e.message});
   if(e.message.startsWith('Invalid')&&!e.message.includes('storage'))return json(res,422,{error:e.message});
   // No input, OCR text, filenames or raw storage errors in the response/log.
   return json(res,500,{error:'Contract storage is unavailable. Your changes were not confirmed; reload before retrying.'});
  }
 };
}
function createPageHandler({resolveActor,auth}){
 const path=require('node:path'),fs=require('node:fs/promises');
 const assets={'/contract/villa-paste.js':['../admin/contract-villa-paste.js','application/javascript'],'/contract':['../admin/contract.html','text/html'],'/contract/':['../admin/contract.html','text/html'],'/contract/editor.js':['../admin/contract.js','application/javascript'],'/contract/editor.css':['../admin/contract.css','text/css'],'/contract/document.css':['document.css','text/css']};
 return async(req,res)=>{try{
  const pathname=new URL(req.url,'https://thevillamanagers.cloud').pathname;
  if(auth&&['/contract/login','/contract/logout'].includes(pathname))return auth.handle(req,res);
  const publicScript=auth&&pathname==='/contract/login.js';
  const actor=await resolveActor(req);
  if(!actor&&!auth){res.writeHead(302,{Location:'/login?next=/contract','Cache-Control':'no-store'});return res.end();}
  const login=auth&&!actor&&['/contract','/contract/'].includes(pathname);
  if(!actor&&!login&&!publicScript)return json(res,401,{error:'Authentication required'});
  if(actor&&!['staff','admin'].includes(actor.role))return json(res,403,{error:'Staff access required'});
  const asset=publicScript?['../admin/contract-login.js','application/javascript']:login?['../admin/contract-login.html','text/html']:assets[pathname];if(!asset||req.method!=='GET')return json(res,404,{error:'Not found'});
  res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"});return res.end(await fs.readFile(path.join(__dirname,asset[0])));
 }catch{return json(res,500,{error:'Contract editor unavailable'});}};
}
module.exports={createHandler,createPageHandler};
