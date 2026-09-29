'use strict';
const {validate}=require('./schema');
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
   if(!url.pathname.startsWith(PREFIX)||(suffix&&!/^\/[a-f0-9-]{36}$/.test(suffix)))return json(res,404,{error:'Not found'});
   // resolveActor must recheck the current account and role in the server user store.
   const actor=await resolveActor(req);
   if(!actor)return json(res,401,{error:'Authentication required'});
   if(!['staff','admin'].includes(actor.role))return json(res,403,{error:'Access denied'});
   if(!['GET','POST','PATCH'].includes(req.method))return json(res,405,{error:'Method not allowed'});
   if(req.method!=='GET'&&req.headers.origin!==origin)return json(res,403,{error:'Use the authenticated contract editor'});
   if(req.method==='GET')return json(res,200,suffix?await store.get(actor,suffix.slice(1)):await store.list(actor));
   const input=await body(req);
   if(req.method==='POST'&&!suffix){
    if(Object.keys(input).length)throw Error('Invalid creation fields');
    return json(res,201,await store.create(actor));
   }
   if(req.method==='PATCH'&&suffix){
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
   if(e.message.startsWith('Invalid')&&!e.message.includes('storage'))return json(res,422,{error:e.message});
   // No input, OCR text, filenames or raw storage errors in the response/log.
   return json(res,500,{error:'Contract storage is unavailable. Your changes were not confirmed; reload before retrying.'});
  }
 };
}
module.exports={createHandler};
