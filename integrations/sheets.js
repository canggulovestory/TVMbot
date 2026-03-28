const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config/integrations.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function getAuth() {
  const config = loadConfig();
  const s = config.sheets || {};
  const auth = new google.auth.OAuth2(
    s.client_id || '',
    s.client_secret || '',
    'https://developers.google.com/oauthplayground'
  );
  const creds = {};
  if (s.access_token) creds.access_token = s.access_token;
  if (s.refresh_token) creds.refresh_token = s.refresh_token;
  auth.setCredentials(creds);
  auth.on('tokens', (tokens) => {
    try {
      const cfg = loadConfig();
      if (tokens.access_token) {
        for (const svc of ['sheets','gmail','docs','drive','google_calendar']) {
          if (cfg[svc]) cfg[svc].access_token = tokens.access_token;
        }
        cfg.sheets.token_updated_at = new Date().toISOString();
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      console.log('[Sheets] Access token auto-refreshed');
    } catch (e) { console.error('[Sheets] Token save error:', e.message); }
  });
  return auth;
}

function getClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

async function readSheet(spreadsheetId, range = 'Sheet1') {
  try {
    const res = await getClient().spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (err) { console.error('Sheets read error:', err.message); return []; }
}

async function writeSheet(spreadsheetId, range, values) {
  try {
    await getClient().spreadsheets.values.update({
      spreadsheetId, range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: Array.isArray(values[0]) ? values : [values] }
    });
    return true;
  } catch (err) { console.error('Sheets write error:', err.message); return false; }
}

async function appendSheet(spreadsheetId, sheetName, rowValues) {
  try {
    const range = sheetName + '!A:Z';
    const row = Array.isArray(rowValues[0]) ? rowValues : [rowValues];
    await getClient().spreadsheets.values.append({
      spreadsheetId, range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: row }
    });
    return true;
  } catch (err) { console.error('Sheets append error:', err.message); return false; }
}

async function listSheets(spreadsheetId) {
  try {
    const res = await getClient().spreadsheets.get({ spreadsheetId });
    return res.data.sheets.map(s => ({ title: s.properties.title, sheetId: s.properties.sheetId }));
  } catch (err) { console.error('Sheets list error:', err.message); return []; }
}

async function createSpreadsheet(title) {
  try {
    const res = await getClient().spreadsheets.create({ requestBody: { properties: { title } } });
    return res.data;
  } catch (err) { console.error('Sheets create error:', err.message); return null; }
}

async function batchUpdate(spreadsheetId, requests) {
  try {
    const res = await getClient().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    return res.data;
  } catch (err) { console.error('Sheets batchUpdate error:', err.message); throw err; }
}

async function getSpreadsheet(spreadsheetId) {
  try {
    const res = await getClient().spreadsheets.get({ spreadsheetId });
    return res.data;
  } catch (err) { console.error('Sheets get error:', err.message); return null; }
}

module.exports = { readSheet, writeSheet, appendSheet, listSheets, createSpreadsheet, batchUpdate, getSpreadsheet };
