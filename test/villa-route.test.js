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
