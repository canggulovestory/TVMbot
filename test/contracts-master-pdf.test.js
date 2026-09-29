'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{generateFromMaster}=require('../contracts/master-pdf'),{blankContract}=require('../contracts/schema');
const master=process.env.CONTRACT_MASTER_PDF;
test('private master produces an exact thirteen-page blank template',{skip:!master||!fs.existsSync(master)},async()=>{
 const result=await generateFromMaster(blankContract(),{masterPath:master,blankTemplate:true});
 assert.equal(result.pages,13);assert.equal(result.pdf.subarray(0,5).toString(),'%PDF-');assert.ok(result.pdf.length>100000);
});
test('private master accepts contract values without changing page count',{skip:!master||!fs.existsSync(master)},async()=>{
 const data={...blankContract(),'lessee.full_name':'SYNTHETIC TENANT','property.name':'SYNTHETIC VILLA','property.address':'Synthetic address, Bali','property.bedrooms':'3','property.bathrooms':'2','lease.duration_months':'3','payment.rent_period':'monthly','payment.payment_schedule':'monthly','payment.monthly_rent':'10000000','payment.total_rent':'30000000','payment.first_payment':'10000000','payment.installment_amount':'10000000'};
 const result=await generateFromMaster(data,{masterPath:master});assert.equal(result.pages,13);assert.equal(result.pdf.subarray(0,5).toString(),'%PDF-');
});
