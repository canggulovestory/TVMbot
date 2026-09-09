'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
if(process.getuid()!==0)throw Error('Root provisioning only');
const base='/etc/zuzu-runtime',mode=process.argv[2];
fs.mkdirSync(base,{recursive:true,mode:0o700});
const write=(name,value)=>fs.writeFileSync(path.join(base,name),JSON.stringify(value),{mode:0o600,flag:'wx'});
if(mode==='prepare'){
 const env=require('dotenv').parse(fs.readFileSync(path.join(__dirname,'../.env')));
 const runtime=require('dotenv').parse(fs.readFileSync(path.join(base,'hermes-stage.env')));
 if(!runtime.API_SERVER_KEY||!/^\d+$/.test(env.AFNI_TELEGRAM_ID||''))throw Error('Verified runtime/owner missing');
 const broker=[],telegramBindings=[],webBindings=[];
 for(const [actor,field] of [['afni','AFNI_TELEGRAM_ID'],['syifa','SYIFA_TELEGRAM_ID']]){
  if(!/^\d+$/.test(env[field]||''))continue;
  const token=crypto.randomBytes(32).toString('hex');
  broker.push({token,actor,channel:'telegram',canWriteTasks:actor==='afni'});telegramBindings.push({token,senderId:env[field]});
  const webToken=crypto.randomBytes(32).toString('hex');
  broker.push({token:webToken,actor,channel:'web',canWriteTasks:actor==='afni'});webBindings.push({token:webToken,userId:actor});
 }
 const personalToken=crypto.randomBytes(32).toString('hex');
 broker.push({token:personalToken,actor:'afni',channel:'web',canWriteTasks:true});
 const url='http://127.0.0.1:18643/v1/operations';
 write('operations-broker.json',{enabled:true,bindings:broker});
 write('operations-chat.json',{hermes:{url:'http://127.0.0.1:18642',key:runtime.API_SERVER_KEY,model:'tvm'},operations:{enabled:true,url,telegramBindings,webBindings}});
 write('operations-web-export.json',{enabled:true,url,webBindings:[{userId:'u_afni',token:personalToken}]});
 const envFile=path.join(__dirname,'../.env'),raw=fs.readFileSync(envFile,'utf8');
 if(/^ZUZU_PROTECTED_CHAT=/m.test(raw))throw Error('Chat flag already configured');
 fs.writeFileSync(envFile,raw.trimEnd()+'\nZUZU_PROTECTED_CHAT=true\n',{mode:0o600});
 console.log('Private owner/channel bindings provisioned; finance unavailable');
}else if(mode==='export-web'){process.stdout.write(fs.readFileSync(path.join(base,'operations-web-export.json')));}
else if(mode==='import-web'){
 let input='';process.stdin.on('data',c=>{input+=c;if(input.length>10000)process.exit(1);});
 process.stdin.on('end',()=>{const config=JSON.parse(input);if(config.url!=='http://127.0.0.1:18643/v1/operations'||config.webBindings?.length!==1||config.webBindings[0].userId!=='u_afni')throw Error('Invalid binding');write('operations-web.json',config);console.log('Private web binding installed');});
}else if(mode==='tunnel'){
 const file='/root/.ssh/authorized_keys',raw=fs.readFileSync(file,'utf8'),lines=raw.split('\n');
 const matches=lines.filter(x=>x.endsWith(' zuzu-hermes-tunnel'));if(matches.length!==1||!matches[0].includes('permitopen="127.0.0.1:18642"'))throw Error('Expected scoped tunnel key');
 fs.copyFileSync(file,file+'.operations-backup-'+Date.now());
 fs.writeFileSync(file,lines.map(x=>x===matches[0]?x.replace('permitopen="127.0.0.1:18642"','permitopen="127.0.0.1:18642",permitopen="127.0.0.1:18643"'):x).join('\n'),{mode:0o600});
 console.log('Tunnel restricted to the two protected loopback services');
}else throw Error('Unknown provisioning action');
