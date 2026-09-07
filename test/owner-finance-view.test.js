const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('owner finance projection excludes current and historical private evidence', () => {
  // Execute the actual route projection without booting Telegram/Notion services.
  const line=fs.readFileSync(require.resolve('../index.js'),'utf8').split('\n').find(l=>l.trim().startsWith('transactions: data.transactions'));
  const expression=line.trim().slice('transactions: '.length).replace(/,$/,'');
  const result=vm.runInNewContext(expression,{allowed:new Set(['V1']),data:{transactions:[
    {id:'T1',villaId:'V1',amount:150,proofUrl:'private-current',sourceId:'source',notes:'private',corrections:[{previous:{proofUrl:'private-old',villaId:'V2'}}]},
    {id:'T2',villaId:'V2',amount:999}
  ]}});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),[{id:'T1',villaId:'V1',amount:150}]);
});
