'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parsePassport}=require('../contracts/extract');
const mrz='P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10';
test('printed dates follow labels rather than global reading order',()=>{
 const r=parsePassport('Date of issue: 01.02.2020\nDate of birth: 12.08.1974\nDate of expiry: 01.02.2030\n'+mrz);
 assert.equal(r.fields['lessee.date_of_birth'].value,'1974-08-12');
 assert.equal(r.fields['lessee.passport_issue_date'].value,'2020-02-01');
 // Conflicting MRZ and printed expiry require correction, not a silent override.
 assert.equal(r.fields['lessee.passport_expiry_date'].value,null);
});
test('visible labels work without an MRZ and invalid OCR dates never crash',()=>{
 assert.equal(parsePassport('Date of birth: 01.10.1996').fields['lessee.date_of_birth'].value,'1996-10-01');
 assert.doesNotThrow(()=>parsePassport('Date of birth: 99.99.1996\n'+mrz));
});
test('invalid passport checksums leave the number blank for correction',()=>{
 const r=parsePassport(mrz.replace('L898902C36','L898902C37'));
 assert.equal(r.fields['lessee.passport_number'].value,null);
 assert.ok(r.warnings.some(s=>/number/i.test(s)));
});
test('date labels respect their printed column order and do not borrow distant dates',()=>{
 const r=parsePassport('Date of expiry      Date of issue\n01.02.2030        01.02.2020');
 assert.equal(r.fields['lessee.passport_expiry_date'].value,'2030-02-01');
 assert.equal(r.fields['lessee.passport_issue_date'].value,'2020-02-01');
 assert.equal(parsePassport('Date of birth\na\nb\nc\nd\n01.02.2020').fields['lessee.date_of_birth'].value,null);
});
