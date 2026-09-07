'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8');
function calculate(transactions){
  const context={TVMMoney:require('../admin/currency'),state:{villaData:{transactions,villas:[{id:'v',currency:'IDR'}]}},sMap:()=>({t:{agencyCommissionPercent:10}}),vMap:()=>({v:{currency:'IDR'}}),$:()=>({addEventListener(){}})};
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('// ── Owner statement ──'),html.indexOf("$('#vd-copy-stmt')")),context);
  return JSON.parse(JSON.stringify(context.villaStatement('v','2026-09')));
}
test('owner statements keep IDR and USD income, commission and expenses separate',()=>{
  const result=calculate([
    {villaId:'v',date:'2026-09-01',type:'Income',currency:'IDR',amount:1000000,tenancyId:'t'},
    {villaId:'v',date:'2026-09-01',type:'Expense',currency:'IDR',amount:300000},
    {villaId:'v',date:'2026-09-01',type:'Income',currency:'USD',amount:100.25,tenancyId:'t'},
    {villaId:'v',date:'2026-09-01',type:'Expense',currency:'USD',amount:0.15},
    {villaId:'other',date:'2026-09-01',type:'Income',currency:'USD',amount:999},
    {villaId:'v',date:'2026-08-01',type:'Income',currency:'USD',amount:999}
  ]);
  assert.deepEqual(result.totals,[
    {currency:'IDR',income:1000000,expenses:300000,commission:100000,payout:600000},
    {currency:'USD',income:100.25,expenses:0.15,commission:10.03,payout:90.07}
  ]);
});
test('empty statements show an explicit zero in the villa currency',()=>{
  assert.deepEqual(calculate([]).totals,[{currency:'IDR',income:0,expenses:0,commission:0,payout:0}]);
});
test('decimal half boundaries round consistently for amounts and commission',()=>{
  const money=require('../admin/currency');
  assert.equal(money.totals([{type:'Income',currency:'USD',amount:1.005}])[0].income,1.01);
  assert.equal(money.totals([{type:'Income',currency:'USD',amount:3.75,tenancyId:'t'}],{t:{agencyCommissionPercent:9.2}})[0].commission,.35);
});
test('active lease totals remain separate and only comparable to a matching listing currency',()=>{
  const source=html.slice(html.indexOf('const leasePayments='),html.indexOf('const coreOps='));
  const context={TVMMoney:require('../admin/currency'),currencyTotals:require('../admin/currency').totals,activeStay:{id:'t',currency:'IDR'},v:{yearlyRate:1000,currency:'IDR'},pays:[{tenancyId:'t',currency:'IDR',amount:1000},{tenancyId:'t',currency:'USD',amount:100}]};
  vm.createContext(context);
  vm.runInContext(source+';globalThis.result={totals:leaseTotals,mismatch:rateMismatch}',context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result.totals)).map(g=>[g.currency,g.income]),[['IDR',1000],['USD',100]]);
  assert.equal(context.result.mismatch,false);
});
test('copied and printable statements use the same currency-separated totals',async()=>{
  const TVMMoney=require('../admin/currency'),callbacks={};let printed='',copied='';
  const txns=[{villaId:'v',type:'Income',currency:'IDR',amount:1000,date:'2026-09-01'},{villaId:'v',type:'Income',currency:'USD',amount:10.25,date:'2026-09-01'}];
  const context={TVMMoney,currentVillaId:'v',money:TVMMoney.format,esc:String,fdate:String,toast(){},vMap:()=>({v:{id:'v',name:'Test Villa',currency:'IDR'}}),sMap:()=>({}),state:{villaData:{transactions:txns}},$:selector=>({addEventListener:(event,cb)=>{callbacks[selector]=cb}}),window:{open:()=>({document:{write:value=>{printed=value},close(){}}})},navigator:{clipboard:{writeText:async value=>{copied=value}}}};
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('// ── Owner statement ──'),html.indexOf('// ── Enquiry → stay conversion ──'))+";vdMonth='2026-09';",context);
  vm.runInContext(html.slice(html.indexOf('function printStatement(){'),html.indexOf('// ── Bottom nav ──')),context);
  callbacks['#vd-copy-stmt']();context.printStatement();await Promise.resolve();
  for(const output of [copied,printed]){assert.match(output,/IDR/);assert.match(output,/USD/);assert.ok(output.includes(TVMMoney.format(1000,'IDR')));assert.ok(output.includes(TVMMoney.format(10.25,'USD')));assert.ok(!output.includes(TVMMoney.format(1010.25,'IDR')));}
});
