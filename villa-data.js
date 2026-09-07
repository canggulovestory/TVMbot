/**
 * Detailed villa, tenancy, installment, deposit, and document records.
 * Stored on the private VPS data volume and exposed only through authenticated APIs.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const COLLECTIONS = ['villas', 'tenancies', 'installments', 'deposits', 'documents', 'transactions', 'invoices', 'payables', 'villaTasks'];
const PREFIX = { villas: 'VIL', tenancies: 'TEN', installments: 'PAY', deposits: 'DEP', documents: 'DOC', transactions: 'TRX', invoices: 'INV', payables: 'BILL', villaTasks: 'VTK' };
const FIELDS = {
  villas: ['name', 'code', 'status', 'location', 'mapUrl', 'bedrooms', 'bathrooms', 'maxGuests', 'pool', 'facilities', 'ownerName', 'ownerPhone', 'ownerEmail', 'monthlyRate', 'yearlyRate', 'currency', 'paymentTerms', 'publicWhatsApp', 'photosFolderUrl', 'listingUrl', 'ownerAgreementUrl', 'marketingNotes', 'keyBoxCode', 'backupKeyLocation', 'checkInInstructions', 'internetProvider', 'internetPlan', 'internetLocationId', 'internetCircuitId', 'internetBillingDetails', 'internetPaymentDetails', 'internetPortalUrl', 'wifiName', 'wifiPassword', 'electricityDetails', 'waterDetails', 'gasDetails', 'poolServiceSchedule', 'cleaningSchedule', 'gardeningSchedule', 'wasteSchedule', 'pestControlSchedule', 'linenSchedule', 'maintenanceContact', 'emergencyContact', 'operationsNotes', 'photoUrl', 'gallery', 'published', 'slug', 'summary'],
  tenancies: ['code', 'villaId', 'guestName', 'guestPhone', 'guestEmail', 'nationality', 'idDocumentUrl', 'bookingStatus', 'checkIn', 'checkOut', 'rentalTerm', 'guestCount', 'rentAmount', 'currency', 'paymentFrequency', 'source', 'agencyCommissionPercent', 'contractUrl', 'notes'],
  installments: ['code', 'tenancyId', 'villaId', 'installmentNumber', 'installmentTotal', 'period', 'purpose', 'amount', 'currency', 'dueDate', 'followUpDate', 'gracePeriodDays', 'status', 'paidDate', 'paymentMethod', 'proofUrl', 'lateFee', 'ownerPayoutStatus'],
  deposits: ['code', 'tenancyId', 'villaId', 'purpose', 'amount', 'currency', 'collectedDate', 'heldIn', 'status', 'refundDueDate', 'deductions', 'deductionNotes', 'refundedAmount', 'refundDate', 'refundProofUrl', 'inventoryUrl'],
  documents: ['title', 'type', 'villaId', 'tenancyId', 'driveUrl', 'signed', 'signedDate', 'expiryDate', 'notes'],
  transactions: ['code', 'villaId', 'tenancyId', 'type', 'category', 'description', 'amount', 'currency', 'date', 'proofUrl', 'notes', 'sourceId'],
  invoices: ['code', 'clientName', 'clientEmail', 'villaId', 'category', 'description', 'amount', 'currency', 'issueDate', 'dueDate', 'status', 'paidDate', 'paymentMethod', 'proofUrl', 'notes', 'sourceId'],
  payables: ['code', 'vendorName', 'villaId', 'category', 'description', 'amount', 'currency', 'issueDate', 'dueDate', 'status', 'paidDate', 'paymentMethod', 'proofUrl', 'notes', 'sourceId'],
  villaTasks: ['title', 'villaId', 'category', 'priority', 'status', 'dueDate', 'assignee', 'cost', 'notes'],
};
const NUMBER_FIELDS = new Set(['bedrooms', 'bathrooms', 'maxGuests', 'monthlyRate', 'yearlyRate', 'guestCount', 'rentAmount', 'agencyCommissionPercent', 'installmentNumber', 'installmentTotal', 'amount', 'gracePeriodDays', 'lateFee', 'deductions', 'refundedAmount', 'cost']);
const BOOLEAN_FIELDS = new Set(['pool', 'signed', 'published']);
let filePath;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { version: 1, villas: [], tenancies: [], installments: [], deposits: [], documents: [], transactions: [], invoices: [], payables: [], villaTasks: [] };
}

function init(dataDir) {
  filePath = path.join(dataDir, 'villa-operations.json');
}

function clean(value, max = 2000, multiline = false) {
  const text = String(value ?? '').trim().replace(/\r\n?/g, '\n');
  return text.replace(multiline ? /[\u0000-\u0009\u000b-\u001f]/g : /[\u0000-\u001f]/g, ' ').slice(0, max);
}

function normalizeUrl(value) {
  const url = clean(value, 1500);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

function slugify(value) {
  return clean(value, 160).toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

function normalize(collection, input, existing = {}) {
  if (!COLLECTIONS.includes(collection)) throw new Error('Unknown record type');
  const next = { ...existing };
  for (const field of FIELDS[collection]) {
    if (!(field in input)) continue;
    if (field === 'gallery') {
      next[field] = Array.isArray(input[field])
        ? input[field].map(normalizeUrl).filter(Boolean).slice(0, 80)
        : (Array.isArray(existing[field]) ? existing[field] : []);
    } else if (BOOLEAN_FIELDS.has(field)) next[field] = input[field] === true || input[field] === 'true' || input[field] === 'on';
    else if (NUMBER_FIELDS.has(field)) next[field] = Number.isFinite(Number(input[field])) ? Number(input[field]) : 0;
    else if (/Url$/.test(field)) next[field] = normalizeUrl(input[field]);
    else {
      const multiline = ['notes', 'marketingNotes', 'operationsNotes', 'checkInInstructions', 'deductionNotes', 'internetBillingDetails', 'internetPaymentDetails'].includes(field);
      next[field] = clean(input[field], multiline ? 4000 : 500, multiline);
    }
  }
  if (collection === 'villas') {
    if (!existing.id && !('published' in input)) next.published = true;
    const slug = slugify(('slug' in input ? input.slug : next.slug) || next.name);
    if (slug) next.slug = slug;
  }
  return next;
}

async function read() {
  if (!filePath) throw new Error('Villa data store not initialized');
  try {
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const base = emptyStore();
    for (const collection of COLLECTIONS) base[collection] = Array.isArray(stored[collection]) ? stored[collection] : [];
    return base;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
}

async function write(store) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temp, filePath);
}

function mutate(work) {
  const task = writeQueue.then(async () => {
    const store = await read();
    const result = await work(store);
    await write(store);
    return result;
  });
  // Keep the queue healthy even if this task throws (e.g. delete protection).
  writeQueue = task.catch(() => {});
  return task;
}

function newId(collection) {
  return `${PREFIX[collection]}-${crypto.randomUUID()}`;
}

function conflict(message) { const error = new Error(message); error.statusCode = 409; throw error; }

function depositBalance(item) {
  const collected = ['Held', 'Partially refunded', 'Refunded', 'Forfeited'].includes(item.status);
  const net = Math.max(0, Number(item.amount || 0) - Number(item.deductions || 0));
  return { ...item, collectedAmount: collected ? Number(item.amount || 0) : 0,
    refundableAmount: ['Held', 'Partially refunded'].includes(item.status) ? Math.max(0, net - Number(item.refundedAmount || 0)) : 0 };
}

function validateRecord(collection, record, existing) {
  if (['installments', 'invoices', 'payables', 'deposits', 'transactions'].includes(collection) && (!Number.isFinite(record.amount) || record.amount < 0)) conflict('Amount must be a non-negative number.');
  if (['installments', 'invoices', 'payables'].includes(collection) && existing.status === 'Paid' && record.status !== 'Paid') conflict('A paid record cannot be reopened. Record a separate refund or correction to preserve settled history.');
  if (collection !== 'deposits') return;
  const states = ['Awaiting collection', 'Held', 'Partially refunded', 'Refunded', 'Forfeited'];
  record.status ||= 'Awaiting collection';
  if (!states.includes(record.status)) conflict('Choose a valid deposit status.');
  if (record.status === 'Awaiting collection' && ((record.refundedAmount || 0) > 0 || record.refundDate || (record.deductions || 0) > 0)) conflict('Collect the deposit before recording refund amounts, dates or deductions.');
  if (record.status === 'Held' && (record.refundedAmount || 0) > 0) conflict('Use partially refunded status when money has been refunded.');
  if ((record.refundedAmount || 0) > 0 && !record.refundDate) conflict('Enter the date of the recorded refund.');
  if ((record.deductions || 0) < 0 || (record.refundedAmount || 0) < 0 || (record.deductions || 0) + (record.refundedAmount || 0) > record.amount) conflict('Deductions and refunds cannot exceed the collected deposit.');
  if (existing.id && ['Refunded', 'Forfeited'].includes(existing.status) && JSON.stringify(record) !== JSON.stringify(existing)) conflict('This deposit is settled. Preserve its refunded history.');
  if (['Held', 'Partially refunded', 'Refunded', 'Forfeited'].includes(existing.status) && record.status === 'Awaiting collection') conflict('A collected deposit cannot be changed back to awaiting collection.');
  if (record.status === 'Held' && !record.collectedDate) conflict('Enter the collection date before marking the deposit held.');
  if (['Partially refunded', 'Refunded', 'Forfeited'].includes(record.status) && record.status !== existing.status && !['Held', 'Partially refunded'].includes(existing.status)) conflict('Collect the deposit before recording a refund or forfeiture.');
  if (record.status === 'Partially refunded' && !(record.refundedAmount > 0 && record.refundedAmount < record.amount - (record.deductions || 0))) conflict('Enter the cumulative partial refund, less than the available balance.');
  if ((record.refundedAmount || 0) < (existing.refundedAmount || 0)) conflict('Previously refunded money cannot be reduced.');
  if (record.status === 'Refunded') {
    if (!record.refundDate) conflict('Enter the refund date.');
    record.refundedAmount = record.amount - (record.deductions || 0);
  }
}

function syncPaidLedger(store, collection, record) {
  if (!['installments', 'invoices', 'payables'].includes(collection) || record.status !== 'Paid') return null;
  const sourceId = collection === 'installments' ? record.id : `${collection === 'invoices' ? 'invoice' : 'payable'}:${record.id}`;
  const existing = store.transactions.find(t => t.sourceId === sourceId);
  const purpose = record.purpose || (/reservation|(?:^|[-_])RES(?:[-_]|$)/i.test(`${record.period || ''} ${record.code || ''}`) ? 'Reservation deposit (non-refundable)' : 'Rent installment');
  const values = { code: record.code || record.id, villaId: record.villaId || '', tenancyId: record.tenancyId || '',
    type: collection === 'payables' ? 'Expense' : 'Income',
    category: collection === 'installments' ? (purpose.startsWith('Reservation') ? 'Reservation deposit' : 'Rent') : record.category || 'Other',
    description: collection === 'installments' ? `${purpose} received — ${record.period || record.code || 'installment'}` : `${collection === 'invoices' ? 'Invoice' : 'Payable'} ${record.code || record.id} — ${record.clientName || record.vendorName || ''}`,
    amount: record.amount, currency: record.currency || 'IDR', date: record.paidDate,
    proofUrl: record.proofUrl || '', sourceId };
  const now = new Date().toISOString();
  if (existing) {
    if (Object.keys(values).some(key => existing[key] !== values[key])) {
      const previous = Object.fromEntries(Object.keys(values).map(key => [key, existing[key] ?? '']));
      existing.corrections = [...(existing.corrections || []), { at: now, previous }];
      Object.assign(existing, values, { updatedAt: now });
    }
    return existing;
  }
  const transaction = { ...values, id: newId('transactions'), notes: '', createdAt: now, updatedAt: now };
  store.transactions.unshift(transaction);
  return transaction;
}

function saveRecord(store, collection, input) {
    if (!COLLECTIONS.includes(collection)) throw new Error('Unknown record type');
    for (const field of ['amount', 'rentAmount', 'deductions', 'refundedAmount', 'lateFee']) {
      if (field in input && (!['string', 'number'].includes(typeof input[field]) || !Number.isFinite(Number(input[field])) || Number(input[field]) < 0)) conflict(`${field} must be a non-negative number.`);
    }
    const now = new Date().toISOString();
    const id = clean(input.id, 80);
    const index = id ? store[collection].findIndex(item => item.id === id) : -1;
    const existing = index >= 0 ? store[collection][index] : {};
    if (id && index < 0) conflict('Record no longer exists. Refresh before saving.');
    if (collection === 'transactions' && (existing.sourceId || input.sourceId)) conflict('Edit the linked payment source, not its automatic finance entry.');
    const record = normalize(collection, input, existing);
    if (existing.id && ['installments', 'invoices', 'payables'].includes(collection) && record.status !== 'Paid' && store.transactions.some(t => [existing.id, `invoice:${existing.id}`, `payable:${existing.id}`].includes(t.sourceId))) conflict('This record has settled ledger history. Reconcile it as paid before editing.');
    validateRecord(collection, record, existing);
    if (['installments', 'invoices', 'payables'].includes(collection) && record.status === 'Paid') record.paidDate ||= now.slice(0, 10);
    record.id = existing.id || newId(collection);
    record.createdAt = existing.createdAt || now;
    record.updatedAt = now;
    if (index >= 0) store[collection][index] = record;
    else store[collection].unshift(record);
    syncPaidLedger(store, collection, record);
    return record;
}

async function upsert(collection, input) {
  return mutate(store => saveRecord(store, collection, input));
}

async function saveReferenceLink({ villaId, title, url, userKey }) {
  return mutate(store => {
    if (!store.villas.some(villa => villa.id === villaId)) throw new Error('Villa not found');
    const driveUrl = normalizeUrl(url);
    if (!driveUrl || !String(title || '').trim()) throw new Error('Link and title required');
    const existing = store.documents.find(doc => doc.villaId === villaId && doc.driveUrl === driveUrl);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record = { ...normalize('documents', { villaId, title, driveUrl, type: 'Other',
      notes: `Saved reference link by ${clean(userKey, 80)}.`, signed: false }),
      id: newId('documents'), createdAt: now, updatedAt: now };
    store.documents.unshift(record);
    return record;
  });
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, amount) {
  const date = parseDate(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + amount);
  return dateString(date);
}

function addMonths(value, amount) {
  const date = parseDate(value);
  if (!date) return '';
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return dateString(target);
}

function monthsInStay(checkIn, checkOut) {
  const start = parseDate(checkIn);
  const end = parseDate(checkOut);
  if (!start || !end || end <= start) return 1;
  const base = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  return Math.max(1, base + (end.getUTCDate() > start.getUTCDate() ? 1 : 0));
}

function stayLength(checkIn, checkOut) {
  const start = parseDate(checkIn);
  const end = parseDate(checkOut);
  if (!start || !end || end <= start) return '';
  const nights = Math.round((end - start) / 86400000);
  const months = monthsInStay(checkIn, checkOut);
  return nights >= 28 ? `${months} month${months === 1 ? '' : 's'} · ${nights} nights` : `${nights} night${nights === 1 ? '' : 's'}`;
}

/** Throws 409 if the requested stay overlaps an existing non-cancelled stay at the same villa. */
function assertNoOverlap(input, store) {
  const villaId = clean(input.villaId, 80);
  const selfId = clean(input.id, 80);
  const checkIn = clean(input.checkIn, 20);
  const checkOut = clean(input.checkOut, 20);
  if (!villaId || !checkIn || !checkOut) return;
  const clash = store.tenancies.find(t =>
    t.villaId === villaId && t.id !== selfId &&
    !['Cancelled', 'Enquiry', 'Checked-out'].includes(t.bookingStatus) &&
    t.checkIn && t.checkOut &&
    checkIn < t.checkOut && t.checkIn < checkOut);
  if (clash) {
    const err = new Error(`Date conflict: ${clash.guestName || clash.code} is already booked at this villa ${clash.checkIn} → ${clash.checkOut}. Adjust the dates or cancel the other stay first.`);
    err.statusCode = 409;
    throw err;
  }
}

async function createTenancyBundle(input) {
  return mutate(store => {
  const isNew = !clean(input.id, 80);
  const current = store.tenancies.find(t => t.id === input.id) || {};
  assertNoOverlap({ ...current, ...input }, store);
  const tenancy = saveRecord(store, 'tenancies', input);
  const firstDueDate = clean(input.firstDueDate, 20) || tenancy.checkIn;
  const frequency = tenancy.paymentFrequency || 'Monthly';
  const months = monthsInStay(tenancy.checkIn, tenancy.checkOut);
  const step = frequency === 'Quarterly' ? 3 : frequency === 'Upfront' ? months : 1;
  const count = frequency === 'Upfront' ? 1 : Math.max(1, Math.ceil(months / step));
  const amountFor = index => tenancy.rentAmount * Math.min(step, months - index * step);

  const shouldGenerateSchedule = (isNew && input.generateSchedule !== false && input.generateSchedule !== 'false') || input.generateSchedule === true || input.generateSchedule === 'true';
  const previous = store.installments.filter(item => item.tenancyId === tenancy.id);
  if (shouldGenerateSchedule && previous.some(p => p.status !== 'Paid' && store.transactions.some(t => t.sourceId === p.id))) conflict('This schedule contains linked settled history. Reconcile the paid records before regeneration.');
  if (shouldGenerateSchedule) for (const paid of previous.filter(p => p.status === 'Paid')) {
    const index = paid.installmentNumber - 1;
    if (!Number.isInteger(index) || index < 0 || index >= count || paid.amount !== amountFor(index) || paid.dueDate !== addMonths(firstDueDate, index * step) || paid.currency !== (tenancy.currency || 'IDR') || paid.villaId !== tenancy.villaId || previous.filter(p => p.installmentNumber === paid.installmentNumber).length !== 1) conflict('This settled schedule cannot be regenerated safely. Keep it and edit individual unpaid obligations instead.');
  }
  if (shouldGenerateSchedule && tenancy.rentAmount > 0 && firstDueDate) {
    const retained = new Set();
    for (let index = 0; index < count; index += 1) {
      const dueDate = addMonths(firstDueDate, index * step);
      const due = parseDate(dueDate);
      const period = due ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(due) : '';
      const old = previous.find(p => p.installmentNumber === index + 1);
      if (old?.status === 'Paid') { retained.add(old.id); continue; }
      const installment = saveRecord(store, 'installments', {
        ...(old ? { id: old.id } : {}),
        code: `${tenancy.code || tenancy.id.slice(0, 12)}-${String(index + 1).padStart(2, '0')}`,
        tenancyId: tenancy.id,
        villaId: tenancy.villaId,
        installmentNumber: index + 1,
        installmentTotal: count,
        period,
        amount: amountFor(index),
        currency: tenancy.currency || 'IDR',
        dueDate,
        followUpDate: addDays(dueDate, -7),
        gracePeriodDays: Number(input.gracePeriodDays || 3),
        status: 'Scheduled',
        ownerPayoutStatus: 'Pending',
      });
      retained.add(installment.id);
    }
    store.installments = store.installments.filter(p => p.tenancyId !== tenancy.id || retained.has(p.id));
  }

  if (Number(input.depositAmount) > 0 && !store.deposits.some(d => d.tenancyId === tenancy.id)) {
    saveRecord(store, 'deposits', {
      code: `DEP-${tenancy.code || tenancy.id.slice(0, 12)}`,
      tenancyId: tenancy.id,
      villaId: tenancy.villaId,
      amount: input.depositAmount,
      currency: tenancy.currency || 'IDR',
      collectedDate: input.depositCollectedDate,
      heldIn: input.depositHeldIn || 'Owner account',
      purpose: 'Security deposit (refundable)',
      status: input.depositCollectedDate ? 'Held' : 'Awaiting collection',
      refundDueDate: addDays(tenancy.checkOut, Number(input.refundWindowDays ?? 14)),
      deductions: 0,
    });
  }

  if (tenancy.contractUrl && !store.documents.some(d => d.tenancyId === tenancy.id && d.driveUrl === tenancy.contractUrl)) {
    saveRecord(store, 'documents', {
      title: `Tenancy agreement · ${tenancy.guestName || tenancy.code}`,
      type: 'Tenancy agreement',
      villaId: tenancy.villaId,
      tenancyId: tenancy.id,
      driveUrl: tenancy.contractUrl,
      signed: Boolean(input.contractSigned),
      signedDate: input.contractSignedDate,
    });
  }
  return tenancy;
  });
}

function enrich(store) {
  const now = new Date().toISOString().slice(0, 10);
  return {
    ...store,
    tenancies: store.tenancies.map(item => ({ ...item, lengthOfStay: stayLength(item.checkIn, item.checkOut) })),
    installments: store.installments.map(item => {
      let status = item.status || 'Scheduled';
      if (!['Paid', 'Late'].includes(status) && item.dueDate) {
        const graceEnd = addDays(item.dueDate, Number(item.gracePeriodDays || 0));
        const escalationDate = addDays(item.dueDate, 7);
        if (now >= escalationDate) status = 'Late';
        else if (now > graceEnd) status = 'Overdue';
        else if (now >= item.dueDate) status = 'Due';
        else if (item.followUpDate && now >= item.followUpDate) status = 'Reminded';
      }
      return { ...item, status };
    }),
    deposits: store.deposits.map(depositBalance),
  };
}

async function getAll() {
  return enrich(await read());
}

/** Compatibility entry point; always use the persisted source, never a stale caller copy. */
async function recordPaymentIncome(installment) {
  if (!installment?.id) return null;
  return mutate(store => {
    const source = store.installments.find(p => p.id === installment.id);
    if (!source || source.status !== 'Paid') return null;
    const existed = store.transactions.some(t => t.sourceId === source.id);
    const transaction = syncPaidLedger(store, 'installments', source);
    return existed ? null : transaction;
  });
}

async function markPaid(collection, id, input) {
  return mutate(store => {
    const existing = store[collection].find(item => item.id === clean(id, 80));
    if (!existing) return null;
    const prefix = collection === 'invoices' ? 'invoice' : 'payable';
    const hadTransaction = store.transactions.some(t => t.sourceId === `${prefix}:${existing.id}`);
    const record = saveRecord(store, collection, { ...input, id: existing.id, status: 'Paid',
      paidDate: clean(input.paidDate, 20) || existing.paidDate || new Date().toISOString().slice(0, 10) });
    const transaction = store.transactions.find(t => t.sourceId === `${prefix}:${record.id}`);
    return collection === 'invoices' ? { invoice: record, transaction, createdIncome: !hadTransaction }
      : { payable: record, transaction, createdExpense: !hadTransaction };
  });
}

async function markInvoicePaid(id, input = {}) { return markPaid('invoices', id, input); }
async function markPayablePaid(id, input = {}) { return markPaid('payables', id, input); }

async function getActionSummary() {
  const store = await getAll();
  const today = new Date().toISOString().slice(0, 10);
  const villas = Object.fromEntries(store.villas.map(item => [item.id, item]));
  const tenancies = Object.fromEntries(store.tenancies.map(item => [item.id, item]));
  const paymentActions = store.installments
    .filter(item => item.status !== 'Paid' && item.followUpDate && item.followUpDate <= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 8);
  const refundActions = store.deposits
    .filter(item => item.refundableAmount > 0 && item.refundDueDate && addDays(item.refundDueDate, -2) <= today)
    .sort((a, b) => a.refundDueDate.localeCompare(b.refundDueDate))
    .slice(0, 5);
  const documentActions = store.documents
    .filter(item => item.expiryDate && item.expiryDate >= today && item.expiryDate <= addDays(today, 30))
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
    .slice(0, 5);
  const invoiceActions = store.invoices
    .filter(item => !['Paid', 'Void'].includes(item.status) && item.dueDate && item.dueDate <= addDays(today, 7))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5);
  const payableActions = store.payables
    .filter(item => !['Paid', 'Void'].includes(item.status) && item.dueDate && item.dueDate <= addDays(today, 7))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5);
  const taskActions = store.villaTasks
    .filter(item => item.status !== 'Done' && item.dueDate && item.dueDate <= today)
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
    .slice(0, 6);
  if (!paymentActions.length && !refundActions.length && !documentActions.length && !invoiceActions.length && !payableActions.length && !taskActions.length) return '';
  const lines = ['TVM operations follow-ups:'];
  for (const item of paymentActions) {
    const villa = villas[item.villaId]?.name || 'Villa';
    const guest = tenancies[item.tenancyId]?.guestName || 'guest';
    lines.push(`• ${villa} / ${guest}: ${item.status}, due ${item.dueDate}`);
  }
  for (const item of refundActions) {
    const villa = villas[item.villaId]?.name || 'Villa';
    const guest = tenancies[item.tenancyId]?.guestName || 'guest';
    lines.push(`• Deposit refund: ${villa} / ${guest}, due ${item.refundDueDate}`);
  }
  for (const item of documentActions) {
    const villa = villas[item.villaId]?.name || 'General';
    lines.push(`• Document deadline: ${item.title} / ${villa}, ${item.expiryDate}`);
  }
  for (const item of invoiceActions) {
    lines.push(`• Invoice: ${item.code || item.clientName || 'Client'}, ${item.currency || 'IDR'} ${item.amount || 0}, due ${item.dueDate}`);
  }
  for (const item of payableActions) {
    lines.push(`• Payable: ${item.code || item.vendorName || item.category || 'Expense'}, ${item.currency || 'IDR'} ${item.amount || 0}, due ${item.dueDate}`);
  }
  for (const item of taskActions) {
    const villa = villas[item.villaId]?.name || 'Villa';
    lines.push(`• ${item.category || 'Task'}: ${villa} — ${item.title}${item.assignee ? ` (${item.assignee})` : ''}, due ${item.dueDate}`);
  }
  return lines.join('\n');
}

async function remove(collection, id) {
  if (!COLLECTIONS.includes(collection)) throw new Error('Unknown record type');
  return mutate(store => {
    const index = store[collection].findIndex(item => item.id === id);
    if (index < 0) return null;
    const record = store[collection][index];
    if (collection === 'transactions' && record.sourceId) conflict('This finance entry has a linked payment source. Preserve its history and correct the source instead.');
    if (['installments', 'invoices', 'payables'].includes(collection) && (record.status === 'Paid' || store.transactions.some(t => [id, `invoice:${id}`, `payable:${id}`].includes(t.sourceId)))) conflict('Cannot delete a paid record with financial history.');
    if (collection === 'deposits' && record.status !== 'Awaiting collection') conflict('Cannot delete a collected deposit and its refund history.');
    if (collection === 'tenancies' && ['installments', 'deposits', 'documents', 'transactions'].some(c => store[c].some(r => r.tenancyId === id))) conflict('This stay has linked history. Cancel the stay instead of deleting it; review its unpaid obligations separately.');
    // Protect villas with linked history — orphaned stays/finance would be unreachable.
    if (collection === 'villas') {
      const linked = ['tenancies', 'installments', 'deposits', 'documents', 'transactions', 'invoices', 'payables', 'villaTasks']
        .filter(coll => store[coll].some(item => item.villaId === id));
      if (linked.length) {
        const err = new Error(`This villa still has linked ${linked.join(', ')}. Delete those first, or set the villa to Off-market instead.`);
        err.statusCode = 409;
        throw err;
      }
    }
    const [removed] = store[collection].splice(index, 1);
    // Cascade: deleting a tenancy also removes its installments and deposits
    if (collection === 'tenancies') {
      store.installments = store.installments.filter(item => item.tenancyId !== id);
      store.deposits = store.deposits.filter(item => item.tenancyId !== id);
    }
    return removed;
  });
}

module.exports = { init, getAll, getActionSummary, upsert, saveReferenceLink, remove, recordPaymentIncome, markInvoicePaid, markPayablePaid, createTenancyBundle, stayLength, addDays, addMonths };
