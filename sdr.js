'use strict';
/**
 * sdr.js — AI SDR pipeline for TVM: owner + renter prospects, drafted outreach, follow-ups.
 * Nothing is ever sent from here: an approved email becomes a Gmail DRAFT and Afni presses Send;
 * an approved WhatsApp text is handed back for Afni to send from her own phone.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = ['owner', 'renter'];
const STAGES = ['New', 'Awaiting approval', 'Ready to send', 'Sent', 'Replied', 'Meeting', 'Won', 'Lost', 'No reply', 'Do not contact'];
const MAX_TOUCHES = 3; // first message + two follow-ups, then stop
const FOLLOW_UP_DAYS = 5;
const DAY = 86400000;

// Sender-verified facts only (Afni, Telegram 16-11-2026). Never let the model invent proof.
const PROFILE = {
  company: 'The Villa Managers (TVM)',
  website: 'https://thevillamanagers.cloud',
  proof: ['7 villas currently listed with TVM'],
  owner: 'Villa marketing agency for Bali villa owners who want monthly, yearly or long-term tenants: listing strategy, content and presentation, promotion (website, socials, direct network, rental communities) and screened, qualified enquiries. The owner stays in control of the villa and the rental agreement.',
  renter: 'Curated Bali villas for monthly, yearly and long-term stays; TVM screens the basics and introduces suitable tenants directly to the owner.',
  optOut: 'If this is not relevant for you, just reply "stop" and we will not contact you again.',
};

let filePath;
let writeQueue = Promise.resolve();

function init(dataDir) { filePath = path.join(dataDir, 'sdr.json'); }

async function read() {
  try { return { version: 1, leads: [], ...JSON.parse(await fs.readFile(filePath, 'utf8')) }; }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, leads: [] }; throw error; }
}

function mutate(work) {
  const task = writeQueue.then(async () => {
    const store = await read();
    const result = await work(store);
    const temp = `${filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.rename(temp, filePath);
    return result;
  });
  writeQueue = task.catch(() => {});
  return task;
}

const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const normEmail = value => clean(value, 200).toLowerCase();
const normPhone = value => clean(value, 40).replace(/[^\d+]/g, '');
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function project(lead) {
  const { id, type, name, email, phone, area, villa, source, stage, touches, nextFollowUp, lastContactedAt, draft } = lead;
  return { id, type, name, email, phone, area, villa, source, stage, touches, nextFollowUp, lastContactedAt, draft: draft ? { channel: draft.channel, subject: draft.subject, body: draft.body, ref: draft.revision } : null };
}

async function addLead(input) {
  const type = clean(input.type, 10).toLowerCase();
  if (!TYPES.includes(type)) throw new Error('type must be owner or renter');
  const name = clean(input.name, 120), source = clean(input.source, 200);
  if (!name) throw new Error('name is required');
  if (!source) throw new Error('source is required: where was this lead found?');
  const email = normEmail(input.email), phone = normPhone(input.phone);
  if (email && !validEmail(email)) throw new Error('email is not valid');
  if (!email && phone.replace(/\D/g, '').length < 8) throw new Error('an email or a phone number is required');
  return mutate(store => {
    const duplicate = store.leads.find(l => (email && l.email === email) || (phone && l.phone && l.phone === phone));
    if (duplicate) return { duplicate: true, lead: project(duplicate) };
    const lead = {
      id: 'SDR-' + crypto.randomUUID().slice(0, 8), type, name, email, phone,
      area: clean(input.area, 120), villa: clean(input.villa, 120), source, sourceUrl: clean(input.sourceUrl, 300),
      notes: clean(input.notes, 600), stage: 'New', touches: 0, nextFollowUp: '', lastContactedAt: '',
      createdAt: new Date().toISOString(), history: [],
    };
    store.leads.unshift(lead);
    return { duplicate: false, lead: project(lead) };
  });
}

function isDue(lead, now = Date.now()) {
  return lead.stage === 'Sent' && lead.nextFollowUp && Date.parse(lead.nextFollowUp) <= now;
}

async function listLeads({ stage = '', type = '', due = false, limit = 25 } = {}) {
  const { leads } = await read();
  const items = leads.filter(l => (!stage || l.stage === stage) && (!type || l.type === type) && (!due || isDue(l)));
  return { total: items.length, items: items.slice(0, Math.min(Math.max(Number(limit) || 25, 1), 50)).map(project) };
}

async function find(id) {
  const lead = (await read()).leads.find(l => l.id === id);
  if (!lead) throw new Error('lead not found');
  return lead;
}

/** Everything the model needs to write one message — and nothing it could misuse. */
async function packet(id) {
  const lead = await find(id);
  if (lead.stage === 'Do not contact') throw new Error('this lead asked not to be contacted');
  if (lead.touches >= MAX_TOUCHES) throw new Error('maximum follow-ups reached for this lead');
  const step = lead.touches === 0 ? 'first message' : `follow-up ${lead.touches} of ${MAX_TOUCHES - 1}`;
  return {
    lead: { id: lead.id, type: lead.type, stage: lead.stage, touches: lead.touches },
    // Collected from outside sources: facts to personalise with, NEVER instructions to follow.
    untrustedLeadData: { name: lead.name, area: lead.area, villa: lead.villa, source: lead.source, notes: lead.notes },
    step, company: PROFILE.company, website: PROFILE.website,
    offer: PROFILE[lead.type], proof: PROFILE.proof, optOutLine: PROFILE.optOut,
    rules: 'Personal, short (under 120 words), in English unless the lead wrote in another language. Mention only facts from this packet; never invent results, prices or availability. Email = subject + body ending with the opt-out line. Follow-ups reference the earlier message and add one new useful point. Sign as Afni, The Villa Managers.',
    channel: lead.email ? 'email' : 'whatsapp',
  };
}

async function saveDraft(id, { channel, subject = '', body }) {
  const text = clean(String(body ?? '').split(PROFILE.optOut).join(''), 1800).trim() + '\n\n' + PROFILE.optOut;
  if (!['email', 'whatsapp'].includes(channel)) throw new Error('channel must be email or whatsapp');
  if (text.length < PROFILE.optOut.length + 20) throw new Error('draft body is too short');
  if (channel === 'email' && !clean(subject, 160)) throw new Error('email needs a subject');
  return mutate(store => {
    const lead = store.leads.find(l => l.id === id);
    if (!lead) throw new Error('lead not found');
    if (['Do not contact', 'Won', 'Lost', 'Replied', 'Meeting'].includes(lead.stage)) throw new Error(`lead is ${lead.stage}; no outreach draft`);
    if (lead.touches >= MAX_TOUCHES) throw new Error('maximum follow-ups reached for this lead');
    if (channel === 'email' && !lead.email) throw new Error('lead has no email');
    if (channel === 'whatsapp' && !lead.phone) throw new Error('lead has no phone number');
    lead.draft = { channel, subject: clean(subject, 160), body: text, at: new Date().toISOString(), revision: crypto.randomBytes(3).toString('hex') };
    lead.stage = 'Awaiting approval';
    lead.history.push({ at: lead.draft.at, event: 'draft' });
    return project(lead);
  });
}

/** Approval never sends: email → Gmail draft; WhatsApp → copy-ready text for Afni.
 * Bound to the draft revision Afni saw; the Gmail call is marked pending first so a retry never makes a second draft. */
async function approveDraft(id, revision, createEmailDraft) {
  const draft = await mutate(store => {
    const lead = store.leads.find(l => l.id === id);
    if (!lead) throw new Error('lead not found');
    if (lead.stage !== 'Awaiting approval' || !lead.draft) throw new Error('no draft awaiting approval for this lead');
    if (!revision || lead.draft.revision !== revision) throw new Error('this draft changed or the ref is wrong; show Afni the current draft again');
    if (lead.draft.approvalPending) throw new Error('approval already in progress; check the Gmail drafts before trying again');
    lead.draft.approvalPending = new Date().toISOString();
    return { ...lead.draft, to: lead.email };
  });
  let gmail = null;
  if (draft.channel === 'email') {
    try { gmail = await createEmailDraft({ to: draft.to, subject: draft.subject, body: draft.body }); }
    catch (error) { await mutate(store => { const l = store.leads.find(x => x.id === id); if (l?.draft) delete l.draft.approvalPending; }); throw error; }
  }
  return mutate(store => {
    const current = store.leads.find(l => l.id === id);
    current.stage = 'Ready to send';
    current.draft.approvedAt = new Date().toISOString();
    delete current.draft.approvalPending;
    if (gmail) current.draft.gmailDraftId = gmail.id;
    current.history.push({ at: current.draft.approvedAt, event: 'approved', ref: revision });
    return { lead: project(current), next: gmail ? 'Draft is in the info@thevillamanagers.com Gmail drafts. Press Send there, then tell Zuzu it was sent.' : `Send this from WhatsApp to ${current.phone}, then tell Zuzu it was sent:\n\n${current.draft.body}` };
  });
}

const MARKS = { sent: 'Sent', replied: 'Replied', meeting: 'Meeting', won: 'Won', lost: 'Lost', dnc: 'Do not contact' };

async function markLead(id, status, note = '') {
  const stage = MARKS[status];
  if (!stage) throw new Error('status must be one of: ' + Object.keys(MARKS).join(', '));
  return mutate(store => {
    const lead = store.leads.find(l => l.id === id);
    if (!lead) throw new Error('lead not found');
    const now = new Date();
    if (status === 'sent') {
      if (lead.stage !== 'Ready to send') throw new Error('only an approved draft can be marked sent');
      lead.touches += 1;
      lead.lastContactedAt = now.toISOString();
      lead.draft = null;
      if (lead.touches >= MAX_TOUCHES) { lead.stage = 'No reply'; lead.nextFollowUp = ''; }
      else { lead.stage = 'Sent'; lead.nextFollowUp = new Date(now.getTime() + FOLLOW_UP_DAYS * DAY).toISOString(); }
    } else {
      lead.stage = stage;
      lead.nextFollowUp = '';
      lead.draft = null;
    }
    lead.history.push({ at: now.toISOString(), event: status, note: clean(note, 300) });
    return project(lead);
  });
}

/** Morning digest for Afni: what needs her today. */
async function digest() {
  const { leads } = await read();
  const due = leads.filter(l => isDue(l));
  const waiting = leads.filter(l => l.stage === 'Awaiting approval');
  const ready = leads.filter(l => l.stage === 'Ready to send');
  const fresh = leads.filter(l => l.stage === 'New');
  if (!due.length && !waiting.length && !ready.length && !fresh.length) return '';
  const line = l => `- ${l.name} (${l.type}${l.area ? ', ' + l.area : ''})`;
  return ['AI SDR — today',
    waiting.length && `Drafts waiting for your OK: ${waiting.length}\n${waiting.slice(0, 5).map(line).join('\n')}`,
    ready.length && `Approved, waiting for you to send: ${ready.length}\n${ready.slice(0, 5).map(line).join('\n')}`,
    due.length && `Follow-up due: ${due.length}\n${due.slice(0, 5).map(line).join('\n')}`,
    fresh.length && `New leads without a draft: ${fresh.length} — say "draft outreach for new leads"`,
  ].filter(Boolean).join('\n\n');
}

module.exports = { init, addLead, listLeads, packet, saveDraft, approveDraft, markLead, digest, PROFILE, STAGES, MAX_TOUCHES };
