'use strict';
// Isolated process: no network OCR provider, no document text on stdout/stderr.
const path=require('node:path');
const {createWorker}=require('tesseract.js');
const {parsePassport}=require('./extract');
process.once('message',async ({files})=>{
 let worker;
 try{
  const langPath=path.join(path.dirname(require.resolve('tesseract.js/package.json')),'..','@tesseract.js-data','eng','4.0.0');
  worker=await createWorker('eng',1,{langPath,cacheMethod:'none',logger:()=>{}});
  let text='';
  for(const file of files){
   await worker.setParameters({tessedit_pageseg_mode:'6',tessedit_char_whitelist:''});
   const result=await worker.recognize(file,{}, {text:true,blocks:true});
   let pageText=result.data.text;
   const parsed=parsePassport(pageText);
   if(!parsed.fields['lessee.passport_number'].value){
    const lines=(result.data.blocks||[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines));
    const mrz=lines.filter(l=>l.text.includes('<<')&&l.text.replace(/\s/g,'').length>=35);
    if(mrz.length===2){
     const left=Math.min(...mrz.map(l=>l.bbox.x0)),y=Math.min(...mrz.map(l=>l.bbox.y0));
     const right=Math.max(...mrz.map(l=>l.bbox.x1)),bottom=Math.max(...mrz.map(l=>l.bbox.y1));
     const height=bottom-y,top=Math.max(0,y-Math.round(height*0.2));
     await worker.setParameters({tessedit_pageseg_mode:'6',tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'});
     const retry=await worker.recognize(file,{rectangle:{left,top,width:Math.round((right-left)*1.05),height:bottom-top+Math.round(height*0.05)}}).catch(()=>null);
     const checked=parsePassport(retry?.data.text||'');
     if(['passport_number','date_of_birth','passport_expiry_date'].every(key=>checked.fields['lessee.'+key].value)){
      for(const line of mrz)pageText=pageText.replace(line.text.trim(),'');
      pageText+='\n'+retry.data.text;
     }
    }
   }
   text+=pageText+'\n';if(text.length>50000)throw Error('Too much text');
  }
  process.send({ok:true,result:{...parsePassport(text),text}});
 }catch{process.send({ok:false});}finally{await worker?.terminate();process.disconnect();}
});
