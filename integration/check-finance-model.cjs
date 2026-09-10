'use strict';
// Real isolated model, synthetic financial RPC only. Never sends Telegram messages.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {createFinanceHost}=require('../vendor/finance/finance-host.cjs');
const {createChat}=require('../isolated-chat');
async function main(){
 const config=JSON.parse(fs.readFileSync('/etc/zuzu-runtime/operations-chat.json','utf8'));
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Makassar'});
 const fixtures={accounts:[{id:'cash',name:'Cash',currency:'IDR',amount:1000000},{id:'bank',name:'Bank',currency:'IDR',amount:500000}],categories:[{id:'internet',name:'Internet',type:'expense'}],villas:[{id:'villa-test',name:'Test Villa'}],transactions:[],unpaid_bills:[]};
 for(const [index,message] of [
  'Internet Test Villa sudah dibayar 333rb hari ini dari Cash, kategori Internet. Buat pratinjau transaksi, jangan simpan dulu.',
  'Ik heb vandaag 333000 IDR voor Internet betaald uit Cash voor Test Villa. Maak een transactievoorbeeld, niet opslaan.',
  'Paid intenet for Test Vila today, IDR 333000 from Cash, Internet category. Prepare a preview only.'
 ].entries()){
  if(process.argv[2]&&index+1!==Number(process.argv[2]))continue;
  let prepared=0,reads=0;
  const finance=createFinanceHost({channel:'telegram',externalOwnerId:'100',enabled:true,prepareEnabled:true},{rpc:async(name,args)=>{
   if(name==='finance_assistant_read'){reads++;return {revision:1,retrievedAt:new Date().toISOString(),items:fixtures[args.resource],nextCursor:null};}
   assert.equal(name,'finance_assistant_prepare');const c=args.intent;
   assert.equal(c.kind,'expense');assert.equal(Number(c.amount),333000);assert.equal(c.currency,'IDR');assert.equal(c.accountId,'cash');assert.equal(c.categoryId,'internet');assert.equal(c.villaId,'villa-test');assert.equal(c.date,today);prepared++;
   return {proposalId:'22222222-2222-4222-8222-222222222222',status:'pending',intent:c,expiresAt:new Date(Date.now()+900000).toISOString(),effect:{before:'1000000.00',delta:'-333000.00',after:'667000.00'}};
  }});
  const chat=createChat({...config.hermes,financeDefinitions:finance.definitions});
  const result=await chat.respond({scope:'finance-synthetic-'+index,message,tools:finance.telegram({from:{id:100},chat:{id:100,type:'private'},message_id:index+1})});
  assert.equal(prepared,1);assert.ok(reads>0);assert.ok(result.response.includes('https://financial-ten-inky.vercel.app/?financeProposal=22222222-2222-4222-8222-222222222222'));
  assert.ok(!/\b(?:saved|recorded|posted) (?:successfully|the transaction)\b/i.test(result.response));
  console.log('PASS: synthetic finance transcript '+(index+1)+' resolved exact IDs/amount/date and returned owner confirmation link.');
 }
}
main().catch(e=>{console.error('Synthetic finance model check failed:',e.code||e.name);process.exitCode=1;});
