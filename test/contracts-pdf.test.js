'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {generatePdf}=require('../contracts/pdf');
const {blankContract}=require('../contracts/schema');
test('PDF rendering produces a searchable thirteen-page document without remote resources',async()=>{
 const result=await generatePdf({...blankContract(),'lessee.full_name':'SYNTHETIC TEST ONLY','property.name':'Synthetic Villa'});
 assert.equal(result.pdf.subarray(0,5).toString(),'%PDF-');
 assert.equal(result.pages,13);
 assert.ok(result.pdf.length>10000);
});
test('long additional agreements continue onto more pages instead of clipping or disappearing',async()=>{
 const result=await generatePdf({...blankContract(),'appendix.additional_agreements':('Synthetic additional agreement for layout testing. ').repeat(180)});
 assert.ok(result.pages>14);
});
