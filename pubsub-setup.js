// pubsub-setup.js — One-time setup helper for Gmail Push Notifications
// Run this ONCE to set up Google Cloud Pub/Sub for Gmail push notifications
//
// PREREQUISITES:
// 1. Go to Google Cloud Console → https://console.cloud.google.com
// 2. Select your project (or create one called "tvmbot-gmail")
// 3. Enable the "Cloud Pub/Sub API"
// 4. Enable the "Gmail API" (should already be enabled)
// 5. Create a Pub/Sub topic called "gmail-notifications"
// 6. Grant publish permission to Gmail:
//    - Go to Pub/Sub → Topics → gmail-notifications → Permissions
//    - Add member: gmail-api-push@system.gserviceaccount.com
//    - Role: Pub/Sub Publisher
// 7. Create a Pub/Sub subscription:
//    - Type: Push
//    - Endpoint URL: https://thevillamanagers.cloud/webhook/gmail
//    - Acknowledgement deadline: 30 seconds
//
// After completing these steps, run this script to start the Gmail watch:
//   node pubsub-setup.js
//
// The watch will expire after 7 days — the cron job in server.js auto-renews it.

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config', 'integrations.json');
const TOPIC = process.argv[2] || 'projects/tvmbot-gmail/topics/gmail-notifications';

async function setup() {
  console.log('=== TVMbot Gmail Push Notification Setup ===\n');

  // Load config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const gmailCfg = config.gmail;

  if (!gmailCfg || !gmailCfg.client_id) {
    console.error('ERROR: Gmail not configured in integrations.json');
    process.exit(1);
  }

  // Build auth
  const auth = new google.auth.OAuth2(
    gmailCfg.client_id,
    gmailCfg.client_secret,
    'https://developers.google.com/oauthplayground'
  );
  auth.setCredentials({
    access_token: gmailCfg.access_token,
    refresh_token: gmailCfg.refresh_token
  });

  const gmail = google.gmail({ version: 'v1', auth });

  console.log('1. Testing Gmail API connection...');
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log(`   ✅ Connected as: ${profile.data.emailAddress}`);
    console.log(`   Messages total: ${profile.data.messagesTotal}`);
  } catch (err) {
    console.error(`   ❌ Gmail API error: ${err.message}`);
    console.log('\n   Make sure your OAuth tokens are valid. Try refreshing them at:');
    console.log('   https://developers.google.com/oauthplayground');
    process.exit(1);
  }

  console.log(`\n2. Setting up Gmail watch on topic: ${TOPIC}`);
  try {
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: TOPIC,
        labelIds: ['INBOX']
      }
    });

    const expiry = new Date(parseInt(res.data.expiration));
    console.log(`   ✅ Watch started successfully!`);
    console.log(`   History ID: ${res.data.historyId}`);
    console.log(`   Expires: ${expiry.toISOString()} (${Math.round((expiry - Date.now()) / 86400000)} days)`);

    // Save state
    const stateDir = path.join(__dirname, 'data');
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

    const stateFile = path.join(stateDir, 'email-watcher-state.json');
    let state = { processedIds: [], stats: { total_processed: 0, airbnb: 0, bank: 0, errors: 0 } };
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    state.lastHistoryId = res.data.historyId;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    console.log(`   State saved to ${stateFile}`);

  } catch (err) {
    console.error(`   ❌ Watch setup error: ${err.message}`);
    console.log('\n   Common issues:');
    console.log('   - Pub/Sub topic does not exist → Create it in Google Cloud Console');
    console.log('   - Permission denied → Grant gmail-api-push@system.gserviceaccount.com Pub/Sub Publisher role');
    console.log('   - Topic name wrong → Format: projects/PROJECT_ID/topics/TOPIC_NAME');
    process.exit(1);
  }

  console.log('\n3. Checklist:');
  console.log('   [ ] Pub/Sub topic created in Google Cloud Console');
  console.log('   [ ] gmail-api-push@system.gserviceaccount.com has Publisher role');
  console.log('   [ ] Push subscription created with endpoint: https://thevillamanagers.cloud/webhook/gmail');
  console.log('   [ ] server.js deployed with webhook endpoint');
  console.log('   [ ] PM2 restarted');

  console.log('\n=== Setup complete! ===');
  console.log('Gmail will now push notifications to your server when new emails arrive.');
  console.log('The watch expires in ~7 days and is auto-renewed by the cron job in server.js.');
}

setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
