/**
 * Narrow TVM operations bridge for the Hermes project skill.
 *
 * Usage:
 *   node agent-tools.js <action> <user> <<'TVM_JSON'
 *   {"name":"Review villa listing","priority":"High"}
 *   TVM_JSON
 *
 * Output is always JSON so the agent can verify success before confirming it.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const notion = require('./notion');
const assistant = require('./assistant');
const villaData = require('./villa-data');
const googleWorkspace = require('./google-workspace');
const zuzuIntake = require('./zuzu-intake');

const ALLOWED_USERS = new Set(['afni', 'syifa']);
const ALLOWED_PRIORITIES = new Set(['High', 'Mid', 'Low']);
const ALLOWED_RECURRENCES = /^(daily|weekly:[1-7]|monthly:([1-9]|[12]\d|3[01]))$/;
const NOTION_ACTIONS = new Set(['create_task', 'complete_task', 'list_tasks', 'mark_paid']);
const RECORD_COLLECTIONS = new Set(['villas', 'tenancies', 'installments', 'deposits', 'documents', 'transactions', 'invoices', 'payables', 'villaTasks']);

function requireText(value, name, max = 500) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text.slice(0, max);
}

function parseInput(raw) {
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Input must be a JSON object');
  }
  return value;
}

function parseWitaDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('datetime must be YYYY-MM-DD HH:MM in WITA');
  return assistant.witaToEpoch(+match[1], +match[2], +match[3], +match[4], +match[5]);
}

function leadStage(value) {
  return ({ new: 'New', replied: 'Contacted', won: 'Won', lost: 'Lost' }[String(value || '').toLowerCase()] || value || 'New');
}

async function readLeads() {
  const file = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'enquiries.json');
  try {
    const leads = JSON.parse(await require('fs/promises').readFile(file, 'utf8'));
    return Array.isArray(leads) ? leads : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function currencyTotals(records) {
  return records.reduce((out, item) => {
    const currency = item.currency || 'IDR';
    out[currency] = (out[currency] || 0) + Number(item.amount || 0);
    return out;
  }, {});
}

function safeRecordInput(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('record must be an object');
  return Object.fromEntries(Object.entries(value).slice(0, 40));
}

function includesQuery(record, query, extra = '') {
  if (!query) return true;
  return `${Object.values(record).join(' ')} ${extra}`.toLowerCase().includes(query);
}

function compactRecord(record, fields) {
  return Object.fromEntries(fields.map(field => [field, record[field] ?? '']));
}

/**
 * Private, bounded operation lookup. It gives Hermes the real structured data
 * needed for questions such as "when does the contract expire?" and
 * "what deposit does guest B have?" without exposing a general file shell.
 */
async function searchOperations(input) {
  const data = await villaData.getAll();
  const query = String(input.search || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  const villas = Object.fromEntries(data.villas.map(item => [item.id, item]));
  const stays = Object.fromEntries(data.tenancies.map(item => [item.id, item]));
  const villaName = id => villas[id]?.name || '';
  const guestName = id => stays[id]?.guestName || '';
  const match = (record, extra = '') => includesQuery(record, query, extra);

  return {
    asOf: new Date().toISOString().slice(0, 10),
    villas: data.villas.filter(item => match(item)).slice(0, limit).map(item => compactRecord(item, ['id', 'name', 'code', 'status', 'location', 'ownerName', 'monthlyRate', 'yearlyRate', 'currency', 'listingUrl', 'ownerAgreementUrl'])),
    stays: data.tenancies.filter(item => match(item, villaName(item.villaId))).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'code', 'villaId', 'guestName', 'guestPhone', 'guestEmail', 'bookingStatus', 'checkIn', 'checkOut', 'rentalTerm', 'rentAmount', 'currency', 'paymentFrequency', 'contractUrl']), villaName: villaName(item.villaId) })),
    installments: data.installments.filter(item => match(item, `${villaName(item.villaId)} ${guestName(item.tenancyId)}`)).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'code', 'tenancyId', 'villaId', 'period', 'amount', 'currency', 'dueDate', 'followUpDate', 'status', 'paidDate', 'proofUrl']), villaName: villaName(item.villaId), guestName: guestName(item.tenancyId) })),
    deposits: data.deposits.filter(item => match(item, `${villaName(item.villaId)} ${guestName(item.tenancyId)}`)).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'code', 'tenancyId', 'villaId', 'amount', 'currency', 'collectedDate', 'heldIn', 'status', 'refundDueDate', 'deductions', 'refundDate', 'refundProofUrl', 'inventoryUrl']), villaName: villaName(item.villaId), guestName: guestName(item.tenancyId) })),
    documents: data.documents.filter(item => match(item, `${villaName(item.villaId)} ${guestName(item.tenancyId)}`)).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'title', 'type', 'villaId', 'tenancyId', 'driveUrl', 'signed', 'signedDate', 'expiryDate', 'notes']), villaName: villaName(item.villaId), guestName: guestName(item.tenancyId) })),
    transactions: data.transactions.filter(item => match(item, villaName(item.villaId))).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'code', 'villaId', 'type', 'category', 'description', 'amount', 'currency', 'date', 'proofUrl', 'notes']), villaName: villaName(item.villaId) })),
    invoices: data.invoices.filter(item => match(item, villaName(item.villaId))).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'code', 'clientName', 'clientEmail', 'villaId', 'category', 'description', 'amount', 'currency', 'issueDate', 'dueDate', 'status', 'paidDate', 'proofUrl']), villaName: villaName(item.villaId) })),
    payables: (data.payables || []).filter(item => match(item, villaName(item.villaId))).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'code', 'vendorName', 'villaId', 'category', 'description', 'amount', 'currency', 'issueDate', 'dueDate', 'status', 'paidDate', 'proofUrl']), villaName: villaName(item.villaId) })),
    tasks: data.villaTasks.filter(item => match(item, villaName(item.villaId))).slice(0, limit).map(item => ({ ...compactRecord(item, ['id', 'title', 'villaId', 'category', 'priority', 'status', 'dueDate', 'assignee', 'cost', 'notes']), villaName: villaName(item.villaId) })),
  };
}

async function saveRecord(input) {
  const collection = String(input.collection || '').trim();
  if (!RECORD_COLLECTIONS.has(collection)) throw new Error('Unsupported record collection');
  const recordInput = safeRecordInput(input.record);
  let record = collection === 'tenancies'
    ? await villaData.createTenancyBundle(recordInput)
    : await villaData.upsert(collection, recordInput);
  if (collection === 'installments' && record.status === 'Paid') await villaData.recordPaymentIncome(record);
  if (collection === 'invoices' && record.status === 'Paid') record = (await villaData.markInvoicePaid(record.id, record)).invoice;
  if (collection === 'payables' && record.status === 'Paid') record = (await villaData.markPayablePaid(record.id, record)).payable;
  return { collection, record };
}

function leadPreview(lead, { includePrivate = false } = {}) {
  const preview = {
    id: lead.id, name: lead.name || '', type: lead.leadType || lead.business || 'General',
    stage: leadStage(lead.status), source: lead.utmSource || lead.source || '',
    nextFollowUp: lead.nextFollowUp || '', budget: lead.budget || '',
    createdAt: lead.createdAt || '', assignee: lead.assignee || '',
  };
  if (includePrivate) Object.assign(preview, {
    email: lead.email || '', phone: lead.phone || '', message: lead.message || '',
    internalNotes: lead.internalNotes || '', rentalTerm: lead.rentalTerm || '', moveInDate: lead.moveInDate || '',
  });
  return preview;
}

async function businessBrief() {
  const [leads, data] = await Promise.all([readLeads(), villaData.getAll()]);
  const today = new Date().toISOString().slice(0, 10);
  const openLeads = leads.filter(lead => !['Won', 'Lost'].includes(leadStage(lead.status)));
  const dueLeads = openLeads.filter(lead => lead.nextFollowUp && lead.nextFollowUp <= today);
  const invoices = data.invoices || [];
  const receivables = invoices.filter(invoice => !['Paid', 'Void'].includes(invoice.status));
  const dueInvoices = receivables.filter(invoice => invoice.dueDate && invoice.dueDate <= today);
  const month = today.slice(0, 7);
  const income = data.transactions.filter(item => item.type === 'Income' && (item.date || '').startsWith(month));
  const expenses = data.transactions.filter(item => item.type === 'Expense' && (item.date || '').startsWith(month));
  return {
    asOf: today,
    leads: {
      new: leads.filter(lead => leadStage(lead.status) === 'New').length,
      open: openLeads.length,
      followUpsDue: dueLeads.length,
      followUps: dueLeads.slice(0, 10).map(lead => leadPreview(lead)),
    },
    finance: {
      incomeThisMonth: currencyTotals(income), expensesThisMonth: currencyTotals(expenses),
      receivables: currencyTotals(receivables), invoicesOverdue: dueInvoices.length,
      invoicesDue: dueInvoices.slice(0, 10).map(invoice => ({ code: invoice.code || '', clientName: invoice.clientName || '', amount: invoice.amount || 0, currency: invoice.currency || 'IDR', dueDate: invoice.dueDate || '', status: invoice.status || 'Draft' })),
    },
    operations: {
      villasAvailable: data.villas.filter(villa => villa.status === 'Available').length,
      unpaidInstallments: data.installments.filter(item => item.status !== 'Paid').length,
      depositsAwaitingAction: data.deposits.filter(item => !['Refunded', 'Forfeited'].includes(item.status)).length,
    },
  };
}

async function listLeads(input) {
  const today = new Date().toISOString().slice(0, 10);
  const query = String(input.search || '').trim().toLowerCase();
  const stage = String(input.stage || '').trim();
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  const leads = await readLeads();
  return leads.filter(lead => {
    if (stage === 'due' && !(lead.nextFollowUp && lead.nextFollowUp <= today && !['Won', 'Lost'].includes(leadStage(lead.status)))) return false;
    if (stage && stage !== 'due' && leadStage(lead.status).toLowerCase() !== stage.toLowerCase()) return false;
    return !query || `${lead.name} ${lead.business} ${lead.leadType} ${lead.source}`.toLowerCase().includes(query);
  }).slice(0, limit).map(lead => leadPreview(lead));
}

async function leadDetail(input) {
  const search = requireText(input.search, 'search', 160).toLowerCase();
  const leads = await readLeads();
  const lead = leads.find(item => item.id === search || `${item.name} ${item.email} ${item.phone}`.toLowerCase().includes(search));
  return lead ? leadPreview(lead, { includePrivate: true }) : null;
}

async function financeSummary() {
  const data = await villaData.getAll();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const invoices = data.invoices || [];
  const payables = data.payables || [];
  const receivables = invoices.filter(item => !['Paid', 'Void'].includes(item.status));
  const openPayables = payables.filter(item => !['Paid', 'Void'].includes(item.status));
  return {
    asOf: today,
    incomeThisMonth: currencyTotals(data.transactions.filter(item => item.type === 'Income' && (item.date || '').startsWith(month))),
    expensesThisMonth: currencyTotals(data.transactions.filter(item => item.type === 'Expense' && (item.date || '').startsWith(month))),
    receivables: currencyTotals(receivables),
    invoices: invoices.filter(item => item.dueDate && !['Paid', 'Void'].includes(item.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 20).map(item => ({ code: item.code || '', clientName: item.clientName || '', category: item.category || '', amount: item.amount || 0, currency: item.currency || 'IDR', dueDate: item.dueDate || '', status: item.status || 'Draft' })),
    payables: openPayables.filter(item => item.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 20).map(item => ({ code: item.code || '', vendorName: item.vendorName || '', category: item.category || '', amount: item.amount || 0, currency: item.currency || 'IDR', dueDate: item.dueDate || '', status: item.status || 'Scheduled' })),
  };
}

async function gmailInbox() {
  return googleWorkspace.gmailInbox();
}

async function marketingPipeline() {
  const leads = await readLeads();
  const open = leads.filter(lead => !['Won', 'Lost'].includes(leadStage(lead.status)));
  const byStage = leads.reduce((out, lead) => {
    const key = leadStage(lead.status); out[key] = (out[key] || 0) + 1; return out;
  }, {});
  const bySource = leads.reduce((out, lead) => {
    const key = lead.utmSource || lead.source || 'Direct'; out[key] = (out[key] || 0) + 1; return out;
  }, {});
  const total = leads.length || 1;
  return {
    totalLeads: leads.length, openLeads: open.length, won: byStage.Won || 0, lost: byStage.Lost || 0,
    conversionRate: Number((((byStage.Won || 0) / total) * 100).toFixed(1)), byStage, bySource,
    followUpsDue: (await listLeads({ stage: 'due', limit: 20 })).map(lead => leadPreview(lead)),
  };
}

async function documentIntakeDetail(input) {
  return zuzuIntake.get(requireText(input.id, 'id', 100), { includeText: true });
}

async function run(action, userKey, input) {
  switch (action) {
    case 'create_task': {
      const priority = ALLOWED_PRIORITIES.has(input.priority) ? input.priority : 'Mid';
      return notion.createTask({ name: requireText(input.name, 'name', 300), priority });
    }
    case 'complete_task':
      return notion.completeTask(requireText(input.search, 'search', 200));
    case 'list_tasks': {
      let tasks = await notion.getTasks();
      if (input.project) {
        const project = await notion.findProject(requireText(input.project, 'project', 120));
        tasks = project ? tasks.filter(task => task.projectIds.includes(project.id)) : [];
      }
      return tasks.slice(0, 50);
    }
    case 'mark_paid':
      return notion.markPaid(requireText(input.villa, 'villa', 160));
    case 'set_reminder': {
      const recurrence = String(input.recurrence || '');
      if (recurrence && !ALLOWED_RECURRENCES.test(recurrence)) {
        throw new Error('Invalid recurrence');
      }
      return assistant.addReminder({
        userKey,
        text: requireText(input.text, 'text'),
        at: parseWitaDateTime(input.datetime),
        recurrence,
      });
    }
    case 'list_reminders':
      return assistant.listReminders(userKey);
    case 'cancel_reminder':
      return assistant.cancelReminder(userKey, requireText(input.search, 'search', 200));
    case 'remember_fact':
      return assistant.remember(userKey, requireText(input.fact, 'fact', 400), {
        category: String(input.category || 'reference').trim().toLowerCase(),
        tags: Array.isArray(input.tags) ? input.tags : [], source: 'zuzu-confirmed',
      });
    case 'list_memory':
      return assistant.getMemory(userKey);
    case 'search_memory':
      return assistant.searchMemory(userKey, String(input.search || ''), input.limit || 12, { category: input.category });
    case 'forget_fact':
      return assistant.forget(userKey, requireText(input.search, 'search', 200));
    case 'add_ops_schedule': {
      const frequency = requireText(input.frequency, 'frequency', 30);
      if (!ALLOWED_RECURRENCES.test(frequency)) throw new Error('Invalid frequency');
      return assistant.addOpsSchedule({
        villa: requireText(input.villa, 'villa', 120),
        task: requireText(input.task, 'task', 300),
        frequency,
        assignee: String(input.assignee || '').trim().slice(0, 120),
      });
    }
    case 'list_ops':
      return assistant.listOpsSchedules();
    case 'business_brief':
      return businessBrief();
    case 'list_leads':
      return listLeads(input);
    case 'lead_detail':
      return leadDetail(input);
    case 'search_operations':
      return searchOperations(input);
    case 'finance_summary':
      return financeSummary();
    case 'save_record':
      return saveRecord(input);
    case 'gmail_inbox':
      return gmailInbox();
    case 'create_email_draft':
      return googleWorkspace.createEmailDraft({ to: requireText(input.to, 'to', 180), subject: requireText(input.subject, 'subject', 180), body: requireText(input.body, 'body', 12000) });
    case 'calendar_upcoming':
      return googleWorkspace.calendarUpcoming();
    case 'create_calendar_hold':
      return googleWorkspace.createCalendarHold({ title: requireText(input.title, 'title', 180), start: requireText(input.start, 'start', 30), end: requireText(input.end, 'end', 30), description: String(input.description || '').slice(0, 2000) });
    case 'marketing_pipeline':
      return marketingPipeline();
    case 'list_document_intake':
      return zuzuIntake.list(input.limit || 30);
    case 'document_intake_detail':
      return documentIntakeDetail(input);
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

async function main() {
  const [action, userKey] = process.argv.slice(2);
  if (!action) throw new Error('Action is required');
  if (!ALLOWED_USERS.has(userKey)) throw new Error('Unknown TVM user');

  assistant.init(process.env.DATA_DIR || path.join(__dirname, 'data'));
  villaData.init(process.env.DATA_DIR || path.join(__dirname, 'data'));
  googleWorkspace.init(process.env.DATA_DIR || path.join(__dirname, 'data'));
  zuzuIntake.init(process.env.DATA_DIR || path.join(__dirname, 'data'));
  // Briefings and CRM/finance lookups are fully local and must remain available
  // even if Notion is temporarily unavailable or not configured.
  if (NOTION_ACTIONS.has(action)) notion.init();
  const result = await run(action, userKey, parseInput(fs.readFileSync(0, 'utf8').trim()));
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
