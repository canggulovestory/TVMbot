'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {generatePdf}=require('../contracts/pdf');
const {blankContract}=require('../contracts/schema');
const {extractText,extractTextWithPositions}=require('@firecrawl/pdf-inspector');
test('PDF rendering produces a searchable thirteen-page document without remote resources',async()=>{
 const result=await generatePdf({...blankContract(),'lessee.full_name':'SYNTHETIC TEST ONLY','property.name':'Synthetic Villa','inclusions.cleaning':'yes','inclusions.electricity':'yes'}, {company:{name:'Synthetic Company',bank:'Synthetic Bank'}});
 assert.equal(result.pdf.subarray(0,5).toString(),'%PDF-');
 assert.equal(result.pages,13);
 assert.ok(result.pdf.length>10000);
 assert.ok(result.pdf.length<1000000,'text PDF should not contain rasterized page images');
 const text=extractText(result.pdf).replace(/\s+/g,' ');
 assert.match(text,/Payment must arrive.*12:00 PM/);
 assert.match(text,/right to deny entry/);
 assert.match(text,/converted into this refundable security deposit/);
 assert.match(text,/services marked Included in the checklist/);
 assert.doesNotMatch(text,/No services or running costs are included|Hidden Padi|150,000,000/);
 assert.match(text,/between Synthetic Company and SYNTHETIC TEST ONLY/);
 assert.match(text,/Name: SYNTHETIC TEST ONLY/);
 const positions=extractTextWithPositions(result.pdf);
 const heading=positions.find(p=>p.text.includes('Article 12'));
 assert.ok(heading,'fixed legal text must be searchable');
 assert.ok(Math.abs(heading.x+heading.width/2-297.6)<10,'article heading must be centered');
 const signature=positions.find(p=>p.text.includes('Name: SYNTHETIC TEST ONLY'));
 const label=positions.find(p=>p.page===signature.page&&p.text==='THE LESSEE/PENYEWA:');
 assert.ok(label&&signature.y<label.y&&label.y-signature.y<120,'name belongs below the tenant signature space');
});
test('international tenant names survive PDF generation and text extraction',async()=>{
 const result=await generatePdf({...blankContract(),'lessee.full_name':'Иван Петров','lessee.place_of_birth':'Würzburg'});
 const text=extractText(result.pdf);assert.match(text,/Иван Петров/);assert.match(text,/Würzburg/);
});
test('long additional agreements continue onto more pages instead of clipping or disappearing',async()=>{
 const result=await generatePdf({...blankContract(),'appendix.additional_agreements':('Synthetic additional agreement for layout testing. ').repeat(180)});
 assert.ok(result.pages>14);
});

test('monthly installments and included services reach the exported PDF',async()=>{
 const result=await generatePdf({...blankContract(),'payment.rent_period':'monthly','payment.payment_schedule':'monthly','lease.duration_months':'3','payment.monthly_rent':'10000000','payment.installment_amount':'10000000','inclusions.electricity':'yes'});
 const text=extractText(result.pdf).replace(/\s+/g,' ');
 assert.match(text,/Monthly Rent/);assert.doesNotMatch(text,/Yearly Rent|annual rent|fully upfront/);
 assert.match(text,/remaining 2 monthly payments/);
 assert.match(text,/only if electricity is marked Excluded/);
});
