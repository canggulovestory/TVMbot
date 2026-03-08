const { google } = require('googleapis');
const config = require('../config/integrations.json');
const s = config.sheets;

function getAuth() {
  const auth = new google.auth.OAuth2(s.client_id, s.client_secret);
  auth.setCredentials({ refresh_token: s.refresh_token });
  return auth;
}

async function readSheet(spreadsheetId, range = 'Sheet1') {
  try {
    const sheets = google.sheets({ version: 'v4', auth: getAuth() });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (err) { console.error('Sheets read error:', err.message); return []; }
}

async function writeSheet(spreadsheetId, range, values) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: getAuth() });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    return true;
  } catch (err) { console.error('Sheets write error:', err.message); return false; }
}

async function appendSheet(spreadsheetId, range, values) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: getAuth() });
    await sheets.spreadsheets.values.append({
      spreadsheetId, range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    return true;
  } catch (err) { console.error('Sheets append error:', err.message); return false; }
}

async function listSheets(spreadsheetId) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: getAuth() });
    const res = await sheets.spreadsheets.get({ spreadsheetId });
    return res.data.sheets.map(s => s.properties.title);
  } catch (err) { console.error('Sheets list error:', err.message); return []; }
}

module.exports = { readSheet, writeSheet, appendSheet, listSheets };
