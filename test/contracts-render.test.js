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
