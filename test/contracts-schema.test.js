'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {blankContract,applyFields,validate,suggestCheckout,moneyMinor}=require('../contracts/schema');
function complete(){return applyFields(blankContract(),{
 'lessee.full_name':'Synthetic Guest','lessee.passport_number':'TEST123','lessee.nationality':'Dutch',
 'property.name':'External Villa','property.address':'Synthetic address','property.bedrooms':'2','property.bathrooms':'2',
 'lease.agreement_date':'2026-09-29','lease.checkin_date':'2026-11-01','lease.checkout_date':'2027-10-31','lease.duration_months':'12',
 'payment.yearly_rent':'150000000','payment.total_rent':'150000000','payment.deposit_percentage':'20',
 'payment.deposit':'30000000','payment.first_payment':'150000000','payment.first_payment_due_date':'2026-11-01'
});}
test('external villa contract validates without a TVM ID and blank draft cannot finalize',()=>{
 assert.equal(validate(complete(),'2026-09-29').filter(x=>x.level==='error').length,0);
 assert.ok(validate(blankContract(),'2026-09-29').some(x=>x.field==='lessee.full_name'));
 assert.equal(blankContract()['property.name'],'');
});
test('field updates reject legal/config injection, unknown keys and silent truncation',()=>{
 const d=blankContract();
 for(const p of [{'template.html':'bad'},{'bank.account_number':'bad'},{'__proto__':null},{'lessee.full_name':4},{'property.address':'x'.repeat(2001)}]){
   if(Object.keys(p).length)assert.throws(()=>applyFields(d,p));
 }
 assert.throws(()=>applyFields(d,JSON.parse('{"__proto__":"bad"}')));
 const updated=applyFields(d,{'lessee.full_name':'<img onerror=alert(1)>'});
 assert.equal(d['lessee.full_name'],'');assert.equal(updated['lessee.full_name'],'<img onerror=alert(1)>');
});
test('calendar suggestion clamps anniversary before subtracting one day',()=>{
 assert.equal(suggestCheckout('2026-11-01',12),'2027-10-31');
 assert.equal(suggestCheckout('2024-02-29',12),'2025-02-27');
 assert.equal(suggestCheckout('2026-01-31',1),'2026-02-27');
 assert.throws(()=>suggestCheckout('2026-02-30',12));
 assert.throws(()=>suggestCheckout('2026-01-01',0));
});
test('money uses exact minor units and rejects malformed or excessive values',()=>{
 assert.equal(moneyMinor('150000000'),15000000000n);
 assert.equal(moneyMinor('0.10'),10n);
 for(const v of ['1e6','1,000','-1','1.005','NaN','', '999999999999999999999'])assert.throws(()=>moneyMinor(v));
});
test('required dates, upfront totals, deposits and map URLs cannot silently contradict',()=>{
 for(const [patch,field] of [
  [{'lease.checkout_date':'2026-02-30'},'lease.checkout_date'],
  [{'lease.checkout_date':'2025-01-01'},'lease.checkout_date'],
  [{'payment.deposit':'15000000'},'payment.deposit'],
  [{'payment.first_payment':'1'},'payment.first_payment'],
  [{'property.map_url':'javascript:alert(1)'},'property.map_url'],
  [{'lease.checkin_time':'25:00'},'lease.checkin_time'],
  [{'payment.total_rent':'0'},'payment.total_rent']
 ])assert.ok(validate(applyFields(complete(),patch),'2026-09-29').some(x=>x.field===field&&x.level==='error'));
});
test('passport expiry and duration override warn without inventing identity fields',()=>{
 const r=validate(applyFields(complete(),{'lessee.passport_expiry_date':'2027-01-01','lease.checkout_date':'2027-10-30'}),'2026-09-29');
 assert.ok(r.some(x=>x.field==='lessee.passport_expiry_date'&&x.level==='warning'));
 assert.ok(r.some(x=>x.field==='lease.duration_months'&&x.level==='warning'));
 assert.equal(complete()['lessee.phone'],'');assert.equal(complete()['lessee.residence'],'');
});
