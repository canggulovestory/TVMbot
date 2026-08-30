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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel', 'application/msword',
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

function normalizeMimeType(fileName, value) {
  const supplied = clean(value, 100).toLowerCase();
  if (ACCEPTED_TYPES.has(supplied)) return supplied;
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return ({ '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.doc': 'application/msword' })[ext] || supplied;
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
  const draft = {
    suggestedTitle: clean(path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, ' '), 180),
    suggestedType: type, dateCandidates: dates, amountCandidates: amounts, emailCandidates: emails,
    extractedPreview: value.slice(0, 2800),
  };
  if (type === 'Contract') draft.contract = deriveContractDraft(value, dates);
  return draft;
}

function normalizedDate(value) {
  const iso = String(value || '').match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const named = String(value || '').match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/i);
  if (!named) return '';
  const month = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(named[2].toLowerCase()) + 1;
  return `${named[3]}-${String(month).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
}

function labelledDate(text, pattern) {
  const match = String(text || '').match(new RegExp(`${pattern}.{0,50}?((?:20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2})|(?:\\d{1,2}\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+20\\d{2}))`, 'i'));
  return normalizedDate(match?.[1]);
}

function labelledAmount(text, pattern) {
  const match = String(text || '').match(new RegExp(`${pattern}.{0,70}?((?:rp\\.?|idr|usd|\\$)\\s*[\\d,.\\s]+)`, 'i'));
  return match ? clean(match[1].replace(/\s+/g, ' '), 80) : '';
}

function addDays(value, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Conservative contract extraction: all fields are candidates for approval, never facts. */
function deriveContractDraft(text, dateCandidates = []) {
  const startDate = labelledDate(text, '(?:start|commencement|check[ -]?in|term begins|effective date)');
  const endDate = labelledDate(text, '(?:end|expiry|expiration|check[ -]?out|term ends|valid until)');
  const renewalDate = labelledDate(text, '(?:renewal|extend|extension)');
  const rent = labelledAmount(text, '(?:monthly rent|rent amount|rental fee|rent)');
  const deposit = labelledAmount(text, '(?:security deposit|deposit)');
  const frequency = /quarterly/i.test(text) ? 'Quarterly' : /upfront|in advance|annual|yearly/i.test(text) ? 'Upfront' : /monthly|per month/i.test(text) ? 'Monthly' : '';
  const firstDueDate = labelledDate(text, '(?:first payment|payment due|due date|rent due)') || startDate;
  const client = String(text || '').match(/(?:tenant|guest|lessee)\s*(?:name)?\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{2,80}?)(?=\s+(?:commencement|start|end|expiry|expiration|monthly|rent|security|deposit|first payment)\b|$)/i)?.[1] || '';
  const notes = [];
  if (!text) notes.push('No machine-readable text found. Open the file and enter the contract details manually.');
  if (!startDate || !endDate) notes.push('Confirm the start and end dates before creating a stay or reminders.');
  if (!rent) notes.push('Confirm rent and currency before creating a payment schedule.');
  return {
    confidence: text ? 'Review required' : 'Manual review required', guestNameCandidate: clean(client, 100),
    startDate, endDate, renewalDate, paymentFrequency: frequency, rentCandidate: rent, depositCandidate: deposit,
    firstPaymentDueDate: firstDueDate, suggestedFollowUpDate: addDays(firstDueDate, -7),
    dateCandidates, reminders: [
      endDate && { kind: 'Contract expiry', date: addDays(endDate, -30), note: 'Review renewal 30 days before contract end.' },
      firstDueDate && { kind: 'Payment follow-up', date: addDays(firstDueDate, -7), note: 'Follow up seven days before the first payment is due.' },
    ].filter(Boolean), notes,
  };
}

async function extractText(filePath, mimeType, buffer) {
  if (mimeType.startsWith('text/')) return buffer.toString('utf8').slice(0, 12000);
  const office = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  if (office.has(mimeType)) {
    try {
      const { stdout } = await execFileAsync('unzip', ['-p', filePath], { maxBuffer: 512 * 1024, timeout: 8000 });
      return stdout.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').slice(0, 12000);
    } catch (_) { return ''; }
  }
  if (mimeType !== 'application/pdf' && mimeType !== 'application/vnd.ms-excel' && mimeType !== 'application/msword') return '';
  if (mimeType === 'application/pdf') {
    try {
      const { stdout } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], { maxBuffer: 512 * 1024, timeout: 12000 });
      if (stdout.trim()) return stdout.replace(/\s+/g, ' ').slice(0, 12000);
    } catch (_) { /* Fall back for minimal VPS installations. */ }
  }
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
  const type = normalizeMimeType(fileName, mimeType);
  if (!ACCEPTED_TYPES.has(type)) throw new Error('Use a PDF, Word, Excel, TXT, CSV, JPG, PNG, or WebP file.');
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

module.exports = { init, ingest, list, get, fileFor, markApproved, normalizeMimeType, deriveDraft, deriveContractDraft, MAX_BYTES };
