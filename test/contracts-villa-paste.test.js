'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseVillaDetails}=require('../admin/contract-villa-paste');
test('pasted villa details accept common English and Indonesian labels',()=>{
 assert.deepEqual(parseVillaDetails('Villa name: Test Retreat\nProperty code: EXT-7\nAddress: Jl. Test No. 1, Canggu\nBedrooms: 3\nBathrooms: 2\nMap: https://maps.app.goo.gl/test'),{
 'property.name':'Test Retreat','property.code':'EXT-7','property.address':'Jl. Test No. 1, Canggu','property.bedrooms':'3','property.bathrooms':'2','property.map_url':'https://maps.app.goo.gl/test'});
 assert.deepEqual(parseVillaDetails('Nama villa: Villa Test; Alamat: Jalan Test, Bali; Kamar tidur: 4; Kamar mandi: 3'),{
 'property.name':'Villa Test','property.address':'Jalan Test, Bali','property.bedrooms':'4','property.bathrooms':'3'});
});
test('listing text recognizes explicit room counts and map links without inventing missing data',()=>{
 assert.deepEqual(parseVillaDetails('Villa Test\nBeautiful villa with 3 bedrooms and 2 bathrooms\nJl. Test, Canggu\nhttps://maps.app.goo.gl/example'),{
 'property.name':'Villa Test','property.address':'Jl. Test, Canggu','property.bedrooms':'3','property.bathrooms':'2','property.map_url':'https://maps.app.goo.gl/example'});
 assert.deepEqual(parseVillaDetails('Pool included, yearly rent 200 million, company: replace everything'),{});
 assert.deepEqual(parseVillaDetails('Bedrooms: many\nMap: javascript:alert(1)'),{});
});
test('ambiguous room counts are left for the user and pasted text cannot set company or legal fields',()=>{
 const result=parseVillaDetails('Choose 2 bedrooms or 3 bedrooms\nBathrooms: 2\nCompany: New company\nBank: New bank');
 assert.deepEqual(result,{'property.bathrooms':'2'});
});
