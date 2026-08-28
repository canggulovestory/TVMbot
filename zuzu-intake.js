/**
 * Private Zuzu document inbox.
 *
 * Files are stored on the VPS data volume (never the public web root). Intake
 * produces a review draft only; an operator must approve the fields before a
 * contract, invoice, or other record enters TVM operations.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MAX_BYTES = 6 * 1024 * 1024;
const ACCEPTED_TYPES = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'image/jpeg', 'image/png', 'image/webp',
]);
let dataDir = '';
let storePath = '';
let filesDir = '';
let writeQueue = Promise.resolve();

function init(root) {
  dataDir = root;
  storePath = path.join(root, 'zuzu-intake.json');
  filesDir = path.join(root, 'zuzu-files');
}

function clean(value, max = 500) {
  return String(value || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

function safeFileName(value) {
  const base = path.basename(clean(value, 180)).replace(/[^a-zA-Z0-9._ -]/g, '_');
  return base || 'upload';
}

function emptyStore() { return { version: 1, intakes: [] }; }

async function read() {
  if (!storePath) throw new Error('Zuzu intake store is not initialized');
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, 'utf8'));
    return { ...emptyStore(), intakes: Array.isArray(parsed.intakes) ? parsed.intakes : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
}

async function write(store) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${storePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temp, storePath);
}

function mutate(work) {
  const task = writeQueue.then(async () => {
    const store = await read();
    const result = await work(store);
    await write(store);
    return result;
  });
  writeQueue = task.catch(() => {});
  return task;
}

function deriveDraft(fileName, text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = `${fileName} ${value}`.toLowerCase();
  const dates = [...new Set((value.match(/\b(?:20\d{2})[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/g) || []).map(item => item.replace(/[/.]/g, '-')))].slice(0, 8);
  const amounts = [...new Set(value.match(/(?:rp\.?\s*|idr\s*|usd\s*|\$)\d[\d,\.\s]*/gi) || [])].slice(0, 8);
  const emails = [...new Set(value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])].slice(0, 6);
  let type = 'Document';
  if (/invoice|tagihan/.test(lower)) type = 'Invoice';
  else if (/receipt|kwitansi|payment proof|bukti transfer/.test(lower)) type = 'Payment proof';
  else if (/contract|agreement|perjanjian|lease/.test(lower)) type = 'Contract';
  else if (/passport|ktp|identity/.test(lower)) type = 'Identity document';
  return {
    suggestedTitle: clean(path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, ' '), 180),
    suggestedType: type, dateCandidates: dates, amountCandidates: amounts, emailCandidates: emails,
    extractedPreview: value.slice(0, 2800),
  };
}

async function extractText(filePath, mimeType, buffer) {
  if (mimeType.startsWith('text/')) return buffer.toString('utf8').slice(0, 12000);
  if (mimeType !== 'application/pdf') return '';
  // `strings` is deliberately bounded. It is a best-effort preview; Zuzu must
  // never treat it as a verified contract interpretation without user review.
  try {
    const { stdout } = await execFileAsync('strings', ['-n', '4', filePath], { maxBuffer: 256 * 1024, timeout: 8000 });
    return stdout.slice(0, 12000);
  } catch (_) {
    return '';
  }
}

function publicIntake(entry, includePreview = false) {
  const result = {
    id: entry.id, fileName: entry.fileName, mimeType: entry.mimeType, bytes: entry.bytes,
    status: entry.status, uploadedAt: entry.uploadedAt, uploadedBy: entry.uploadedBy,
    driveUrl: entry.driveUrl || '', draft: entry.draft || {}, approvedDocumentId: entry.approvedDocumentId || '',
  };
  if (includePreview) result.privateUrl = `/api/admin/zuzu/intake/${encodeURIComponent(entry.id)}/file`;
  return result;
}

async function ingest({ fileName, mimeType, dataBase64, uploadedBy, driveUpload }) {
  const type = clean(mimeType, 100).toLowerCase();
  if (!ACCEPTED_TYPES.has(type)) throw new Error('Use a PDF, TXT, CSV, JPG, PNG, or WebP file.');
  const encoded = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!encoded) throw new Error('The uploaded file is empty.');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('Keep uploads under 6 MB.');
  const id = `UPL-${crypto.randomUUID()}`;
  const name = safeFileName(fileName);
  const diskName = `${id}-${name}`;
  await fs.mkdir(filesDir, { recursive: true, mode: 0o700 });
  const diskPath = path.join(filesDir, diskName);
  await fs.writeFile(diskPath, buffer, { mode: 0o600 });
  const extractedText = await extractText(diskPath, type, buffer);
  const draft = deriveDraft(name, extractedText);
  let driveUrl = '';
  if (typeof driveUpload === 'function') {
    try { driveUrl = (await driveUpload({ name, mimeType: type, buffer })).url || ''; } catch (error) {
      console.warn('[Zuzu intake] Drive copy skipped:', error.message);
    }
  }
  return mutate(store => {
    const entry = {
      id, fileName: name, storedFile: diskName, mimeType: type, bytes: buffer.length,
      uploadedAt: new Date().toISOString(), uploadedBy: clean(uploadedBy, 60),
      status: 'Needs review', driveUrl, extractedText, draft,
    };
    store.intakes.unshift(entry);
    store.intakes = store.intakes.slice(0, 200);
    return publicIntake(entry, true);
  });
}

async function list(limit = 50) {
  const store = await read();
  return store.intakes.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200)).map(entry => publicIntake(entry, true));
}

async function get(id, { includeText = false } = {}) {
  const store = await read();
  const entry = store.intakes.find(item => item.id === String(id));
  if (!entry) return null;
  const result = publicIntake(entry, true);
  if (includeText) result.extractedText = String(entry.extractedText || '').slice(0, 12000);
  return result;
}

async function fileFor(id) {
  const store = await read();
  const entry = store.intakes.find(item => item.id === String(id));
  if (!entry) return null;
  const filePath = path.join(filesDir, entry.storedFile);
  if (!filePath.startsWith(`${filesDir}${path.sep}`)) return null;
  return { entry, filePath };
}

async function markApproved(id, documentId) {
  return mutate(store => {
    const entry = store.intakes.find(item => item.id === String(id));
    if (!entry) return null;
    entry.status = 'Approved'; entry.approvedDocumentId = String(documentId || ''); entry.approvedAt = new Date().toISOString();
    return publicIntake(entry, true);
  });
}

module.exports = { init, ingest, list, get, fileFor, markApproved, MAX_BYTES };
