'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const life = require('../personal-life');

test('personal commands save only an explicit private-life item', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuzu-life-'));
  life.init(dir);
  assert.equal(await life.tryCommand('afni', 'journal: A quiet morning'), 'Saved to your private journal list: A quiet morning');
  assert.equal(await life.tryCommand('afni', 'I feel tired today'), null);
  const overview = await life.overview('afni');
  assert.equal(overview.items[0].kind, 'journal');
  await fs.rm(dir, { recursive: true, force: true });
});

test('adding beyond 1000 records preserves every existing record and user', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuzu-retention-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  life.init(dir);
  const items = Array.from({length:1000}, (_,i) => ({id:'old-'+i,user:i===999?'other':'afni',kind:'note',title:'Record '+i,done:false}));
  await fs.writeFile(path.join(dir,'zuzu-life.json'),JSON.stringify({version:1,items}));
  await life.add('afni',{kind:'note',title:'New record'});
  const saved = JSON.parse(await fs.readFile(path.join(dir,'zuzu-life.json'),'utf8'));
  assert.equal(saved.items.length,1001);
  assert.equal(saved.items.find(x=>x.id==='old-999').user,'other');
});

test('personal search and pages can reach every record without leaking another user', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuzu-pages-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  life.init(dir);
  const items = Array.from({length:125}, (_,i) => ({id:String(i).padStart(3,'0'),user:'afni',kind:'note',title:'Note '+i,details:i===124?'Unique orchid':'',done:false}));
  items.push({id:'secret',user:'other',kind:'note',title:'Unique orchid',done:false});
  await fs.writeFile(path.join(dir,'zuzu-life.json'),JSON.stringify({version:1,items}));
  const first = await life.overview('afni',{limit:50});
  const second = await life.overview('afni',{limit:50,offset:50});
  const last = await life.overview('afni',{limit:50,offset:100});
  assert.equal(first.total,125);
  assert.equal(first.hasMore,true);
  assert.equal(last.hasMore,false);
  assert.equal(new Set([...first.items,...second.items,...last.items].map(x=>x.id)).size,125);
  const search = await life.overview('afni',{q:'ORCHID',limit:50});
  assert.deepEqual(search.items.map(x=>x.id),['124']);
  assert.equal(search.total,1);
  assert.equal((await life.overview('afni',{offset:'bad',limit:'-1'})).items.length>0,true);
});
