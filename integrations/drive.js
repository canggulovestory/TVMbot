
// drive.js — Google Drive integration with full CRUD operations
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

function loadConfig() {
  delete require.cache[require.resolve('../config/integrations.json')];
  return require('../config/integrations.json');
}

function getAuth() {
  const config = loadConfig();
  const d = config.drive || config.gmail; // fallback to gmail creds (same OAuth)
  const auth = new google.auth.OAuth2(d.client_id, d.client_secret);
  auth.setCredentials({
    access_token: d.access_token,
    refresh_token: d.refresh_token
  });
  // Auto-save refreshed tokens
  auth.on('tokens', (tokens) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/integrations.json'), 'utf8'));
      for (const svc of ['gmail','google_calendar','sheets','docs','drive']) {
        if (cfg[svc]) {
          if (tokens.access_token) cfg[svc].access_token = tokens.access_token;
          if (tokens.refresh_token) cfg[svc].refresh_token = tokens.refresh_token;
        }
      }
      fs.writeFileSync(path.join(__dirname, '../config/integrations.json'), JSON.stringify(cfg, null, 2));
    } catch(e) { console.error('[Drive] Token save error:', e.message); }
  });
  return auth;
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// ─── READ Operations ───────────────────────────────────────────────────────────

async function searchFiles(query, maxResults = 10) {
  const drive = getDrive();
  const q = (typeof query === 'string') ? query : String(query || '');
  const res = await drive.files.list({
    q: `name contains '${q.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size, parents)'
  });
  return res.data.files || [];
}

async function findPassports(guestName = '') {
  const drive = getDrive();
  const queries = guestName
    ? [`name contains '${guestName}'`, `name contains 'passport'`]
    : [`name contains 'passport'`, `name contains 'id card'`];
  const results = [];
  for (const q of queries) {
    const res = await drive.files.list({
      q: `${q} and trashed = false`, pageSize: 5,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime)'
    });
    results.push(...(res.data.files || []));
  }
  return [...new Map(results.map(f => [f.id, f])).values()];
}

async function listFolder(folderId = 'root', maxResults = 30) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
    orderBy: 'modifiedTime desc'
  });
  return res.data.files || [];
}

async function getRecentFiles(maxResults = 10) {
  const drive = getDrive();
  const res = await drive.files.list({
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
    orderBy: 'modifiedTime desc',
    q: 'trashed = false'
  });
  return res.data.files || [];
}

async function getFileMeta(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, webViewLink, parents'
  });
  return res.data;
}

async function downloadFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function exportAsText(fileId) {
  const drive = getDrive();
  const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function exportFile(fileId, exportMimeType) {
  const drive = getDrive();
  const res = await drive.files.export({ fileId, mimeType: exportMimeType }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function listFolderFiles(folderId, maxFiles = 10, extraQuery = '') {
  const drive = getDrive();
  const q = `'${folderId}' in parents and trashed = false${extraQuery ? ' and ' + extraQuery.replace(/^and\s+/, '') : ''}`;
  const res = await drive.files.list({
    q, pageSize: Math.min(maxFiles, 50),
    fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
    orderBy: 'modifiedTime desc'
  });
  return res.data.files || [];
}

// ─── CREATE Operations ─────────────────────────────────────────────────────────

async function createFolder(name, parentId = null) {
  const drive = getDrive();
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const res = await drive.files.create({ requestBody: body, fields: 'id, name, webViewLink' });
  return res.data;
}

async function uploadFile(name, buffer, mimeType, parentId = null) {
  const drive = getDrive();
  const fileMetadata = { name };
  if (parentId) fileMetadata.parents = [parentId];
  const media = { mimeType, body: Readable.from(buffer) };
  const res = await drive.files.create({
    requestBody: fileMetadata, media,
    fields: 'id, name, mimeType, webViewLink, size'
  });
  return res.data;
}

async function copyFile(fileId, newName = null, parentId = null) {
  const drive = getDrive();
  const body = {};
  if (newName) body.name = newName;
  if (parentId) body.parents = [parentId];
  const res = await drive.files.copy({ fileId, requestBody: body, fields: 'id, name, webViewLink' });
  return res.data;
}

// ─── UPDATE Operations ─────────────────────────────────────────────────────────

async function renameFile(fileId, newName) {
  const drive = getDrive();
  const res = await drive.files.update({
    fileId, requestBody: { name: newName },
    fields: 'id, name, webViewLink'
  });
  return res.data;
}

async function moveFile(fileId, newParentId) {
  const drive = getDrive();
  // Get current parents first
  const file = await drive.files.get({ fileId, fields: 'parents' });
  const prevParents = (file.data.parents || []).join(',');
  const res = await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: prevParents,
    fields: 'id, name, webViewLink, parents'
  });
  return res.data;
}

async function updateFileContent(fileId, buffer, mimeType) {
  const drive = getDrive();
  const media = { mimeType, body: Readable.from(buffer) };
  const res = await drive.files.update({
    fileId, media,
    fields: 'id, name, mimeType, webViewLink, modifiedTime'
  });
  return res.data;
}

// ─── DELETE Operations ─────────────────────────────────────────────────────────

async function deleteFile(fileId) {
  const drive = getDrive();
  await drive.files.delete({ fileId });
  return { success: true, deleted: fileId };
}

async function trashFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.update({
    fileId, requestBody: { trashed: true },
    fields: 'id, name, trashed'
  });
  return res.data;
}

async function restoreFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.update({
    fileId, requestBody: { trashed: false },
    fields: 'id, name, trashed, webViewLink'
  });
  return res.data;
}

// ─── CONVERT / EXPORT ──────────────────────────────────────────────────────────

async function convertFile(fileId, targetMimeType) {
  const drive = getDrive();
  const meta = await getFileMeta(fileId);

  // Google native formats → export
  const googleTypes = {
    'application/vnd.google-apps.document': true,
    'application/vnd.google-apps.spreadsheet': true,
    'application/vnd.google-apps.presentation': true
  };

  if (googleTypes[meta.mimeType]) {
    const buffer = await exportFile(fileId, targetMimeType);
    const extMap = {
      'application/pdf': '.pdf',
      'text/plain': '.txt',
      'text/html': '.html',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'text/csv': '.csv'
    };
    const ext = extMap[targetMimeType] || '';
    const newName = meta.name.replace(/\.[^.]+$/, '') + ext;
    // Upload the converted file
    const uploaded = await uploadFile(newName, buffer, targetMimeType, meta.parents?.[0]);
    return { original: meta.name, converted: uploaded.name, id: uploaded.id, webViewLink: uploaded.webViewLink };
  }

  throw new Error(`Cannot convert ${meta.mimeType} to ${targetMimeType}. Only Google Docs/Sheets/Slides can be exported.`);
}

// ─── MERGE (PDFs) ──────────────────────────────────────────────────────────────

async function mergeFiles(fileIds, mergedName = 'Merged Document') {
  // Download all files, check they are PDFs
  let PDFLib;
  try { PDFLib = require('pdf-lib'); } catch(e) { throw new Error('pdf-lib not installed — run: npm install pdf-lib'); }

  const merged = await PDFLib.PDFDocument.create();

  for (const fid of fileIds) {
    const meta = await getFileMeta(fid);
    let buffer;

    if (meta.mimeType === 'application/vnd.google-apps.document') {
      buffer = await exportFile(fid, 'application/pdf');
    } else if (meta.mimeType === 'application/pdf') {
      buffer = await downloadFile(fid);
    } else {
      throw new Error(`File "${meta.name}" is not a PDF or Google Doc. Only PDFs and Docs can be merged.`);
    }

    const src = await PDFLib.PDFDocument.load(buffer);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }

  const pdfBytes = await merged.save();
  const uploaded = await uploadFile(mergedName + '.pdf', Buffer.from(pdfBytes), 'application/pdf');
  return { merged: uploaded.name, id: uploaded.id, webViewLink: uploaded.webViewLink, pageCount: merged.getPageCount() };
}

module.exports = {
  // Read
  searchFiles, findPassports, listFolder, getRecentFiles, getFileMeta,
  downloadFile, exportAsText, exportFile, listFolderFiles,
  // Create
  createFolder, uploadFile, copyFile,
  // Update
  renameFile, moveFile, updateFileContent,
  // Delete
  deleteFile, trashFile, restoreFile,
  // Convert / Merge
  convertFile, mergeFiles
};
