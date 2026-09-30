'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {renderContract}=require('./template');
let running=false;
async function generatePdf(data,options={}){
 if(running)throw Error('PDF generation busy. Try again shortly.');
 running=true;let browser;
 try{
  if(process.env.CONTRACT_RENDERER_DIR){
   const {execFile}=require('node:child_process');
   return await new Promise((resolve,reject)=>{
    const child=execFile('/usr/sbin/runuser',['-u','tvm-renderer','--',path.join(process.env.CONTRACT_RENDERER_DIR,'node'),path.join(process.env.CONTRACT_RENDERER_DIR,'contracts/pdf-worker.js')],{cwd:process.env.CONTRACT_RENDERER_DIR,timeout:60000,maxBuffer:30*1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/var/lib/tvm-renderer',LANG:'C.UTF-8',CONTRACT_CHROME_PATH:process.env.CONTRACT_CHROME_PATH||'/usr/bin/google-chrome'}},(error,stdout)=>{
     if(error)return reject(Error('PDF renderer unavailable'));
     try{const result=JSON.parse(stdout);resolve({pdf:Buffer.from(result.pdf,'base64'),pages:result.pages});}catch{reject(Error('Invalid PDF renderer output'));}
    });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({data,options}));
   });
  }
  const {default:puppeteer}=await import('puppeteer-core');
  const executablePath=process.env.CONTRACT_CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium');
  // Keep Chromium's sandbox enabled. Production must run this service as a non-root user.
  browser=await puppeteer.launch({executablePath,headless:true,timeout:20000,args:['--disable-background-networking','--disable-sync','--no-first-run']});
  const page=await browser.newPage();
  await page.setRequestInterception(true);page.on('request',request=>request.abort());
  const css=await fs.readFile(path.join(__dirname,'document.css'),'utf8');
  await page.setContent('<!doctype html><html lang="en"><head><meta charset="utf-8"><style>'+css+'</style></head><body>'+renderContract(data,options)+'</body></html>',{waitUntil:'domcontentloaded',timeout:10000});
  // Split overflowing blocks onto continuation pages rather than clip legal text.
  const pages=await page.evaluate(()=>{
   const sections=[...document.querySelectorAll('.contract-page')];
   const original=sections.map(s=>s.querySelector('.contract-body').textContent).join('');
   for(let i=0;i<sections.length;i++){
    const section=sections[i],body=section.querySelector('.contract-body');let next=null;
    while(body.scrollHeight>body.clientHeight+1){
     const last=body.lastElementChild;
     if(last.tagName==='P'&&last.getBoundingClientRect().height>body.clientHeight-25&&last.textContent.length>200){
      const text=last.textContent,mid=Math.floor(text.length/2),space=text.lastIndexOf(' ',mid),cut=space>mid/2?space+1:mid;
      const continuation=last.cloneNode(false);last.textContent=text.slice(0,cut);continuation.textContent=text.slice(cut);body.append(continuation);continue;
     }
     if(body.children.length<2)throw Error('A document block is too long for one page; shorten the additional agreement or address.');
     if(!next){next=sections[i+1];if(!next){next=section.cloneNode(true);next.querySelector('.contract-body').replaceChildren();section.after(next);sections.splice(i+1,0,next);}}
     next.querySelector('.contract-body').prepend(body.lastElementChild);
    }
    if(next&&body.lastElementChild?.classList.contains('article-heading'))next.querySelector('.contract-body').prepend(body.lastElementChild);
    if(sections.length>40)throw Error('Document exceeds 40 pages');
   }
   if(sections.map(s=>s.querySelector('.contract-body').textContent).join('')!==original)throw Error('Document pagination changed the contract text');
   sections.forEach((section,i)=>section.querySelector('footer').textContent='Page '+(i+1)+' of '+sections.length);
   return sections.length;
  });
  const pdf=Buffer.from(await page.pdf({format:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false,timeout:20000}));
  return {pdf,pages};
 }finally{await browser?.close();running=false;}
}
module.exports={generatePdf};
