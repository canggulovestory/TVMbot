/**
 * Pure parsers for Afni's bank notification e-mails (Binky, 21-11-2026).
 * Input:  { domain, subject, date, text }  (domain = bank sender domain, text = plain text body,
 *          date = RFC 2822 Date header, used only when the body carries no transaction time).
 * Output: { ok:true, template, bank, accountHint, direction, amount, fee, currency, date, time,
 *           counterparty, reference, kind, internal, secondary, confidence }
 *      or { ok:false, reason, template? }.
 * Rule: an unrecognised template is ALWAYS { ok:false, reason:'unknown_template' }. Never guess.
 * No I/O, no logging. Callers must not persist raw text.
 */
'use strict';

const WITA_OFFSET_H = 8;
const WIB_OFFSET_H = 7;
const MONTHS = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3,
  apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7,
  agu: 8, agt: 8, aug: 8, agustus: 8, august: 8, sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10, nov: 11, nop: 11, november: 11,
  des: 12, dec: 12, desember: 12, december: 12,
};
const ISO = ['IDR', 'USD', 'SGD', 'EUR', 'AUD', 'GBP', 'JPY', 'MYR', 'CNY', 'HKD', 'VND', 'THB', 'KRW', 'TWD', 'CHF', 'NZD', 'PHP', 'AED', 'SAR', 'INR', 'CAD'];
const CURRENCY_ALIASES = Object.fromEntries([['RP', 'IDR'], ...ISO.map(c => [c, c])]);
const CUR_RE = new RegExp(`\\b(RP|${ISO.join('|')})\\b`, 'i');
const CUR_RE_G = new RegExp(`\\b(RP|${ISO.join('|')})\\b`, 'gi');
const ZERO_DECIMAL = new Set(['IDR', 'JPY', 'VND', 'KRW']);

// ---------------------------------------------------------------- numbers

/**
 * Parse an Indonesian/International money string.
 * "Rp 1.234.567,00" → 1234567 · "IDR 1,234,567.00" → 1234567 · "Rp1.500" → 1500 · "USD 12,5" → 12.5
 * Returns { currency, value } or null. value is a Number in major units (IDR rounded to integer).
 */
function parseAmount(raw, defaultCurrency = '', { roundIdr = false } = {}) {
  const s = String(raw || '').replace(/\u00a0/g, ' ').trim();
  if (!s) return null;
  let currency = '';
  const cm = s.match(CUR_RE) || s.match(/(?:^|\s)(Rp)(?=[\d\s])/i);
  if (cm) currency = CURRENCY_ALIASES[cm[1].toUpperCase()] || '';
  // number token: digits with . , separators (first one that has a digit)
  // the WHOLE field must be: [currency] number [currency] — never pick a number out of free text
  const rest = s.replace(CUR_RE_G, ' ').replace(/Rp/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!/^-?\d[\d.,]*$/.test(rest)) return null;
  let n = rest.replace(/[.,]+$/, '');
  const negative = n.startsWith('-'); if (negative) n = n.slice(1);
  if (!/^\d{1,3}([.,]\d+)*$|^\d+([.,]\d+)?$/.test(n)) return null;
  const lastDot = n.lastIndexOf('.'), lastComma = n.lastIndexOf(',');
  let intPart, frac = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    const [a, b] = n.split(decSep);
    if (n.split(decSep).length !== 2) return null;
    if (!new RegExp(`^\\d{1,3}(\\${thouSep}\\d{3})*$`).test(a)) return null;
    intPart = a.split(thouSep).join(''); frac = b;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = n.split(sep);
    if (parts.length > 2) {
      if (!parts.slice(1).every(p => p.length === 3) || parts[0].length > 3) return null;
      intPart = parts.join('');
    } else if (parts[1].length === 3) { // "1.500" / "999,999" → thousands
      intPart = parts.join('');
    } else { intPart = parts[0]; frac = parts[1]; }
  } else intPart = n;
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(frac)) return null;
  currency = currency || defaultCurrency;
  const hasCents = ZERO_DECIMAL.has(currency) && /[1-9]/.test(frac);
  if (hasCents && !roundIdr) return null; // IDR with real cents: refused unless the caller opts in to rounding
  if (!ZERO_DECIMAL.has(currency) && frac.length > 2) return null;
  let value = ZERO_DECIMAL.has(currency) ? Number(intPart) + (hasCents && Number('0.' + frac) >= 0.5 ? 1 : 0) : Number(intPart + (frac ? '.' + frac : ''));
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value))) return null;
  if (!ZERO_DECIMAL.has(currency)) value = Math.round(value * 100) / 100;
  const out = { currency, value: negative ? -value : value };
  if (hasCents) out.rounded = true;
  return out;
}

// ---------------------------------------------------------------- dates

function pad(n) { return String(n).padStart(2, '0'); }
/** Local wall-clock time at `offsetH` → WITA { date:'YYYY-MM-DD', time:'HH:MM' }. */
function toWita(y, mo, d, hh = 0, mi = 0, ss = 0, offsetH = WIB_OFFSET_H) {
  if (![y, mo, d].every(Number.isFinite) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const local = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d) return null; // 31/02 etc.
  const utc = local.getTime() - offsetH * 3600e3;
  const w = new Date(utc + WITA_OFFSET_H * 3600e3);
  return { date: `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`, time: `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}` };
}
function headerToWita(dateHeader) {
  const t = Date.parse(String(dateHeader || '').replace(/\s*\([^)]*\)\s*$/, ''));
  if (!Number.isFinite(t)) return null;
  const w = new Date(t + WITA_OFFSET_H * 3600e3);
  return { date: `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`, time: `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}` };
}
function tzOffsetFrom(s, fallback = WIB_OFFSET_H) {
  if (/\bWITA\b/i.test(s)) return 8;
  if (/\bWIT\b/i.test(s)) return 9;
  if (/\bWIB\b/i.test(s)) return 7;
  return fallback;
}
/** Parse body date strings: "17 Nov 2026 18:19:02", "17-11-2026 18:19:02 WIB", "17/11/2026", "17 November 2026, 13:05 WIB". */
function parseBodyDate(dateStr, timeStr = '', offsetH = WIB_OFFSET_H) {
  const s = `${dateStr || ''} ${timeStr || ''}`.trim();
  const tm = s.match(/(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?/);
  const [hh, mi, ss] = tm ? [Number(tm[1]), Number(tm[2]), Number(tm[3] || 0)] : [0, 0, 0];
  if (tm && (hh > 23 || mi > 59 || ss > 59)) return null;
  const off = tzOffsetFrom(s, offsetH);
  let m = s.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (m) return toWita(Number(m[3]), Number(m[2]), Number(m[1]), hh, mi, ss, off);
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) return toWita(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]), hh, mi, ss, off);
  return null;
}

// ---------------------------------------------------------------- text helpers

const MAX_TEXT = 20000, MAX_LINE = 400;
function capText(t) { return String(t || '').slice(0, MAX_TEXT).split('\n').map(l => l.slice(0, MAX_LINE)).join('\n'); }
function lines(text) { return String(text || '').split('\n').map(l => l.trim()).filter(Boolean); }
/**
 * Key/value pairs from the three label layouts banks use:
 *   "Label\n:\nValue"  (BCA)   "Label\n: Value"  (Permata)   "Label:\nValue" / "Label: Value"
 * First occurrence wins (Permata repeats everything in English after the Indonesian block).
 */
function kv(text) {
  const L = lines(text), out = new Map();
  const put = (k, v) => { const key = norm(k); if (key && !out.has(key)) out.set(key, String(v || '').trim()); };
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const pipe = l.match(/^([^|:]{2,60}?)\s*\|\s*:\s*(.*)$/);
    if (pipe) { put(pipe[1], pipe[2]); continue; }
    if (l === ':' && i > 0) {
      let v = L[i + 1] || '';
      if (L[i + 2] === ':' || v === ':') v = ''; // empty value, next line is the next label
      else if (/^(rp|idr|usd|sgd|eur)$/i.test(v) && L[i + 2] && L[i + 3] !== ':') v = `${v} ${L[i + 2]}`;
      put(L[i - 1], v);
    } else if (/^:\s*\S/.test(l) && i > 0) put(L[i - 1], l.replace(/^:\s*/, ''));
    else if (/^[^:]{2,40}:$/.test(l) && L[i + 1] && L[i + 1] !== ':') put(l.slice(0, -1), L[i + 1]);
    else { const inl = l.match(/^([A-Za-z][^:|]{1,40}?)\s*:\s+(\S.{0,200})$/); if (inl) put(inl[1], inl[2]); }
  }
  return out;
}
function norm(k) { return String(k || '').toLowerCase().replace(/[^a-z0-9/&]+/g, ' ').trim(); }
function pick(map, ...keys) { for (const k of keys) { const v = map.get(norm(k)); if (v != null && v !== '' && v !== '-') return v; } return ''; }
function has(map, key) { return map.has(norm(key)); }
function short(s, n = 40) {
  const t = String(s || '').replace(/&#\d+;|&#x[0-9a-f]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).trim() : t;
}
function cleanMerchant(s) {
  // drop trailing phone/ids like "@1234567890 CA", "#12345", long digit runs
  return short(String(s || '').replace(/[@#]\s*\d[\d\s]*.*$/, '').replace(/\s\d{6,}.*$/, '').replace(/\d{6,}/g, '').trim());
}
/** Masked-letter compare: '*' is a wildcard anywhere, 'X' only as a trailing run ("HARXXXXX"). */
function wildEq(a, b) {
  const unmask = w => { const m = w.match(/^(.*?[^X])(X{2,})$|^(.{3,}?)(X)$/); return m ? (m[1] || m[3]) + '?'.repeat((m[2] || m[4]).length) : w; };
  const A = unmask(a).replace(/\*/g, '?'), B = unmask(b).replace(/\*/g, '?');
  if (A.length !== B.length || A.replace(/\?/g, '').length < 2 || B.replace(/\?/g, '').length < 2) return false;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i] && A[i] !== '?' && B[i] !== '?') return false;
  return true;
}
/** Same person, tolerant of bank masking ("AFNX HARXXXXX", "**NI HARF**AN"). Needs ≥2 matching words. */
function sameName(a, b) {
  const A = String(a || '').toUpperCase().replace(/[^A-Z* ]/g, ' ').split(/\s+/).filter(Boolean);
  const B = String(b || '').toUpperCase().replace(/[^A-Z* ]/g, ' ').split(/\s+/).filter(Boolean);
  if (A.length < 2 || B.length < 2) return false;
  let hits = 0;
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === y || wildEq(x, y)) hits++; else break;
  }
  return hits >= 2;
}
function greetingName(text) {
  const m = String(text || '').match(/^(?:Hello|Halo|Hai|Hi)\s+([^,\n]+),/m);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------- result builders

function skip(reason, template) { return template ? { ok: false, reason, template } : { ok: false, reason }; }
function tx(fields) {
  const r = { ok: true, currency: 'IDR', fee: 0, reference: '', internal: false, secondary: false, ...fields };
  if (!r.rounded) delete r.rounded;
  if (!r.amount || !Number.isFinite(r.amount) || r.amount <= 0) return skip('amount_not_found', r.template);
  if (!r.date) return skip('date_not_found', r.template);
  if (r.currency !== 'IDR') r.confidence = Math.min(r.confidence, 0.7);
  if (r.rounded) r.confidence = Math.min(r.confidence, 0.85);
  r.counterparty = short(r.counterparty || '');
  return r;
}
function money(map, keys, def = 'IDR') {
  // IDR-only: a foreign-currency value here would otherwise be stored as IDR. Callers get null → amount_not_found.
  for (const k of keys) { const v = pick(map, k); if (v) { const a = parseAmount(v, def, { roundIdr: true }); if (a && a.currency === 'IDR') return a; if (a) return null; } }
  return null;
}

// ---------------------------------------------------------------- BCA

function bcaCreditCard(msg) {
  const m = kv(msg.text);
  if (!has(m, 'Merchant / ATM') || !has(m, 'Sejumlah')) return skip('unknown_template', 'bca_cc');
  const amt = parseAmount(pick(m, 'Sejumlah'));
  if (!amt || !amt.currency) return skip('amount_not_found', 'bca_cc');
  const d = parseBodyDate(pick(m, 'Pada Tanggal'));
  return tx({ template: 'bca_cc', bank: 'bca', accountHint: 'bca_credit_card', direction: 'out', kind: 'card',
    amount: amt.value, currency: amt.currency, date: d?.date, time: d?.time,
    counterparty: cleanMerchant(pick(m, 'Merchant / ATM')), confidence: d ? 0.95 : 0.5 });
}

function bcaJournal(msg) {
  const m = kv(msg.text);
  const status = pick(m, 'Status');
  if (!status) return skip('unknown_template', 'bca_journal');
  if (!/^successful$|^berhasil$|^sukses$/i.test(status)) return skip('failed_transaction', 'bca_journal');
  const type = pick(m, 'Transfer Type', 'Transaction Type');
  const d = parseBodyDate(pick(m, 'Transaction Date', 'Date/Time'));
  const owner = greetingName(msg.text);
  const ref = pick(m, 'Reference No.');
  const base = { template: 'bca_journal', bank: 'bca', accountHint: 'acc_bca', direction: 'out', date: d?.date, time: d?.time, reference: ref, confidence: d ? 0.95 : 0.5 };
  const feeOf = () => (money(m, ['Fee', 'Admin Fee'])?.value || 0);
  let r;
  if (/^Transfer to BCA Virtual Account$/i.test(type)) {
    const amt = money(m, ['Total Payment', 'Pay Amount', 'Bill Total']);
    const company = pick(m, 'Company/Product Name'), name = pick(m, 'Name');
    const self = !company && sameName(name, owner);
    r = { ...base, kind: 'transfer', amount: amt?.value, rounded: Boolean(amt?.rounded), counterparty: company ? cleanMerchant(company.split('/').pop()) : (self ? 'Own account (VA)' : name), internal: self };
  } else if (/^Transfer to /i.test(type)) {
    const amt = money(m, ['Transfer Amount', 'Amount']);
    const name = pick(m, 'Beneficiary Name');
    r = { ...base, kind: 'transfer', amount: amt?.value, rounded: Boolean(amt?.rounded), fee: feeOf(), counterparty: name, internal: sameName(name, owner) };
  } else if (/^e-Wallet\b/i.test(type) || /^Phone Credit\b|^Mobile Data\b/i.test(type)) {
    const amt = money(m, ['Amount', 'Total Payment']);
    const wallet = type.replace(/^(e-Wallet|Phone Credit|Mobile Data)\s*-\s*/i, '').replace(/\s*(TOPUP|PULSA|PAKET)$/i, '').trim();
    r = { ...base, kind: 'topup', amount: amt?.value, rounded: Boolean(amt?.rounded), fee: feeOf(), counterparty: wallet, internal: /^e-Wallet/i.test(type) && sameName(pick(m, 'Name'), owner) };
  } else if (/^QRIS Payment$/i.test(type)) {
    const amt = money(m, ['Total Payment', 'Amount']);
    const fx = parseAmount(pick(m, 'Amount'));
    r = { ...base, kind: 'qr', amount: amt?.value, rounded: Boolean(amt?.rounded), counterparty: cleanMerchant(pick(m, 'Payment to')) };
    if (fx && fx.currency && fx.currency !== 'IDR') { r.originalAmount = `${fx.currency} ${fx.value}`; r.confidence = Math.min(r.confidence, 0.85); }
  } else if (/^Credit Card & Paylater\b/i.test(type)) {
    const amt = money(m, ['Total Payment']);
    const issuer = type.replace(/^Credit Card & Paylater\s*-\s*/i, '').trim();
    r = { ...base, kind: 'transfer', amount: amt?.value, rounded: Boolean(amt?.rounded), counterparty: `${issuer} credit card`, internal: /^BCA$/i.test(issuer) };
  } else if (/^PURCHASE$/i.test(type)) {
    const amt = money(m, ['Total Payment']);
    r = { ...base, kind: 'payment', amount: amt?.value, rounded: Boolean(amt?.rounded), counterparty: pick(m, 'Product') };
  } else if (/Deposit Cash/i.test(type)) {
    const amt = money(m, ['Amount']);
    r = { ...base, direction: 'in', kind: 'deposit', amount: amt?.value, rounded: Boolean(amt?.rounded), counterparty: 'Cash deposit (cardless ATM)' };
  } else if (/Withdraw Cash/i.test(type)) {
    const amt = money(m, ['Amount']);
    r = { ...base, kind: 'withdrawal', amount: amt?.value, rounded: Boolean(amt?.rounded), counterparty: 'Cash (cardless ATM)' };
  } else return skip('unknown_template', 'bca_journal');
  return tx(r);
}

// ---------------------------------------------------------------- Permata

function permataStatusOk(m) {
  const s = pick(m, 'Status Transaksi', 'Transaction Status', 'Status');
  if (!s) return null;
  return /^(berhasil|sukses|success|successful|completed)$/i.test(s);
}
function permataDate(m) { return parseBodyDate(pick(m, 'Tanggal', 'Date'), pick(m, 'Jam', 'Time'), WIB_OFFSET_H); }

function permataTransferOut(msg) {
  const m = kv(msg.text);
  if (!has(m, 'Nama Penerima') || !has(m, 'Nominal')) return skip('unknown_template', 'permata_transfer_out');
  const ok = permataStatusOk(m);
  if (ok === false) return skip('failed_transaction', 'permata_transfer_out');
  if (ok === null) return skip('status_missing', 'permata_transfer_out');
  const d = permataDate(m), amt = money(m, ['Nominal']), name = pick(m, 'Nama Penerima');
  return tx({ template: 'permata_transfer_out', bank: 'permata', accountHint: 'acc_permata', direction: 'out', kind: 'transfer',
    amount: amt?.value, rounded: Boolean(amt?.rounded), fee: money(m, ['Biaya Transaksi'])?.value || 0, date: d?.date, time: d?.time,
    counterparty: name, reference: pick(m, 'Nomor referensi transaksi'), internal: sameName(name, pick(m, 'Dibuat oleh')),
    confidence: d && ok ? 0.95 : 0.6 });
}
function permataQr(msg) {
  const m = kv(msg.text);
  if (!has(m, 'Nama Merchant') || !has(m, 'Total Nominal')) return skip('unknown_template', 'permata_qr');
  const ok = permataStatusOk(m);
  if (ok === false) return skip('failed_transaction', 'permata_qr');
  if (ok === null) return skip('status_missing', 'permata_qr');
  const d = permataDate(m), amt = money(m, ['Total Nominal']);
  return tx({ template: 'permata_qr', bank: 'permata', accountHint: 'acc_permata', direction: 'out', kind: 'qr',
    amount: amt?.value, rounded: Boolean(amt?.rounded), date: d?.date, time: d?.time, counterparty: cleanMerchant(pick(m, 'Nama Merchant')),
    reference: pick(m, 'No. Referensi Transaksi'), confidence: d && ok ? 0.95 : 0.6 });
}
function permataIncoming(msg) {
  const m = kv(msg.text);
  if (!has(m, 'Nama Pengirim') || !has(m, 'Nominal')) return skip('unknown_template', 'permata_incoming');
  const d = permataDate(m), amt = money(m, ['Nominal']), name = pick(m, 'Nama Pengirim');
  return tx({ template: 'permata_incoming', bank: 'permata', accountHint: 'acc_permata', direction: 'in', kind: 'transfer',
    amount: amt?.value, rounded: Boolean(amt?.rounded), date: d?.date, time: d?.time, counterparty: name, reference: pick(m, 'Nomor Referensi Transaksi'),
    internal: sameName(name, pick(m, 'Nama Penerima')), confidence: d ? 0.95 : 0.6 });
}
function permataAtm(msg) {
  const m = kv(msg.text);
  if (!/^mobile cash$|tarik tunai|cash withdrawal/i.test(pick(m, 'Kategori')) || !has(m, 'Nominal')) return skip('unknown_template', 'permata_atm');
  const ok = permataStatusOk(m);
  if (ok === false) return skip('failed_transaction', 'permata_atm');
  if (ok === null) return skip('status_missing', 'permata_atm');
  const d = permataDate(m), amt = money(m, ['Nominal']);
  return tx({ template: 'permata_atm', bank: 'permata', accountHint: 'acc_permata', direction: 'out', kind: 'withdrawal',
    amount: amt?.value, rounded: Boolean(amt?.rounded), date: d?.date, time: d?.time, counterparty: 'Cash (ATM)', reference: pick(m, 'Nomor Referensi Transaksi'),
    confidence: d && ok ? 0.95 : 0.6 });
}

function permataPurchase(msg) {
  const m = kv(msg.text);
  if (!has(m, 'Total Bayar') || !has(m, 'Produk')) return skip('unknown_template', 'permata_purchase');
  const st = pick(m, 'Status');
  if (st && !/^(berhasil|sukses|success)$/i.test(st)) return skip('failed_transaction', 'permata_purchase');
  const d = parseBodyDate(pick(m, 'Tgl / Jam'), '', WIB_OFFSET_H), amt = money(m, ['Total Bayar']);
  return tx({ template: 'permata_purchase', bank: 'permata', accountHint: 'acc_permata', direction: 'out', kind: 'payment',
    amount: amt?.value, rounded: Boolean(amt?.rounded), date: d?.date, time: d?.time, counterparty: pick(m, 'Produk'), reference: pick(m, 'Bank Ref'),
    confidence: d && st ? 0.9 : 0.6 });
}

// ---------------------------------------------------------------- Jago

const RP = String.raw`Rp\s*(?:Rp\s*)?(-?\d[\d.,]*\d|\d)`;
function after(L, label) {
  const i = L.findIndex(l => norm(l) === norm(label));
  return i >= 0 ? (L[i + 1] || '') : '';
}
function jagoDate(L, msg) {
  const raw = after(L, 'Transaction Date');
  if (raw) { const d = parseBodyDate(raw, '', WIB_OFFSET_H); return d ? { ...d, fromBody: true } : null; } // present but bad → no date
  const h = headerToWita(msg.date);
  return h ? { ...h, fromBody: false } : null;
}
function jagoAmount(s) { const a = parseAmount(s, 'IDR'); return a && a.currency === 'IDR' ? a.value : undefined; }
const JAGO = { bank: 'jago', accountHint: 'acc_jago' };

function jagoTransfer(msg) {
  const L = lines(msg.text);
  if (!/You have transferred some money/i.test(msg.text)) return skip('unknown_template', 'jago_transfer');
  const to = after(L, 'To'), amount = jagoAmount(after(L, 'Amount')), d = jagoDate(L, msg);
  return tx({ ...JAGO, template: 'jago_transfer', direction: 'out', kind: 'transfer', amount, date: d?.date, time: d?.time,
    counterparty: to, internal: sameName(to, greetingName(msg.text)), confidence: d?.fromBody ? 0.9 : 0.75 });
}
function jagoPayment(msg) {
  const L = lines(msg.text);
  if (!/You have made a payment/i.test(msg.text)) return skip('unknown_template', 'jago_payment');
  const st = after(L, 'Transaction Status');
  if (st && !/^success(ful)?$|^berhasil$/i.test(st)) return skip('failed_transaction', 'jago_payment');
  const amount = jagoAmount(after(L, 'Amount')), d = jagoDate(L, msg);
  return tx({ ...JAGO, template: 'jago_payment', direction: 'out', kind: 'qr', amount, date: d?.date, time: d?.time,
    counterparty: cleanMerchant(after(L, 'To')), confidence: d?.fromBody && st ? 0.9 : 0.75 });
}
function jagoTopup(msg) {
  const L = lines(msg.text);
  if (!/You just did a top up/i.test(msg.text)) return skip('unknown_template', 'jago_topup');
  const amount = jagoAmount(after(L, 'Amount:') || after(L, 'Amount')), d = jagoDate(L, msg);
  return tx({ ...JAGO, template: 'jago_topup', direction: 'out', kind: 'topup', amount, date: d?.date, time: d?.time,
    counterparty: 'e-Wallet', confidence: d?.fromBody ? 0.85 : 0.7 });
}
function jagoDebitCard(msg) {
  const m = String(msg.text).match(new RegExp(`made a transaction of ${RP} using your Jago debit card`, 'i'));
  if (!m) return skip('unknown_template', 'jago_debit_card');
  const d = headerToWita(msg.date);
  return tx({ ...JAGO, template: 'jago_debit_card', direction: 'out', kind: 'card', amount: jagoAmount(m[1]), date: d?.date, time: d?.time,
    counterparty: 'Debit card (merchant not stated)', confidence: 0.8 });
}
function jagoPocket(msg) {
  const m = String(msg.text).match(new RegExp(`^([^\\n]{1,80}?) spent ${RP} from your ([^\\n]{1,60}?) Pocket\\.`, 'im'));
  if (!m) return skip('unknown_template', 'jago_pocket');
  const d = headerToWita(msg.date);
  // A second notice for a spend that Jago usually also mails as "You have made a transfer" / payment:
  // flagged secondary so the importer dedupes it against the primary notice (same amount, ±3 min).
  return tx({ ...JAGO, template: 'jago_pocket', direction: 'out', kind: 'transfer', amount: jagoAmount(m[2]), date: d?.date, time: d?.time,
    counterparty: `${short(m[3], 20)} Pocket (by ${short(m[1].split(/\s+/)[0], 15)})`, secondary: true, confidence: 0.6 });
}
function jagoFee(msg) {
  const m = String(msg.text).match(new RegExp(`charged a fee of ${RP} because[^\\n]{0,200}?\\bat ([^\\n]{1,120}?)\\s*\\.?$`, 'im'));
  if (!m) return skip('unknown_template', 'jago_fee');
  const d = headerToWita(msg.date);
  return tx({ ...JAGO, template: 'jago_fee', direction: 'out', kind: 'fee', amount: jagoAmount(m[1]), date: d?.date, time: d?.time,
    counterparty: `Jago fee (${cleanMerchant(m[2])})`, confidence: 0.85 });
}
function jagoReversal(msg) {
  const m = String(msg.text).match(new RegExp(`outgoing transfer of ${RP} to ([^\\n]{1,120}?) has been reversed`, 'i'));
  if (!m) return skip('unknown_template', 'jago_reversal');
  const d = headerToWita(msg.date);
  return tx({ ...JAGO, template: 'jago_reversal', direction: 'in', kind: 'reversal', amount: jagoAmount(m[1]), date: d?.date, time: d?.time,
    counterparty: cleanMerchant(m[2]), confidence: 0.85 });
}

// ---------------------------------------------------------------- routing

const ROUTES = [
  // [domain, subject regex, handler | skip reason]
  ['bca.co.id', /^Credit Card Transaction Notification$/i, bcaCreditCard],
  ['bca.co.id', /^Internet Transaction Journal$/i, bcaJournal],
  ['bca.co.id', /^Cash (Withdrawal|Deposit) Successful$/i, bcaJournal],
  ['bca.co.id', /^Transaction Failed Notification$/i, 'failed_transaction'],
  ['klikbca.com', /^Transaction Failed Notification$/i, 'failed_transaction'],
  ['bca.co.id', /^Electronic Statement\b/i, 'statement_not_parsed'],
  ['klikbca.com', /^Electronic Statement\b/i, 'statement_not_parsed'],
  ['bca.co.id', /^(Login with Biometrics|New Device Accessing|Congrats, Your Verification|Informasi Kenaikan Limit)\b/i, 'not_transaction'],
  ['bca.co.id', /^(Cashback|Diskon|Dapatkan|Dapat Voucher|Promo|Miliki|Nikmati|Autopay)\b/i, 'not_transaction'],
  ['klikbca.com', /^(Cashback|Diskon|Dapatkan|Dapat Voucher|Promo|Miliki|Nikmati|Perhatian)\b/i, 'not_transaction'],
  ['jago.com', /^There was a transaction in your Shared Pocket$/i, jagoPocket],
  ['jago.com', /^You have made a transfer\W*$/iu, jagoTransfer],
  ['jago.com', /^You have made a transaction using your debit card$/i, jagoDebitCard],
  ['jago.com', /^You have done an e-Wallet top up\W*$/iu, jagoTopup],
  ['jago.com', /^You have made a payment to .+$/iu, jagoPayment],
  ['jago.com', /^You've been charged an insufficient funds fee\.?$/i, jagoFee],
  ['jago.com', /^Money has been reversed$/i, jagoReversal],
  ['jago.com', /Pocket (has been closed|is inactive|will be inactive)\b|^Password Change\b|^Jago detected a sign in\b/i, 'not_transaction'],
  ['permatabank.co.id', /^Transfer - Other Bank BI-FAST$/i, permataTransferOut],
  ['permatabank.co.id', /^Permata ME\s?: Transfer - Other Account$/i, permataTransferOut],
  ['permatabank.co.id', /^Permata ME\s?: Top Up - PLN Token$/i, permataPurchase],
  ['permatabank.co.id', /^Permata ME\s?: Mobile Cash Reservation$/i, 'not_transaction'],
  ['permatabank.co.id', /^Informasi Login$/i, 'not_transaction'],
  ['permatabank.co.id', /^Permata ME : QR Pay$/i, permataQr],
  ['permatabank.co.id', /^Permata Bank: Incoming Transfer$/i, permataIncoming],
  ['permatabank.co.id', /^ATM : Mobile Cash$/i, permataAtm],
  ['permatabank.co.id', /^Permata ME : (Registration|Login|Unlink|Link)\b/i, 'not_transaction'],
  ['cimbniaga.co.id', /^Combined Statement\b/i, 'statement_not_parsed'],
  ['cimbniaga.co.id', /^OCTO\b/i, 'not_transaction'],
];

/** Which template a message belongs to (for stats), or 'unknown'. */
function templateOf(msg) {
  const dom = String(msg?.domain || '').toLowerCase(), subj = String(msg?.subject || '').trim();
  const r = ROUTES.find(([d, re]) => (dom === d || dom.endsWith('.' + d)) && re.test(subj));
  if (!r) return 'unknown';
  return typeof r[2] === 'function' ? r[2].name : `skip:${r[2]}`;
}

function parse(msg) {
  if (!msg || typeof msg !== 'object') return skip('bad_input');
  const dom = String(msg.domain || '').toLowerCase(), subj = String(msg.subject || '').trim();
  const r = ROUTES.find(([d, re]) => (dom === d || dom.endsWith('.' + d)) && re.test(subj));
  if (!r) return skip('unknown_template');
  if (typeof r[2] === 'string') return skip(r[2]);
  try { return r[2]({ ...msg, text: capText(msg.text) }); }
  catch { return skip('parser_error'); }
}

module.exports = { parse, templateOf, parseAmount, parseBodyDate, headerToWita, kv, sameName, ROUTES };
