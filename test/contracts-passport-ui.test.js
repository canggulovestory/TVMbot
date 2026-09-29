'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

test('passport review uses one clear apply action and hides technical details',()=>{
 const source=fs.readFileSync(require.resolve('../admin/contract.js'),'utf8');
 assert.match(source,/Apply passport details/);
 assert.match(source,/document\.createElement\('details'\)/);
 assert.doesNotMatch(source,/Apply checked, reviewed fields/);
 assert.doesNotMatch(source,/check\.type='checkbox'/);
});
