'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const villaData = require('../villa-data');
const assistant = require('../assistant');
const hermes = require('../hermes-client');
const brain = require('../brain');

test('Telegram link save and recall persist in villa documents while Hermes is down', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-links-'));
  villaData.init(dir); assistant.init(dir);
  const villa = await villaData.upsert('villas', { name: 'Sempol' });
  const original = hermes.respond;
  hermes.respond = async () => { throw new Error('Provider offline'); };
  const send = text => brain.processMessage({ text, phone: '6282122922252' });
  try {
    const message = 'https://v0-sempol-dashboard.vercel.app/\n\nsave this link as sempol financial link';
    assert.match(await send(message), /Saved/i);
    await Promise.all([send(message), send(message)]);
    const data = await villaData.getAll();
    assert.equal(data.documents.length, 1);
    assert.equal(data.documents[0].villaId, villa.id);
    assert.equal(data.documents[0].driveUrl, 'https://v0-sempol-dashboard.vercel.app/');
    // Reload from disk, as after a process restart.
    villaData.init(dir);
    assert.match(await send('sempol financial link?'), /https:\/\/v0-sempol-dashboard.vercel.app\//);
    assert.equal(await brain.processMessage({ text: message, phone: 'not-allowed' }), null);
  } finally { hermes.respond = original; await fs.rm(dir, { recursive: true, force: true }); }
});

test('link saves require an explicit instruction and an unambiguous villa', async () => {
  const { tryVillaLink } = require('../villa-links');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-links-validation-'));
  villaData.init(dir);
  await villaData.upsert('villas', { name: 'Sempol' });
  await villaData.upsert('villas', { name: 'Villa LYSA' });
  try {
    assert.equal(await tryVillaLink('https://example.com/ sempol', 'afni'), null);
    assert.match(await tryVillaLink('save this link as finance https://example.com/', 'afni'), /which villa/i);
    assert.match(await tryVillaLink('save this link as sempol and lysa finance https://example.com/', 'afni'), /which villa/i);
    assert.equal((await villaData.getAll()).documents.length, 0);
    assert.match(await tryVillaLink('simpan link ini sebagai sempol dashboard https://example.com/', 'afni'), /Saved/i);
    assert.match(await tryVillaLink('bewaar deze link als lysa dashboard https://example.org/', 'afni'), /Saved/i);
    assert.equal((await villaData.getAll()).documents.length, 2);
    // If persistence fails, never claim the link was saved.
    await fs.writeFile(path.join(dir, 'not-a-directory'), 'occupied');
    villaData.init(path.join(dir, 'not-a-directory'));
    assert.match(await tryVillaLink('save this link as sempol finance https://example.com/', 'afni'), /couldn’t save/i);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
