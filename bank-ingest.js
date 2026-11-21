/**
 * Daily bank-mail → financial-app ingest for Afni (Binky, 21-11-2026). Read docs/BANK-MAIL-INGEST.md first.
 *
 * Reads bank notification mails (read-only Gmail, DKIM-gated, bodies in memory only), parses them with
 * bank-parsers.js, applies Afni's booking rules and calls finance_prepare per transaction. finance_prepare
 * only creates a PREVIEW; nothing is booked until Afni taps the owner confirmation link.
 *
 * Afni's rules (source of truth, do not loosen):
 *  - Accounts: CIMB Niaga, BCA, Permata only. Never the LinkAI card, never create accounts.
 *  - Permata → Permata. Everything else (CIMB, BCA, BCA credit card, Jago, OVO, GoPay, ShopeePay, other)
 *    → CIMB Niaga, because Afni funds all spending CIMB → BCA; the route goes in the description,
 *    e.g. "CIMB Niaga (via Jago) – transfer to X" (Afni 21-11-2026, TG 58688/58698).
 *  - Internal transfers between her own accounts → never income/cost: skipped, counted as own transfers.
 *  - secondary (Jago Shared Pocket duplicates) → skipped silently.
 *  - Non-IDR card charges → not prepared, listed as "needs manual entry (foreign currency)".
 *  - confidence < 0.8 or unknown template → not prepared, listed as "needs check".
 *  - Descriptions in English, short, never account numbers or full reference numbers.
 *
 * State (data/bank-ingest-state.json, 0600): processed Gmail ids, hashed bank references, last run time.
 * Raw bodies, account numbers and references are never written to disk (references only as sha256).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const MIN_CONFIDENCE = 0.8;
const KEEP_IDS = 2000;
const LIST_LIMIT = 25;
const LOOKBACK_DAYS = 3; // re-scan window when running from state; dedupe makes it safe
const WITA_MS = 8 * 3600e3;
// Telegram message ids in Afni's DM are small; synthetic ids live far above them (2^52 .. 2^53).
const MSG_ID_BASE = 2 ** 52;
const MSG_ID_SPAN = 2 ** 48;

const ACCOUNT_NAMES = { bca: 'BCA', cimb: 'CIMB Niaga', permata: 'Permata' };
const SOURCE_LABELS = { jago: 'Jago', ovo: 'OVO', gopay: 'GoPay', gojek: 'GoPay', shopeepay: 'ShopeePay', shopee: 'ShopeePay' };
// Skip reasons that are not transactions at all (promos, logins, statements, failed transfers).
const IGNORE_REASONS = new Set(['not_transaction', 'statement_not_parsed', 'failed_transaction']);

// ---------------------------------------------------------------- small helpers

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function witaDate(ms) { const d = new Date(ms + WITA_MS); return d.toISOString().slice(0, 10); }
function witaMidnightMs(ymd) { return Date.parse(ymd + 'T00:00:00Z') - WITA_MS; }
function fmtAmount(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(ymd) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]}` : String(ymd || ''); }

/** Remove anything that looks like an account / card / reference number (5+ digits, or long digit groups). */
function scrub(s) {
  return String(s || '')
    .replace(/\b(?:\d[\s-]?){5,}\d?\b/g, ' ')       // 5+ digits, also "1234 5678" / "1234-5678"
    .replace(/\b[A-Z0-9]*\d[A-Z0-9]{9,}\b/gi, ' ')   // long alphanumeric refs containing a digit
    .replace(/[*xX]{3,}\d{2,}/g, ' ')               // masked card numbers ****1234
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.)])/g, '$1').trim();
}

/** Which app account and which source label a parsed transaction belongs to. */
function routeAccount(tx) {
  const bank = String(tx.bank || '').toLowerCase();
  if (bank === 'permata') return { account: 'permata', source: '' };
  if (bank === 'cimb' || bank === 'cimbniaga') return { account: 'cimb', source: '' };
  // Afni 21-11 (TG 58688/58698): all spending is funded CIMB -> BCA, so BCA, BCA credit card, Jago and wallets
  // are booked on CIMB Niaga with the payment route in the description, e.g. "CIMB Niaga (via BCA)".
  if (bank === 'bca') return { account: 'cimb', source: tx.accountHint === 'bca_credit_card' ? 'BCA credit card' : 'BCA' };
  const label = SOURCE_LABELS[bank] || (bank ? scrub(bank.charAt(0).toUpperCase() + bank.slice(1)).replace(/[^\w .-]/g, '').slice(0, 20) || 'other' : 'other');
  return { account: 'cimb', source: label };
}

function describe(tx, source) {
  let raw = String(tx.counterparty || '');
  if (tx.reference && String(tx.reference).length >= 4) raw = raw.split(String(tx.reference)).join(' '); // exact reference never leaks
  const who = scrub(raw.replace(/[\u0000-\u001f\u007f]/g, ' ')) || 'unknown';
  let what;
  switch (tx.kind) {
    case 'transfer': what = tx.direction === 'in' ? `transfer from ${who}` : `transfer to ${who}`; break;
    case 'topup': what = `top-up ${who}`; break;
    case 'withdrawal': what = 'cash withdrawal'; break;
    case 'deposit': what = 'cash deposit'; break;
    case 'fee': what = `bank fee${who !== 'unknown' ? ' – ' + who : ''}`; break;
    case 'reversal': what = `reversal – ${who}`; break;
    default: what = who;
  }
  const fee = tx.direction === 'out' && tx.fee > 0 ? ` (incl. ${fmtAmount(tx.fee)} fee)` : '';
  const head = source ? `${ACCOUNT_NAMES.cimb} (via ${source})` : null;
  return { head, text: `${what}${fee}`.slice(0, 200) };
}

// ---------------------------------------------------------------- state

function emptyState() { return { version: 1, processedIds: [], refs: [], lastRunAt: null }; }
async function loadState(file) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('bank-ingest state must be a regular file');
    if (st.mode & 0o077) await fs.chmod(file, 0o600);
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return { ...emptyState(), ...s, processedIds: Array.isArray(s.processedIds) ? s.processedIds : [], refs: Array.isArray(s.refs) ? s.refs : [] };
  } catch (e) { if (e.code === 'ENOENT') return emptyState(); throw e; }
}
async function saveState(file, state) {
  const out = { ...state, processedIds: state.processedIds.slice(-KEEP_IDS), refs: state.refs.slice(-KEEP_IDS) };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(out, null, 1), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/** Deterministic Telegram-style message id per Gmail id → the same mail always maps to the same sourceRequestId. */
function messageIdFor(gmailId, taken) {
  let salt = 0;
  for (;;) {
    const h = parseInt(sha(`bank-ingest:${gmailId}:${salt}`).slice(0, 12), 16); // 48 bits
    const id = MSG_ID_BASE + (h % MSG_ID_SPAN);
    if (!taken.has(id)) { taken.add(id); return id; }
    salt++;
  }
}

/** Canonical bank reference key (hashed; the reference itself never hits disk). */
function refKeyOf(r) {
  const ref = String(r.reference || '').normalize('NFKC').trim().toUpperCase().replace(/[\s-]+/g, '');
  return ref ? sha(`${String(r.bank || '').toLowerCase()}:${ref}`) : '';
}
function validDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return false;
  const t = Date.parse(ymd + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd;
}
function amountString(n) {
  const v = Math.round(n * 100) / 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
  return /^[0-9]{1,14}(\.[0-9]{1,2})?$/.test(s) && /[1-9]/.test(s) ? s : '';
}
/** Simple O_EXCL run lock; a lock older than 30 min is treated as stale. */
async function withLock(file, fn) {
  const lock = file + '.lock';
  try { await fs.writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const st = await fs.stat(lock).catch(() => null);
    if (st && Date.now() - st.mtimeMs < 30 * 60e3) throw new Error('bank-ingest is already running');
    await fs.rm(lock, { force: true });
    await fs.writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  try { return await fn(); } finally { await fs.rm(lock, { force: true }); }
}

// ---------------------------------------------------------------- core

/**
 * deps:
 *  gmail:   { listIds({ since: 'YYYY-MM-DD', max }) → [id], getText(id) → { id, domain, subject, date, internalDate, text } }
 *  parse:   (message) → parser result
 *  finance: (messageId:number) → { finance_read, finance_prepare }   (tools bound to that delivery id)
 *  stateFile, now(): ms, ownerId: number
 */
function createIngest({ gmail, parse, finance, stateFile, now = () => Date.now(), maxMessages = 500 }) {
  if (!gmail || typeof parse !== 'function' || typeof finance !== 'function' || !stateFile) throw new Error('bank-ingest: missing deps');

  async function resolveAccounts(tools) {
    const r = await tools.finance_read({ resource: 'accounts', pageSize: 50 });
    const items = Array.isArray(r?.items) ? r.items : [];
    const ids = {};
    for (const [key, name] of Object.entries(ACCOUNT_NAMES)) {
      const a = items.find(x => String(x.name || '').trim().toLowerCase() === name.toLowerCase());
      if (a && typeof a.id === 'string' && !/linkai/i.test(a.name) && (a.currency || 'IDR') === 'IDR') ids[key] = a.id;
    }
    return ids;
  }

  async function run(opts = {}) { return opts.dryRun ? runInner(opts) : withLock(stateFile, () => runInner(opts)); }

  async function runInner({ since, dryRun = false } = {}) {
    const state = await loadState(stateFile);
    const processed = new Set(state.processedIds);
    const refs = new Set(state.refs);
    const nowMs = now();
    let sinceYmd = since;
    if (sinceYmd && !/^\d{4}-\d{2}-\d{2}$/.test(sinceYmd)) throw new Error('since must be YYYY-MM-DD');
    if (!sinceYmd) {
      const base = state.lastRunAt ? Date.parse(state.lastRunAt) : nowMs;
      sinceYmd = witaDate((Number.isFinite(base) ? base : nowMs) - LOOKBACK_DAYS * 86400e3);
    }
    const sinceMs = witaMidnightMs(sinceYmd);

    const out = {
      dryRun, since: sinceYmd, until: witaDate(nowMs),
      prepared: [], ownTransfers: [], needsCheck: [], foreign: [], failed: [], alreadyInApp: [],
      counts: { scanned: 0, alreadyProcessed: 0, ignored: 0, secondary: 0, duplicateRef: 0, rejected: 0 },
    };
    const markIds = [], markRefs = [];
    const mark = (id, refKey) => { markIds.push(id); if (refKey) markRefs.push(refKey); };

    const ids = await gmail.listIds({ since: sinceYmd, max: maxMessages });
    const msgs = [];
    for (const id of ids) {
      if (processed.has(id)) { out.counts.alreadyProcessed++; continue; }
      let msg;
      try { msg = await gmail.getText(id); }
      catch (e) {
        if (e && (e.code === 'dkim_not_pass' || e.code === 'not_bank_sender')) { out.counts.rejected++; mark(id); }
        else out.failed.push({ id, reason: 'mail_unavailable' });
        continue;
      }
      if (msg.internalDate && msg.internalDate < sinceMs) continue;
      msgs.push(msg);
    }
    msgs.sort((a, b) => (a.internalDate || 0) - (b.internalDate || 0));

    let tools = null, accountIds = null;
    const taken = new Set();
    const seenRefsThisRun = new Set();

    for (const msg of msgs) {
      out.counts.scanned++;
      const r = parse(msg);
      if (!r || !r.ok) {
        const reason = r?.reason || 'unknown';
        if (IGNORE_REASONS.has(reason)) { out.counts.ignored++; mark(msg.id); continue; }
        out.needsCheck.push({ id: msg.id, date: msg.internalDate ? witaDate(msg.internalDate) : '', bank: msg.domain || '', reason });
        mark(msg.id);
        continue;
      }
      if (r.secondary) { out.counts.secondary++; mark(msg.id); continue; }

      const refKey = refKeyOf(r);
      if (refKey && (refs.has(refKey) || seenRefsThisRun.has(refKey))) { out.counts.duplicateRef++; mark(msg.id); continue; }
      if (refKey) seenRefsThisRun.add(refKey);

      const { account, source } = routeAccount(r);
      const label = source ? `${ACCOUNT_NAMES.cimb} (via ${source})` : ACCOUNT_NAMES[account];
      const base = { id: msg.id, date: r.date, label, direction: r.direction, amount: r.amount, currency: r.currency, counterparty: scrub(r.counterparty) };

      // Order: foreign first (the parser caps non-IDR confidence at 0.7), then confidence, then internal,
      // so a doubtful "own transfer" is shown for checking instead of silently skipped.
      if (r.currency !== 'IDR') { out.foreign.push(base); mark(msg.id, refKey); continue; }
      if (/linkai|acc_cash/i.test(String(r.accountHint || ''))) { out.needsCheck.push({ ...base, reason: 'linkai_card' }); mark(msg.id, refKey); continue; }
      const amount = Number(r.amount), fee = Number(r.fee || 0);
      const sane = (r.direction === 'in' || r.direction === 'out') && Number.isFinite(amount) && amount > 0 && Number.isFinite(fee) && fee >= 0 && validDate(r.date);
      if (!sane || !(r.confidence >= MIN_CONFIDENCE)) { out.needsCheck.push({ ...base, reason: sane ? 'low_confidence' : 'invalid_fields' }); mark(msg.id, refKey); continue; }
      if (r.internal) { out.ownTransfers.push(base); mark(msg.id, refKey); continue; }

      const total = r.direction === 'out' ? amount + fee : amount;
      const amountStr = amountString(total);
      if (!amountStr) { out.needsCheck.push({ ...base, reason: 'invalid_fields' }); mark(msg.id, refKey); continue; }
      const d = describe({ ...r, fee }, source);
      const description = `${d.head || ACCOUNT_NAMES[account]} – ${d.text}`;
      const item = { ...base, amount: total, description };

      if (!tools) { tools = finance(messageIdFor(`accounts:${nowMs}`, new Set())); accountIds = await resolveAccounts(tools); }
      const accountId = accountIds[account];
      if (!accountId) { out.needsCheck.push({ ...base, reason: 'account_not_found' }); continue; }

      const intent = { kind: r.direction === 'in' ? 'income' : 'expense', amount: amountStr, currency: 'IDR', date: r.date, accountId, description };
      item.intent = intent;
      if (dryRun) { out.prepared.push(item); continue; }

      const ptools = finance(messageIdFor(msg.id, taken));
      let res;
      try { res = await ptools.finance_prepare({ intent }); } catch (e) { res = { ok: false, error: e.message }; }
      if (res && typeof res.confirmationUrl === 'string' && res.confirmationUrl) {
        out.prepared.push({ ...item, confirmationUrl: res.confirmationUrl, proposalId: res.proposalId });
        mark(msg.id, refKey);
      } else if (/already saved/i.test(String(res?.error || ''))) {
        out.alreadyInApp.push(item); mark(msg.id, refKey);
      } else {
        out.failed.push({ ...item, reason: String(res?.error || 'prepare_failed').slice(0, 120) });
      }
    }

    if (!dryRun) {
      // Re-read and merge so a concurrent run cannot drop ids.
      const fresh = await loadState(stateFile);
      const ids2 = fresh.processedIds.filter(x => !markIds.includes(x)).concat(markIds);
      const refs2 = fresh.refs.filter(x => !markRefs.includes(x)).concat(markRefs);
      await saveState(stateFile, { ...fresh, processedIds: ids2, refs: refs2, lastRunAt: new Date(nowMs).toISOString() });
    }
    out.totals = {
      in: out.prepared.filter(x => x.direction === 'in').reduce((s, x) => s + x.amount, 0),
      out: out.prepared.filter(x => x.direction === 'out').reduce((s, x) => s + x.amount, 0),
    };
    return out;
  }

  return { run };
}

// ---------------------------------------------------------------- summary

function line(i, x, tail) {
  const who = x.counterparty ? ` · ${x.counterparty}` : '';
  return `${i}. ${shortDate(x.date)} · ${x.label} · ${x.direction} ${x.currency && x.currency !== 'IDR' ? `${x.currency} ${Number(x.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : fmtAmount(x.amount)}${who}${tail || ''}`;
}

/** One Telegram-ready text for Afni. No account numbers, no references. */
function buildSummary(res) {
  const L = [];
  const range = res.since === res.until ? shortDate(res.since) : `${shortDate(res.since)} – ${shortDate(res.until)}`;
  L.push(`🏦 Bank mails ${range}${res.dryRun ? ' (test run, nothing prepared)' : ''}`);
  L.push(`✅ ${res.dryRun ? 'Ready to prepare' : 'Prepared'}: ${res.prepared.length}`);
  L.push(`🔁 Own transfers skipped: ${res.ownTransfers.length}`);
  L.push(`⚠️ Needs check: ${res.needsCheck.length}`);
  L.push(`💱 Needs manual entry (foreign currency): ${res.foreign.length}`);
  if (res.alreadyInApp?.length) L.push(`☑️ Already in the app: ${res.alreadyInApp.length}`);
  if (res.failed?.length) L.push(`❌ Could not prepare (will retry): ${res.failed.length}`);
  L.push(`⬇️ In: ${fmtAmount(res.totals.in)} · ⬆️ Out: ${fmtAmount(res.totals.out)}`);
  if (res.prepared.length) {
    L.push('', res.dryRun ? 'Would prepare:' : 'Tap to confirm:');
    res.prepared.slice(0, LIST_LIMIT).forEach((x, i) => L.push(line(i + 1, x, x.confirmationUrl ? ` → ${x.confirmationUrl}` : '')));
    if (res.prepared.length > LIST_LIMIT) L.push(`and ${res.prepared.length - LIST_LIMIT} more on the website`);
  }
  if (res.foreign.length) {
    L.push('', 'Foreign currency (enter by hand):');
    res.foreign.slice(0, 10).forEach((x, i) => L.push(line(i + 1, x)));
    if (res.foreign.length > 10) L.push(`and ${res.foreign.length - 10} more`);
  }
  const checks = res.needsCheck.filter(x => x.amount);
  if (res.needsCheck.length) {
    L.push('', 'Needs check:');
    checks.slice(0, 10).forEach((x, i) => L.push(line(i + 1, x)));
    const other = res.needsCheck.length - Math.min(checks.length, 10);
    if (other > 0) L.push(`${other} mail${other > 1 ? 's' : ''} not read automatically`);
  }
  return scrubSummary(L.join('\n'));
}
// Final belt and braces: no 7+ digit runs (account numbers) outside URLs.
function scrubSummary(text) {
  return text.split('\n').map(l => {
    const i = l.indexOf('https://');
    const head = i >= 0 ? l.slice(0, i) : l, tail = i >= 0 ? l.slice(i) : '';
    return head.replace(/\d{7,}/g, '…') + tail;
  }).join('\n');
}

// ---------------------------------------------------------------- real wiring

/** Production deps: bank-gmail.js + bank-parsers.js + finance bridge. */
function productionDeps({ root = __dirname, dataDir = path.join(__dirname, 'data'), financeConfig = '/etc/zuzu-finance/telegram.json', ownerId = 573027610 } = {}) {
  require(path.join(root, 'node_modules/dotenv')).config({ path: path.join(root, '.env'), override: true, quiet: true });
  const bankGmail = require('./bank-gmail');
  bankGmail.init(dataDir);
  const host = require('./vendor/finance/finance-host.cjs').loadFinanceHost(financeConfig);
  if (!host || !host.enabled) throw new Error('Finance bridge is not enabled.');
  let tok = null;
  const token = async () => (tok ||= await bankGmail.accessToken());
  return {
    gmail: {
      async listIds({ since, max }) { return bankGmail.listBankMessageIds({ extra: `after:${since.replace(/-/g, '/')}`, max }, await token()); },
      async getText(id) { return bankGmail.getBankMessageText(id, await token()); },
    },
    parse: require('./bank-parsers').parse,
    finance: messageId => {
      const t = host.telegram({ message_id: messageId, from: { id: ownerId, is_bot: false }, chat: { id: ownerId, type: 'private' } });
      if (!t.finance_read) throw new Error('Finance tools unavailable for the owner.');
      return t;
    },
    stateFile: path.join(dataDir, 'bank-ingest-state.json'),
  };
}

module.exports = { createIngest, buildSummary, productionDeps, routeAccount, describe, scrub, messageIdFor, MIN_CONFIDENCE, LIST_LIMIT };
