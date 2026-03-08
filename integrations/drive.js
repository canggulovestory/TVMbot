const { google } = require('googleapis');
const config = require('../config/integrations.json');
const d = config.drive;

function getAuth() {
  const auth = new google.auth.OAuth2(d.client_id, d.client_secret);
  auth.setCredentials({ refresh_token: d.refresh_token });
  return auth;
}

async function searchFiles(query, maxResults = 10) {
  try {
    const drive = google.drive({ version: 'v3', auth: getAuth() });
    const res = await drive.files.list({
      q: `name contains '${query}' and trashed = false`,
      pageSize: maxResults,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)'
    });
    return res.data.files || [];
  } catch (err) { console.error('Drive search error:', err.message); return []; }
}

async function findPassports(guestName = '') {
  try {
    const drive = google.drive({ version: 'v3', auth: getAuth() });
    const queries = guestName
      ? [`name contains '${guestName}'`, `name contains 'passport'`, `name contains 'id'`]
      : [`name contains 'passport'`, `name contains 'id card'`, `name contains 'identity'`];
    const results = [];
    for (const q of queries) {
      const res = await drive.files.list({
        q: `${q} and trashed = false`,
        pageSize: 5,
        fields: 'files(id, name, mimeType, webViewLink, modifiedTime)'
      });
      results.push(...(res.data.files || []));
    }
    const unique = [...new Map(results.map(f => [f.id, f])).values()];
    return unique;
  } catch (err) { console.error('Drive passport search error:', err.message); return []; }
}

async function listFolder(folderId = 'root') {
  try {
    const drive = google.drive({ version: 'v3', auth: getAuth() });
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: 20,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime)',
      orderBy: 'modifiedTime desc'
    });
    return res.data.files || [];
  } catch (err) { console.error('Drive list error:', err.message); return []; }
}

async function createFolder(name, parentId = 'root') {
  try {
    const drive = google.drive({ version: 'v3', auth: getAuth() });
    const res = await drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
      fields: 'id, name, webViewLink'
    });
    return res.data;
  } catch (err) { console.error('Drive folder error:', err.message); return null; }
}

async function getRecentFiles(maxResults = 10) {
  try {
    const drive = google.drive({ version: 'v3', auth: getAuth() });
    const res = await drive.files.list({
      pageSize: maxResults,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime)',
      orderBy: 'modifiedTime desc',
      q: 'trashed = false'
    });
    return res.data.files || [];
  } catch (err) { console.error('Drive recent error:', err.message); return []; }
}

module.exports = { searchFiles, findPassports, listFolder, createFolder, getRecentFiles };
