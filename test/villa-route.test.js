'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('public villa pages use clean slug routes', () => {
  const root = path.join(__dirname, '..');
  const nginx = fs.readFileSync(path.join(root, 'ops/nginx-tvmbot.conf'), 'utf8');
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const villa = fs.readFileSync(path.join(root, 'website/villa/index.html'), 'utf8');
  assert.match(nginx, /location ~ \^\/villa\/\[\^\/\]\+\/\?\$/);
  assert.match(home, /`\/villa\/\$\{encodeURIComponent/);
  assert.match(villa, /location\.pathname\.match/);
});

test('public pages do not advertise the retired furniture business', () => {
  const root = path.join(__dirname, '..');
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const afni = fs.readFileSync(path.join(root, 'website/afni/index.html'), 'utf8');
  assert.doesNotMatch(home, /Bali Furniture|Furniture Supplies|#furniture/i);
  assert.doesNotMatch(afni, /Bali Furniture|Furniture Supplies|#furniture/i);
});

test('TVM and Afni keep their separate public WhatsApp numbers', () => {
  const root = path.join(__dirname, '..');
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const villa = fs.readFileSync(path.join(root, 'website/villa/index.html'), 'utf8');
  const afni = fs.readFileSync(path.join(root, 'website/afni/index.html'), 'utf8');
  assert.match(home, /6282115111211/);
  assert.match(villa, /6282115111211/);
  assert.doesNotMatch(home, /6282122922252/);
  assert.match(afni, /6282122922252/);
});
