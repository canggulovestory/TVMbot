#!/usr/bin/env node
/**
 * TVMbot Smoke Tests — run after every PM2 deploy
 * Usage: node smoke-test.js
 */
const http = require('http');

let passed = 0, failed = 0;
const results = [];

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, cookies, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function test(name, pass, detail) {
  if (pass) { passed++; results.push(`  ✅ ${name}`); }
  else { failed++; results.push(`  ❌ ${name}: ${detail || 'FAIL'}`); }
}

(async () => {
  console.log('\n🔍 TVMbot Smoke Tests\n' + '─'.repeat(40));

  // 1. Homepage loads
  try {
    const home = await request({ hostname: 'localhost', port: 3000, path: '/', method: 'GET' });
    test('Homepage loads (200)', home.status === 200, `status=${home.status}`);
    test('HTML no-cache header', home.headers['cache-control']?.includes('no-cache'), home.headers['cache-control']);
  } catch(e) { test('Homepage loads', false, e.message); }

  // 2. Session + CSRF
  let sid, csrfToken;
  try {
    const page = await request({ hostname: 'localhost', port: 3000, path: '/', method: 'GET' });
    sid = (page.cookies.find(c => c.startsWith('connect.sid')) || '').split(';')[0];
    test('Session cookie set', !!sid, 'no cookie');

    const csrf = await request({ hostname: 'localhost', port: 3000, path: '/api/csrf-token', method: 'GET', headers: { Cookie: sid } });
    csrfToken = JSON.parse(csrf.body).token;
    test('CSRF token endpoint', csrf.status === 200 && !!csrfToken, `status=${csrf.status}`);
  } catch(e) { test('Session/CSRF', false, e.message); }

  // 3. Chat endpoint
  try {
    const chatBody = JSON.stringify({ message: 'smoke test ping', sessionId: 'smoke-test' });
    const chat = await request({
      hostname: 'localhost', port: 3000, path: '/chat', method: 'POST',
      headers: { Cookie: sid, 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }
    }, chatBody);
    const d = JSON.parse(chat.body);
    test('Chat endpoint (200)', chat.status === 200, `status=${chat.status}`);
    test('Chat returns reply', !!d.reply, 'no reply field');
  } catch(e) { test('Chat endpoint', false, e.message); }

  // 4. WhatsApp status
  try {
    const wa = await request({ hostname: 'localhost', port: 3000, path: '/whatsapp/status', method: 'GET' });
    const d = JSON.parse(wa.body);
    test('WhatsApp status (200)', wa.status === 200, `status=${wa.status}`);
    test('WhatsApp has state field', !!d.state, 'no state');
    test('WhatsApp QR available', d.state === 'connected' || !!d.qr, `state=${d.state}, qr=${!!d.qr}`);
  } catch(e) { test('WhatsApp status', false, e.message); }

  // 5. Sheets integration
  try {
    const sheets = require('/root/claude-chatbot/integrations/sheets');
    const meta = await sheets.getSpreadsheet('1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4');
    test('Sheets API accessible', !!meta && !!meta.sheets, 'no metadata');
    const expTab = meta?.sheets?.find(s => s.properties.title === 'EXPENSES');
    test('EXPENSES tab exists', !!expTab, 'tab not found');
  } catch(e) { test('Sheets integration', false, e.message); }

  // 6. CSRF auto-recovery (stale token)
  try {
    const chatBody = JSON.stringify({ message: 'csrf test', sessionId: 'smoke-csrf' });
    const stale = await request({
      hostname: 'localhost', port: 3000, path: '/chat', method: 'POST',
      headers: { Cookie: sid, 'Content-Type': 'application/json', 'x-csrf-token': 'STALE_TOKEN' }
    }, chatBody);
    test('Stale CSRF returns 403', stale.status === 403, `status=${stale.status}`);
    const d = JSON.parse(stale.body);
    test('CSRF error has csrf flag', d.csrf === true, JSON.stringify(d));

    // Refresh token still works
    const refresh = await request({ hostname: 'localhost', port: 3000, path: '/api/csrf-token', method: 'GET', headers: { Cookie: sid } });
    test('Token refresh after 403', refresh.status === 200, `status=${refresh.status}`);
  } catch(e) { test('CSRF recovery', false, e.message); }

  // 7. Session persistence check
  try {
    const Database = require('/root/claude-chatbot/node_modules/better-sqlite3');
    const db = new Database('/root/claude-chatbot/data/express-sessions.db');
    const count = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get();
    test('SQLite session store has sessions', count.cnt > 0, `count=${count.cnt}`);
    db.close();
  } catch(e) { test('Session persistence', false, e.message); }

  // Summary
  console.log('\nResults:');
  results.forEach(r => console.log(r));
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log(failed === 0 ? '✅ ALL SMOKE TESTS PASSED' : '❌ SOME TESTS FAILED');
  process.exit(failed > 0 ? 1 : 0);
})();
