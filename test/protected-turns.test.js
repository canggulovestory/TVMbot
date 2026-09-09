'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('a completed chat delivery replays once and an interrupted delivery stays blocked after restart',async t=>{
 let api;try{api=require('../protected-turns');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
 assert.equal(typeof api?.createTurns,'function','durable chat run guard is required');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'protected-turns-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let calls=0;const run=api.createTurns(dir),work=async({beforeWrite})=>{await beforeWrite();calls++;return {response:'saved'};};
 assert.deepEqual(await run('telegram:100:1','same',work),{response:'saved'});
 assert.deepEqual(await api.createTurns(dir)('telegram:100:1','same',work),{response:'saved'});
 assert.equal(calls,1);
 await assert.rejects(run('telegram:100:1','changed',work),/request_conflict/);
 await assert.rejects(run('telegram:100:2','same',async({beforeWrite})=>{await beforeWrite();throw Error('lost reply');}),/lost reply/);
 await assert.rejects(api.createTurns(dir)('telegram:100:2','same',work),/outcome_uncertain/);
 assert.equal(calls,1);
 await assert.rejects(run('telegram:100:3','read',async()=>{throw Error('model offline');}),/model offline/);
 assert.deepEqual(await run('telegram:100:3','read',work),{response:'saved'});
 let reads=0;const read=async()=>({response:String(++reads)});
 assert.equal((await run('read-only','query',read)).response,'1');
 assert.equal((await run('read-only','query',read)).response,'2');
});
