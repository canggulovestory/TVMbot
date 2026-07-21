/**
 * Detailed villa, tenancy, installment, deposit, and document records.
 * Stored on the private VPS data volume and exposed only through authenticated APIs.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const COLLECTIONS = ['villas', 'tenancies', 'installments', 'deposits', 'documents', 'transactions', 'villaTasks'];
const PREFIX = { villas: 'VIL', tenancies: 'TEN', installments: 'PAY', deposits: 'DEP', documents: 'DOC', transactions: 'TRX', villaTasks: 'VTK' };
const FIELDS = {
  villas: ['name', 'code', 'status', 'location', 'mapUrl', 'bedrooms', 'bathrooms', 'maxGuests', 'pool', 'facilities', 'ownerName', 'ownerPhone', 'ownerEmail', 'monthlyRate', 'yearlyRate', 'currency', 'photosFolderUrl', 'listingUrl', 'ownerAgreementUrl', 'marketingNotes', 'photoUrl'],
  tenancies: ['code', 'villaId', 'guestName', 'guestPhone', 'guestEmail', 'nationality', 'idDocumentUrl', 'bookingStatus', 'checkIn', 'checkOut', 'rentalTerm', 'guestCount', 'rentAmount', 'currency', 'paymentFrequency', 'source', 'agencyCommissionPercent', 'contractUrl', 'notes'],
  installments: ['code', 'tenancyId', 'villaId', 'installmentNumber', 'installmentTotal', 'period', 'amount', 'currency', 'dueDate', 'followUpDate', 'gracePeriodDays', 'status', 'paidDate', 'paymentMethod', 'proofUrl', 'lateFee', 'ownerPayoutStatus'],
  deposits: ['code', 'tenancyId', 'villaId', 'amount', 'currency', 'collectedDate', 'heldIn', 'status', 'refundDueDate', 'deductions', 'deductionNotes', 'refundDate', 'refundProofUrl', 'inventoryUrl'],
  documents: ['title', 'type', 'villaId', 'tenancyId', 'driveUrl', 'signed', 'signedDate', 'expiryDate', 'notes'],
  transactions: ['code', 'villaId', 'tenancyId', 'type', 'category', 'description', 'amount', 'currency', 'date', 'proofUrl', 'notes', 'sourceId'],
  villaTasks: ['title', 'villaId', 'category', 'priority', 'status', 'dueDate', 'assignee', 'cost', 'notes'],
};
const NUMBER_FIELDS = new Set(['bedrooms', 'bathrooms', 'maxGuests', 'monthlyRate', 'yearlyRate', 'guestCount', 'rentAmount', 'agencyCommissionPercent', 'installmentNumber', 'installmentTotal', 'amount', 'gracePeriodDays', 'lateFee', 'deductions', 'cost']);
const BOOLEAN_FIELDS = new Set(['pool', 'signed']);
let filePath;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { version: 1, villas: [], tenancies: [], installments: [], deposits: [], documents: [], transactions: [], villaTasks: [] };
}

function init(dataDir) {
  filePath = path.join(dataDir, 'villa-operations.json');
}

function clean(value, max = 2000) {
  return String(value ?? '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
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

function normalize(collection, input, existing = {}) {
  if (!COLLECTIONS.includes(collection)) throw new Error('Unknown record type');
  const next = { ...existing };
  for (const field of FIELDS[collection]) {
    if (!(field in input)) continue;
    if (BOOLEAN_FIELDS.has(field)) next[field] = input[field] === true || input[field] === 'true' || input[field] === 'on';
    else if (NUMBER_FIELDS.has(field)) next[field] = Number.isFinite(Number(input[field])) ? Number(input[field]) : 0;
    else if (/Url$/.test(field)) next[field] = normalizeUrl(input[field]);
    else next[field] = clean(input[field], field === 'notes' || field === 'marketingNotes' || field === 'deductionNotes' ? 4000 : 500);
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

async function upsert(collection, input) {
  return mutate(store => {
    const now = new Date().toISOString();
    const id = clean(input.id, 80);
    const index = id ? store[collection].findIndex(item => item.id === id) : -1;
    const existing = index >= 0 ? store[collection][index] : {};
    const record = normalize(collection, input, existing);
    record.id = existing.id || newId(collection);
    record.createdAt = existing.createdAt || now;
    record.updatedAt = now;
    if (index >= 0) store[collection][index] = record;
    else store[collection].unshift(record);
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
async function assertNoOverlap(input) {
  const villaId = clean(input.villaId, 80);
  const selfId = clean(input.id, 80);
  const checkIn = clean(input.checkIn, 20);
  const checkOut = clean(input.checkOut, 20);
  if (!villaId || !checkIn || !checkOut) return;
  const store = await read();
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
  const isNew = !clean(input.id, 80);
  await assertNoOverlap(input);
  const tenancy = await upsert('tenancies', input);
  const firstDueDate = clean(input.firstDueDate, 20) || tenancy.checkIn;
  const frequency = tenancy.paymentFrequency || 'Monthly';
  const months = monthsInStay(tenancy.checkIn, tenancy.checkOut);
  const step = frequency === 'Quarterly' ? 3 : frequency === 'Upfront' ? months : 1;
  const count = frequency === 'Upfront' ? 1 : Math.max(1, Math.ceil(months / step));
  const amount = frequency === 'Upfront' ? tenancy.rentAmount * months : frequency === 'Quarterly' ? tenancy.rentAmount * 3 : tenancy.rentAmount;

  const shouldGenerateSchedule = (isNew && input.generateSchedule !== false && input.generateSchedule !== 'false') || input.generateSchedule === true || input.generateSchedule === 'true';
  if (shouldGenerateSchedule && tenancy.rentAmount > 0 && firstDueDate) {
    for (let index = 0; index < count; index += 1) {
      const dueDate = addMonths(firstDueDate, index * step);
      const due = parseDate(dueDate);
      const period = due ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(due) : '';
      await upsert('installments', {
        code: `${tenancy.code || tenancy.id.slice(0, 12)}-${String(index + 1).padStart(2, '0')}`,
        tenancyId: tenancy.id,
        villaId: tenancy.villaId,
        installmentNumber: index + 1,
        installmentTotal: count,
        period,
        amount,
        currency: tenancy.currency || 'IDR',
        dueDate,
        followUpDate: addDays(dueDate, -7),
        gracePeriodDays: Number(input.gracePeriodDays || 3),
        status: 'Scheduled',
        ownerPayoutStatus: 'Pending',
      });
    }
  }

  if (isNew && Number(input.depositAmount) > 0) {
    await upsert('deposits', {
      code: `DEP-${tenancy.code || tenancy.id.slice(0, 12)}`,
      tenancyId: tenancy.id,
      villaId: tenancy.villaId,
      amount: input.depositAmount,
      currency: tenancy.currency || 'IDR',
      collectedDate: input.depositCollectedDate,
      heldIn: input.depositHeldIn || 'Owner account',
      status: input.depositCollectedDate ? 'Held' : 'Awaiting collection',
      refundDueDate: addDays(tenancy.checkOut, Number(input.refundWindowDays || 14)),
      deductions: 0,
    });
  }

  if (isNew && tenancy.contractUrl) {
    await upsert('documents', {
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
    deposits: store.deposits.map(item => ({ ...item, refundableAmount: Math.max(0, Number(item.amount || 0) - Number(item.deductions || 0)) })),
  };
}

async function getAll() {
  return enrich(await read());
}

/** Auto-create an income transaction when an installment is marked Paid (deduped by sourceId). */
async function recordPaymentIncome(installment) {
  if (!installment || installment.status !== 'Paid') return null;
  return mutate(store => {
    if (store.transactions.some(t => t.sourceId === installment.id)) return null;
    const now = new Date().toISOString();
    const txn = {
      id: `TRX-${crypto.randomUUID()}`,
      code: `INC-${installment.code || installment.id.slice(0, 12)}`,
      villaId: installment.villaId || '', tenancyId: installment.tenancyId || '',
      type: 'Income', category: 'Rent',
      description: `Rent received — ${installment.period || installment.code || 'installment'}`,
      amount: Number(installment.amount || 0), currency: installment.currency || 'IDR',
      date: installment.paidDate || now.slice(0, 10),
      proofUrl: installment.proofUrl || '', notes: '', sourceId: installment.id,
      createdAt: now, updatedAt: now,
    };
    store.transactions.unshift(txn);
    return txn;
  });
}

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
    .filter(item => !['Refunded', 'Forfeited'].includes(item.status) && item.refundDueDate && addDays(item.refundDueDate, -2) <= today)
    .sort((a, b) => a.refundDueDate.localeCompare(b.refundDueDate))
    .slice(0, 5);
  const documentActions = store.documents
    .filter(item => item.expiryDate && item.expiryDate >= today && item.expiryDate <= addDays(today, 30))
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
    .slice(0, 5);
  const taskActions = store.villaTasks
    .filter(item => item.status !== 'Done' && item.dueDate && item.dueDate <= today)
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
    .slice(0, 6);
  if (!paymentActions.length && !refundActions.length && !documentActions.length && !taskActions.length) return '';
  const lines = ['TVM villa follow-ups:'];
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
    lines.push(`• Contract renewal: ${item.title} / ${villa}, ${item.expiryDate}`);
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
    // Protect villas with linked history — orphaned stays/finance would be unreachable.
    if (collection === 'villas') {
      const linked = ['tenancies', 'installments', 'deposits', 'documents', 'transactions', 'villaTasks']
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

module.exports = { init, getAll, getActionSummary, upsert, remove, recordPaymentIncome, createTenancyBundle, stayLength, addDays, addMonths };
