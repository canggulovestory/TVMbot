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
function isoDate(day,month,year){
 const value=`${year}-${month}-${day}`,date=new Date(value+'T00:00:00Z');
 return date.toISOString().slice(0,10)===value?value:null;
}
function printedDates(text){
 return [...String(text).matchAll(/\b(\d{2})[.\/ -]+(\d{2})[.\/ -]+(\d{4})\b/g)].map(match=>isoDate(match[1],match[2],match[3])).filter(Boolean);
}
function mrzDate(raw,type){
 if(!/^\d{6}$/.test(raw))return null;
 const yy=Number(raw.slice(0,2)),current=new Date().getUTCFullYear(),year=type==='birth'?(2000+yy>current?1900+yy:2000+yy):2000+yy;
 return isoDate(raw.slice(4,6),raw.slice(2,4),year);
}
function parsePassport(text){
 const fields=Object.fromEntries(passportFields.map(k=>['lessee.'+k,{value:null,raw:'',confidence:null,source:null}])),warnings=[];
 const visible=String(text).toUpperCase(),printed=printedDates(visible);
 const lines=visible.split(/\r?\n/).map(s=>s.replace(/\s/g,'')).filter(Boolean);
 const index=lines.findIndex((s,i)=>/^P[<A-Z][A-Z<]{3}/.test(s)&&s.length>=40&&/^[A-Z0-9<]{44}$/.test(lines[i+1]||''));
 if(index<0)return {fields,warnings:['No readable passport MRZ found. Enter details manually and check the original.']};
 const first=lines[index],second=lines[index+1];
 const put=(key,raw,value)=>{fields['lessee.'+key]={value,raw,confidence:null,source:'MRZ'};};
 const names=first.slice(5).split('<<'),surname=names.shift().replaceAll('<',' ').trim(),given=(names[0]||'').replaceAll('<',' ').replace(/\s+/g,' ').trim();
 put('full_name',first.slice(5),[given,surname].filter(Boolean).join(' '));
 const nationality=second.slice(10,13);put('nationality',nationality,/^[A-Z]{3}$/.test(nationality)?nationality:null);
 const passport=second.slice(0,9);put('passport_number',passport,passport.replaceAll('<',''));
 if(!checksum(passport,second[9]))warnings.push('Passport number checksum failed. Check it against the passport before applying.');
 for(const [key,start,digit,type] of [['date_of_birth',13,19,'birth'],['passport_expiry_date',21,27,'expiry']]){
  const raw=second.slice(start,start+6),valid=checksum(raw,second[digit]);put(key,raw,valid?mrzDate(raw,type):null);
  if(!valid)warnings.push(`${key.replaceAll('_',' ')} checksum failed. Check it against the passport.`);
 }
 put('sex',second[20],({M:'Male',F:'Female',X:'Unspecified'})[second[20]]||null);
 if(/DATE OF BIRTH|GEBURTSTAG/.test(visible)&&printed[0])fields['lessee.date_of_birth'].value=printed[0];
 if(/DATE OF ISSUE|AUSSTELLUNGSDATUM/.test(visible)&&printed.length>=3)put('passport_issue_date',printed[1],printed[1]);
 if(/DATE OF EXPIRY|G[ÜU]LTIG BIS/.test(visible)&&printed.length>=2)fields['lessee.passport_expiry_date'].value=printed.at(-1);
 const birthplace=visible.match(/(?:PLACE OF BIRTH|GEBURTSORT)[^\n]*\n([^\n]+)/i)?.[1]?.trim().replace(/^[A-Z]{1,2}\W+\s*/,'').match(/[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ '\-]{2,}/)?.[0]?.trim();
 if(birthplace)put('place_of_birth',birthplace,birthplace);
 const printedNationality=/(?:NATIONALITY|STAATSANGEH[ÖO]RIGKEIT)/i.test(visible)?visible.match(/\b(DEUTSCH|GERMAN)\b/i)?.[1]:null;
 if(printedNationality)put('nationality',printedNationality,'German');
 warnings.push('Check the detected details against the passport before applying them.');
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
