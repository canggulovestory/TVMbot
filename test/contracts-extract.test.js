'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parsePassport,uploadType,extractPassport}=require('../contracts/extract');
const mrz='P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10';
test('MRZ extraction keeps candidates separate and rejects a failed passport checksum',()=>{
 const result=parsePassport(mrz);
 assert.equal(result.fields['lessee.full_name'].value,'ANNA MARIA ERIKSSON');
 assert.equal(result.fields['lessee.passport_number'].value,'L898902C3');
 assert.equal(result.fields['lessee.date_of_birth'].value,'1974-08-12');
 assert.equal(result.fields['lessee.date_of_birth'].raw,'740812');
 assert.equal(result.fields['lessee.passport_issue_date'].value,null);
 assert.equal(result.fields['lessee.passport_number'].source,'MRZ');
 const bad=parsePassport(mrz.replace('L898902C36','L898902C37'));
 assert.equal(bad.fields['lessee.passport_number'].value,'L898902C3');
 assert.ok(bad.warnings.length>0);
 assert.equal(parsePassport('unreadable').fields['lessee.full_name'].value,null);
 const noisy=parsePassport(mrz.replace('MARIA<<<<<<<<<<<<<<<<<<<','MARIA<<<<<<LLLKLLLKLKLLLLLKL').replace('C36UTO','C36UT0'));
 assert.equal(noisy.fields['lessee.full_name'].value,'ANNA MARIA ERIKSSON');
 assert.equal(noisy.fields['lessee.nationality'].value,null);
});

test('visible passport labels fill dates and fields that are absent from the MRZ',()=>{
 const result=parsePassport(`Date of birth / Date de naissance\n01.10.1996 F Nationality / DEUTSCH\nPlace of birth / Lieu de naissance\nWURZBURG\nDate of issue / Date de délivrance Date of expiry\n03.02.2023 02.02.2033\nP<D<<SOLDAN<<JACQUELINE<<<<<<<<<<<<<<<<<<<<\nC1542JC911D<<9610013F33020262101<<<<<<<<<<40`);
 assert.equal(result.fields['lessee.date_of_birth'].value,'1996-10-01');
 assert.equal(result.fields['lessee.passport_issue_date'].value,'2023-02-03');
 assert.equal(result.fields['lessee.passport_expiry_date'].value,'2033-02-02');
 assert.equal(result.fields['lessee.place_of_birth'].value,'WURZBURG');
 assert.equal(result.fields['lessee.nationality'].value,'German');
 assert.equal(result.fields['lessee.passport_number'].value,'C1542JC91');
});
test('visible passport labels tolerate OCR spaces and leading noise',()=>{
 const result=parsePassport(`Geburtstag / Date of birth\n01 10 1996 F Nationality DEUTSCH\nGeburtsort / Place of birth\nia) WURZBURG\nAusstellungsdatum / Date of issue Date of expiry\n03 02 2023 02 02 2033\nP<D<<SOLDAN<<JACQUELINE<<<<<<<<<<<<<<<<<<<<\nC1542JC911D<<9610013F33020262101<<<<<<<<<<40`);
 assert.equal(result.fields['lessee.place_of_birth'].value,'WURZBURG');
 assert.equal(result.fields['lessee.passport_issue_date'].value,'2023-02-03');
});
test('upload boundaries reject mismatched types, active formats and oversized payloads',()=>{
 assert.equal(uploadType(Buffer.from('%PDF-1.7\n'),'application/pdf'),'pdf');
 assert.throws(()=>uploadType(Buffer.from('<svg/>'),'image/png'),/Invalid/);
 assert.throws(()=>uploadType(Buffer.from('%PDF-1.7\n'),'image/jpeg'),/Invalid/);
 assert.throws(()=>uploadType(Buffer.alloc(10*1024*1024+1),'application/pdf'),/large/);
 const bomb=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bomb);bomb.writeUInt32BE(100000,16);bomb.writeUInt32BE(100000,20);
 assert.throws(()=>uploadType(bomb,'image/png'),/dimensions/);
});
test('offline OCR reads a synthetic identity image without auto-approving fields',async()=>{
 const bytes=await require('node:fs/promises').readFile(require('node:path').join(__dirname,'fixtures/passport-synthetic.png'));
 const extracted=await extractPassport(bytes,'image/png');
 assert.equal(extracted.fields['lessee.passport_number'].value,'L898902C3');
 assert.equal(extracted.fields['lessee.full_name'].value,'ANNA MARIA ERIKSSON');
 assert.equal(extracted.fields['lessee.date_of_birth'].value,'1974-08-12');
 assert.equal(extracted.reviewedBy,undefined);
});
