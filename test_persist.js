
const http = require('http');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, cookies }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // 1. Create a session
  const page = await request({ hostname: 'localhost', port: 3000, path: '/', method: 'GET' });
  const sidCookie = (page.cookies.find(c => c.startsWith('connect.sid')) || '').split(';')[0];
  console.log('1. Session created:', sidCookie ? 'YES' : 'NO');

  // 2. Get CSRF token (this triggers session._csrf to be set and saved)
  const csrf = await request({ hostname: 'localhost', port: 3000, path: '/api/csrf-token', method: 'GET', headers: { Cookie: sidCookie } });
  const token = JSON.parse(csrf.body).token;
  console.log('2. CSRF token:', token.substring(0,16) + '...');

  // 3. Check DB has the session
  const db = new Database('/root/claude-chatbot/data/express-sessions.db');
  const before = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get();
  console.log('3. Sessions in DB before restart:', before.cnt);
  db.close();

  // 4. Restart PM2
  execSync('pm2 restart tvmbot --silent');
  console.log('4. PM2 restarted');
  await new Promise(r => setTimeout(r, 4000));

  // 5. Check session still in DB
  const db2 = new Database('/root/claude-chatbot/data/express-sessions.db');
  const after = db2.prepare('SELECT COUNT(*) as cnt FROM sessions').get();
  console.log('5. Sessions in DB after restart:', after.cnt);
  db2.close();

  // 6. Try to use the OLD session cookie + token
  const csrf2 = await request({ hostname: 'localhost', port: 3000, path: '/api/csrf-token', method: 'GET', headers: { Cookie: sidCookie } });
  console.log('6. Old cookie still works:', csrf2.status === 200 ? 'YES' : 'NO (' + csrf2.status + ')');
  if (csrf2.status === 200) {
    const t2 = JSON.parse(csrf2.body).token;
    console.log('   Token matches original:', t2 === token ? 'YES (PERSISTED!)' : 'NO (new token)');
  }

  // 7. POST with old token should now work
  const chatBody = JSON.stringify({ message: 'session persistence test', sessionId: 'persist-test' });
  const chat = await request({
    hostname: 'localhost', port: 3000, path: '/chat', method: 'POST',
    headers: { Cookie: sidCookie, 'Content-Type': 'application/json', 'x-csrf-token': token }
  }, chatBody);
  console.log('7. POST with old token after restart:', chat.status === 200 ? 'SUCCESS' : 'FAILED (' + chat.status + ')');

  console.log('\nRESULT: Sessions ' + (chat.status === 200 ? 'PERSIST across PM2 restart!' : 'DO NOT persist'));
})();
