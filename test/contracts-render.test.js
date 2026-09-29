'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderContract}=require('../contracts/template');
const {blankContract,applyFields}=require('../contracts/schema');
test('document has thirteen base pages and updates repeated fields without retaining source deal values',()=>{
 const d=applyFields(blankContract(),{'property.name':'Synthetic Retreat','property.address':'Test Street','property.code':'EXT-1','property.bedrooms':'4','property.bathrooms':'3','lessee.full_name':'Synthetic Guest','lease.checkin_date':'2028-04-01','lease.checkout_date':'2029-03-31','lease.agreement_date':'2028-03-01','lease.duration_months':'12','payment.yearly_rent':'280000000','payment.total_rent':'280000000','payment.deposit':'42000000','payment.deposit_percentage':'15','payment.first_payment':'280000000','payment.first_payment_due_date':'2028-04-01'});
 const html=renderContract(d);
 assert.equal((html.match(/class="contract-page"/g)||[]).length,13);
 assert.ok((html.match(/Synthetic Retreat/g)||[]).length>=3);
 assert.ok((html.match(/Synthetic Guest/g)||[]).length>=4);
 for(const old of ['Hidden Padi','150,000,000','150.000.000','30,000,000','1 November 2026','31 October 2027','20%'])assert.equal(html.includes(old),false,old);
 assert.ok(html.includes('Article 12'));assert.ok(html.includes('Pasal 12'));
});
test('HTML and template syntax in tenant data are literal and only approved fields become editable',()=>{
 const d=applyFields(blankContract(),{'lessee.full_name':'<script>alert(1)</script>{{property.name}}'});
 const html=renderContract(d,{editable:true});
 assert.equal(html.includes('<script>'),false);assert.ok(html.includes('&lt;script&gt;'));
 assert.ok(html.includes('{{property.name}}'));assert.equal(html.includes('contenteditable'),false);
 assert.ok(html.includes('data-field="lessee.full_name"'));assert.equal(html.includes('data-field="template'),false);
});
test('appendix adds a separate page without replacing locked clauses',()=>{
 const html=renderContract(applyFields(blankContract(),{'appendix.additional_agreements':'Synthetic pet agreement\nSecond line'}));
 assert.equal((html.match(/class="contract-page"/g)||[]).length,14);
 assert.ok(html.includes('Synthetic pet agreement'));assert.ok(html.includes('Article 8'));
});
test('signature area keeps tenant and lessor in separate signing columns',()=>{
 const html=renderContract(applyFields(blankContract(),{'lessee.full_name':'Synthetic Signer'}),{company:{name:'PT The Villa Managers'}});
 assert.match(html,/<div class="signatures"><div>[^]*?THE LESSOR\/VILLA MANAGEMENT:[^]*?PT The Villa Managers[^]*?<\/div><div>[^]*?THE LESSEE\/PENYEWA:[^]*?Synthetic Signer[^]*?<\/div><\/div>/);
});
test('service checklist is editable but printed inclusions are explicit and consistent',()=>{
 const data=applyFields(blankContract(),{'inclusions.pool_cleaning':'yes','inclusions.drinking_water':'yes'});
 const editor=renderContract(data,{editable:true});
 assert.match(editor,/data-inclusion="inclusions.pool_cleaning" checked/);
 assert.match(editor,/data-inclusion="inclusions.electricity"(?! checked)/);
 const print=renderContract(data);
 assert.doesNotMatch(print,/<input/);
 assert.match(print,/Pool cleaning[^]*?Included \/ Termasuk/);
 assert.match(print,/Electricity[^]*?Excluded \/ Tidak termasuk/);
 assert.doesNotMatch(print,/No services or running costs are included|Because the rental is for the villa only|Karena sewa ini hanya untuk villa/);
 assert.match(print,/marked Included in the checklist/);
 assert.match(print,/ditandai Termasuk pada daftar/);
});
test('legacy drafts keep services excluded and company information stays fixed',()=>{
 const html=renderContract({}, {editable:true,company:{name:'Fixed Company',bank:'Fixed bank'}});
 assert.equal((html.match(/data-inclusion=/g)||[]).length,9);
 assert.doesNotMatch(html,/data-inclusion="[^"]+" checked/);
 assert.match(html,/Fixed Company/);assert.match(html,/Fixed bank/);
 assert.doesNotMatch(html,/data-field="company\./);
});

test('emergency electricity credit is charged to tenant only when electricity is excluded',()=>{
 const html=renderContract(applyFields(blankContract(),{'inclusions.electricity':'yes'}));
 assert.match(html,/actual cost of the electricity token purchased, only if electricity is marked Excluded/);
 assert.match(html,/Biaya aktual pembelian token listrik tersebut, hanya jika listrik ditandai Tidak termasuk/);
 assert.match(html,/administrative penalty fee of IDR 200,000/);
});
test('article headings stay centered and room-count blanks stay short',()=>{
 const html=renderContract(blankContract(),{editable:true});
 assert.match(html,/<div class="article-heading"><h2>Article 1/);
 assert.match(html,/data-field="property.bedrooms"[^>]*>___<\/button>/);
 assert.doesNotMatch(html,/data-field="property.bedrooms"[^>]*>_{4}/);
});
test('monthly agreements use consistent rate, deposit and installment wording in both languages',()=>{
 const html=renderContract(applyFields(blankContract(),{'payment.rent_period':'monthly','payment.monthly_rent':'10000000','payment.payment_schedule':'monthly','payment.installment_amount':'10000000','payment.first_payment':'10000000','lease.duration_months':'3'}));
 assert.match(html,/Monthly Rent/);assert.match(html,/per month/);assert.match(html,/per bulan/);
 assert.match(html,/remaining 2 monthly payments/);assert.match(html,/2 pembayaran bulanan berikutnya/);
 assert.doesNotMatch(html,/per year|per tahun|annual rent|sewa tahunan|fully upfront|dibayarkan penuh di muka/);
 assert.match(html,/monthly rent/);assert.match(html,/sewa bulanan/);
 const upfront=renderContract(applyFields(blankContract(),{'payment.rent_period':'monthly','payment.monthly_rent':'10000000'}));
 assert.match(upfront,/fully upfront/);assert.match(upfront,/Monthly Rent/);
});

test('single-month payments do not print zero remaining installments',()=>{
 const html=renderContract({...blankContract(),'lease.duration_months':'1','payment.payment_schedule':'monthly'});
 assert.match(html,/No further rent payments are due/);assert.match(html,/Tidak ada pembayaran sewa berikutnya/);
 assert.doesNotMatch(html,/remaining 0|0 pembayaran bulanan/);
});
test('yearly quoted rent with monthly installments keeps its yearly basis',()=>{
 const html=renderContract({...blankContract(),'lease.duration_months':'12','payment.payment_schedule':'monthly'});
 assert.match(html,/Yearly Rent/);assert.match(html,/per year/);assert.match(html,/per tahun/);assert.match(html,/remaining 11 monthly payments/);
 assert.doesNotMatch(html,/payable fully upfront/);
});
