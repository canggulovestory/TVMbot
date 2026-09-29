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
  let text='';for(const file of files){const result=await worker.recognize(file);text+=result.data.text+'\n';if(text.length>50000)throw Error('Too much text');}
  process.send({ok:true,result:{...parsePassport(text),text}});
 }catch{process.send({ok:false});}finally{await worker?.terminate();process.disconnect();}
});
