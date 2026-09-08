'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const life=require('../personal-life');
const plan=()=>({title:'Private challenge',guide:'Synthetic guide, not personal data.',days:Array.from({length:90},(_,i)=>({day:i+1,date:new Date(Date.UTC(2026,8,9+i)).toISOString().slice(0,10),mission:'Mission '+(i+1),training:'Easy movement',ugc:'One business action',arabic:i%2?'Course':'Rest',spiritual:'Reflection',health:'Regular meals',mind:'Journal'}))});

test('challenge import preserves records, separates users and survives reload',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'challenge-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));life.init(dir);
 await life.add('afni',{kind:'note',title:'Existing private note'});
 await life.importChallenge('afni',plan());
 life.init(dir);
 assert.equal((await life.challenge('afni')).days.length,90);
 assert.equal((await life.challenge('afni')).days[89].date,'2026-12-07');
 assert.equal(await life.challenge('other'),null);
 assert.equal((await life.overview('afni')).items[0].title,'Existing private note');
 await assert.rejects(life.updateChallengeDay('other',1,{status:'done'}),/No challenge/);
});

test('reimport is idempotent, does not erase progress, and rejects different plans',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'challenge-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));life.init(dir);
 await life.importChallenge('afni',plan());
 await life.updateChallengeDay('afni',2,{status:'modified',note:'Shorter session'});
 await life.importChallenge('afni',plan());
 assert.deepEqual((await life.challenge('afni')).progress['2'].status,'modified');
 assert.equal((await life.challenge('afni')).progress['2'].note,'Shorter session');
 const changed=plan();changed.days[0].mission='Another plan';
 await assert.rejects(life.importChallenge('afni',changed),/already exists/);
});

test('invalid input cannot corrupt or truncate the saved plan',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'challenge-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));life.init(dir);
 assert.equal(typeof life.importChallenge,'function');
 for(const bad of [null,{...plan(),days:plan().days.slice(0,89)},{...plan(),guide:'x'.repeat(100001)}])await assert.rejects(life.importChallenge('afni',bad));
 const badDate=plan();badDate.days[1].date=badDate.days[0].date;await assert.rejects(life.importChallenge('afni',badDate),/date/i);
 await life.importChallenge('afni',plan());
 await assert.rejects(life.updateChallengeDay('afni',91,{status:'done'}),/day/i);
 await assert.rejects(life.updateChallengeDay('afni',1,{status:'invented'}),/status/i);
 await assert.rejects(life.updateChallengeDay('afni',1,{status:'done',note:'x'.repeat(2001)}),/note/i);
 assert.deepEqual((await life.challenge('afni')).progress,{});
 await Promise.all([life.updateChallengeDay('afni',1,{status:'done'}),life.updateChallengeDay('afni',2,{status:'skipped'})]);
 assert.equal(Object.keys((await life.challenge('afni')).progress).length,2);
});
