'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRuns}=require('../web-chat-runs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('web approval is session-scoped, single use, and duplicate starts do not repeat work',async()=>{
  const runs=createRuns(),owner='admin:afni:session1',id='12345678-1234-1234-1234-123456789012';
  let called=0,decision;
  const work=async({onApproval,signal})=>{called++;decision=await onApproval({command:'synthetic command',choices:['once','deny']},{signal});return decision==='once'?'Approved result':'Denied result'};
  runs.start({owner,id,message:'test',work});runs.start({owner,id,message:'test',work});
  await tick();
  assert.equal(called,1);assert.equal(runs.get('life:afni:session1',id),null);
  const pending=runs.get(owner,id);assert.equal(pending.status,'approval');
  assert.equal(runs.decide('admin:other:session1',id,pending.approval.token,'once'),false);
  assert.equal(runs.decide(owner,id,pending.approval.token,'once'),true);
  assert.equal(runs.decide(owner,id,pending.approval.token,'once'),false);
  await tick();assert.equal(runs.get(owner,id).reply,'Approved result');
});
test('unsafe or oversized approval prompts are denied without showing an approve button',async()=>{
  for(const event of [{command:'x',choices:['once'],smart_denied:true},{command:'x'.repeat(2501),choices:['once']}]){
    const runs=createRuns(),id='12345678-1234-1234-1234-123456789012';
    runs.start({owner:'o',id,message:'test',work:async({onApproval,signal})=>await onApproval(event,{signal})});
    await tick();assert.equal(runs.get('o',id).reply,'deny');assert.equal(runs.get('o',id).approval,null);
  }
});
test('cancel denies a waiting approval and aborts the underlying run',async()=>{
  const runs=createRuns(),id='12345678-1234-1234-1234-123456789012';let stopped=false;
  runs.start({owner:'o',id,message:'test',work:async({onApproval,signal})=>{
    await onApproval({command:'synthetic',choices:['once']},{signal});stopped=signal.aborted;return 'Finished';
  }});
  await tick();assert.equal(runs.cancel('wrong',id),false);assert.equal(runs.cancel('o',id),true);
  await tick();assert.equal(stopped,true);assert.equal(runs.get('o',id).status,'cancelled');
});
test('approval expiry fails closed and never approves the action',async()=>{
  const runs=createRuns({approvalMs:15}),id='12345678-1234-1234-1234-123456789012';
  runs.start({owner:'o',id,message:'test',work:async({onApproval,signal})=>await onApproval({command:'synthetic',choices:['once']},{signal})});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(runs.get('o',id).reply,'deny');
});
test('abandoned browser lease and whole-run deadline both cancel underlying work',async()=>{
  for(const options of [{leaseMs:10,runMs:1000},{leaseMs:1000,runMs:10}]){
    const runs=createRuns(options),id='12345678-1234-1234-1234-123456789012';let stopped=false;
    runs.start({owner:'o',id,message:'test',work:({signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{stopped=true;resolve('stopped')},{once:true}))});
    await new Promise(resolve=>setTimeout(resolve,45));
    assert.equal(stopped,true);assert.equal(runs.get('o',id).status,'cancelled');
  }
});
