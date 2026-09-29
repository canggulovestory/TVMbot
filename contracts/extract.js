'use strict';
const passportFields=['full_name','place_of_birth','date_of_birth','nationality','passport_number','sex','passport_issue_date','passport_expiry_date'];
function uploadType(bytes,mime){
 if(!Buffer.isBuffer(bytes)||!bytes.length)throw Error('Invalid upload');
 if(bytes.length>10*1024*1024)throw Error('Request too large');
 const type=bytes.subarray(0,5).toString()==='%PDF-'?'pdf':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpeg':null;
 if(!type||mime!==({pdf:'application/pdf',png:'image/png',jpeg:'image/jpeg'})[type])throw Error('Invalid passport file type');
 if(type!=='pdf'){
  let width=0,height=0;
  if(type==='png'&&bytes.length>=24){width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
  if(type==='jpeg')for(let i=2;i+8<bytes.length;){
   if(bytes[i]!==255)break;const marker=bytes[i+1];if(marker===255){i++;continue;}
   const length=bytes.readUInt16BE(i+2);if(length<2||i+2+length>bytes.length)break;
   if([192,193,194].includes(marker)){height=bytes.readUInt16BE(i+5);width=bytes.readUInt16BE(i+7);break;}i+=length+2;
  }
  if(!width||!height||width*height>25000000||width>15000||height>15000)throw Error('Invalid image dimensions: use an identity-page image up to 25 megapixels');
 }
 return type;
}
function checksum(text,digit){
 if(!/^\d$/.test(digit))return false;
 return [...text].reduce((sum,c,i)=>sum+(c==='<'?0:/\d/.test(c)?Number(c):c.charCodeAt(0)-55)*[7,3,1][i%3],0)%10===Number(digit);
}
function parsePassport(text){
 const fields=Object.fromEntries(passportFields.map(k=>['lessee.'+k,{value:null,raw:'',confidence:null,source:null}])),warnings=[];
 const lines=String(text).toUpperCase().split(/\r?\n/).map(s=>s.replace(/\s/g,'')).filter(Boolean);
 const index=lines.findIndex((s,i)=>/^P[<A-Z][A-Z<]{3}/.test(s)&&s.length>=40&&/^[A-Z0-9<]{44}$/.test(lines[i+1]||''));
 if(index<0)return {fields,warnings:['No readable passport MRZ found. Enter details manually and check the original.']};
 const first=lines[index],second=lines[index+1];
 const put=(key,raw,value)=>{fields['lessee.'+key]={value,raw,confidence:null,source:'MRZ'};};
 const names=first.slice(5).split('<<'),surname=names.shift().replaceAll('<',' ').trim(),given=(names[0]||'').replaceAll('<',' ').replace(/\s+/g,' ').trim();
 put('full_name',first.slice(5),[given,surname].filter(Boolean).join(' '));
 const nationality=second.slice(10,13);put('nationality',nationality,/^[A-Z]{3}$/.test(nationality)?nationality:null);
 const passport=second.slice(0,9);put('passport_number',passport,checksum(passport,second[9])?passport.replaceAll('<',''):null);
 if(!fields['lessee.passport_number'].value)warnings.push('Passport number checksum failed. Read the original; do not accept automatically.');
 for(const [key,start,digit] of [['date_of_birth',13,19],['passport_expiry_date',21,27]]){
  const raw=second.slice(start,start+6);put(key,raw,null);
  warnings.push(checksum(raw,second[digit])?`${key.replaceAll('_',' ')}: MRZ shows YYMMDD ${raw}; confirm the full four-digit year from the passport.`:`${key.replaceAll('_',' ')} checksum failed. Enter from the original.`);
 }
 put('sex',second[20],({M:'Male',F:'Female',X:'Unspecified'})[second[20]]||null);
 warnings.push('Review every candidate against the passport. Place of birth and issue date are not present in the MRZ.');
 return {fields,warnings};
}
let running=false;
async function extractPassport(bytes,mime){
 const type=uploadType(bytes,mime);if(running)throw Error('Passport processing busy. Try again shortly.');
 running=true;
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{fork,execFile}=require('node:child_process'),{promisify}=require('node:util');
 let directory;
 try{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'tvm-passport-'));await fs.chmod(directory,0o700);
  const source=path.join(directory,'source.'+type);await fs.writeFile(source,bytes,{mode:0o600});let files=[source];
  if(type==='pdf'){
   const run=promisify(execFile),info=await run('pdfinfo',[source],{timeout:10000,maxBuffer:65536});
   const pages=Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);if(!pages||pages>3)throw Error('Invalid PDF: upload only the passport identity page (maximum 3 pages)');
   await run('pdftoppm',['-png','-scale-to','2500',source,path.join(directory,'page')],{timeout:20000,maxBuffer:65536});
   files=(await fs.readdir(directory)).filter(f=>/^page-\d+\.png$/.test(f)).map(f=>path.join(directory,f));
  }
  return await new Promise((resolve,reject)=>{
   const child=fork(path.join(__dirname,'ocr-worker.js'),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=256'],env:{PATH:process.env.PATH}});
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Passport processing timed out. Try a clearer identity-page image or enter details manually.'));},60000);
   child.on('message',message=>{clearTimeout(timer);if(message.ok)resolve(message.result);else reject(Error('Passport could not be read. Try a clearer image or enter details manually.'));});
   child.on('error',()=>{clearTimeout(timer);reject(Error('Passport processing unavailable. Enter details manually.'));});
   child.on('exit',()=>{clearTimeout(timer);reject(Error('Passport processing stopped. Enter details manually.'));});child.send({files});
  });
 }finally{if(directory)await fs.rm(directory,{recursive:true,force:true});running=false;}
}
module.exports={parsePassport,uploadType,extractPassport};
