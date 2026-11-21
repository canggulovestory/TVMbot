'use strict';
// All fixtures under test/fixtures/bank are SYNTHETIC (fake names, numbers, refs) with the real layouts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bp = require('../bank-parsers');
const gm = require('../bank-gmail');

const FX = path.join(__dirname, 'fixtures', 'bank');
const fx = name => JSON.parse(fs.readFileSync(path.join(FX, name + '.json'), 'utf8'));
const parse = name => bp.parse(fx(name));
function expectTx(name, want) {
  const r = parse(name);
  assert.strictEqual(r.ok, true, `${name}: ${JSON.stringify(r)}`);
  for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(r[k], v, `${name}.${k}`);
  assert.ok(r.confidence > 0 && r.confidence <= 1, `${name}.confidence`);
  return r;
}

test('number formats: Indonesian and international', () => {
  const cases = [
    ['Rp 1.234.567,00', 'IDR', 1234567], ['IDR 1,234,567.00', 'IDR', 1234567], ['Rp1.500', 'IDR', 1500],
    ['Rp 1.500', 'IDR', 1500], ['IDR 99.999', 'IDR', 99999], ['RP 200.000', 'IDR', 200000], ['Rp Rp5.000', 'IDR', 5000],
    ['USD 12,5', 'USD', 12.5], ['CNY 1.234,56', 'CNY', 1234.56], ['VND 150.000', 'VND', 150000], ['IDR 2,500.00', 'IDR', 2500],
  ];
  for (const [s, cur, val] of cases) assert.deepStrictEqual(bp.parseAmount(s), { currency: cur, value: val }, s);
  assert.deepStrictEqual(bp.parseAmount('185,000', 'IDR'), { currency: 'IDR', value: 185000 });
  assert.strictEqual(bp.parseAmount('no number here'), null);
  assert.strictEqual(bp.parseAmount('IDR 1.2.3,4.5'), null);
});

test('dates are converted to WITA (UTC+8)', () => {
  assert.deepStrictEqual(bp.parseBodyDate('17-11-2026 23:30:00 WIB'), { date: '2026-11-18', time: '00:30' });
  assert.deepStrictEqual(bp.parseBodyDate('21 Nov 2026 15:18:01'), { date: '2026-11-21', time: '16:18' });
  assert.deepStrictEqual(bp.parseBodyDate('13 November 2026, 17:34 WIB'), { date: '2026-11-13', time: '18:34' });
  assert.deepStrictEqual(bp.parseBodyDate('21/11/2026', '17:56:20'), { date: '2026-11-21', time: '18:56' });
  assert.deepStrictEqual(bp.parseBodyDate('5 Agu 2026 10:00 WITA'), { date: '2026-08-05', time: '10:00' });
  assert.deepStrictEqual(bp.headerToWita('Sat, 21 Nov 2026 16:30:00 GMT'), { date: '2026-11-22', time: '00:30' });
  assert.strictEqual(bp.parseBodyDate('32/13/2026'), null);
});

test('BCA credit card notifications', () => {
  expectTx('bca_cc_idr', { bank: 'bca', accountHint: 'bca_credit_card', direction: 'out', kind: 'card', amount: 1250000, currency: 'IDR', date: '2026-11-18', counterparty: 'TOKO CONTOH JAYA' });
  const usd = expectTx('bca_cc_usd', { amount: 12.5, currency: 'USD', counterparty: 'EXAMPLE.COM/BILL' });
  assert.ok(usd.confidence <= 0.7, 'foreign currency gets lower confidence');
  assert.deepStrictEqual(parse('bca_cc_failed'), { ok: false, reason: 'failed_transaction' });
});

test('BCA internet transaction journal variants', () => {
  expectTx('bca_journal_transfer', { accountHint: 'acc_bca', direction: 'out', kind: 'transfer', amount: 2500000, date: '2026-11-18', counterparty: 'CONTOH PENERIMA SATU', reference: '00000000000000000000TRF00000', internal: false });
  expectTx('bca_journal_other_bank', { amount: 10000000, fee: 2500, counterparty: 'CONTOH PEGAWAI DUA', internal: false });
  expectTx('bca_journal_self_jago', { amount: 10000000, internal: true });
  expectTx('bca_journal_va', { kind: 'transfer', amount: 345600, counterparty: 'TOKOCONTOH', internal: false });
  expectTx('bca_journal_va_self', { amount: 500000, internal: true });
  expectTx('bca_journal_ewallet', { kind: 'topup', amount: 50000, fee: 1000, counterparty: 'GOPAY' });
  expectTx('bca_journal_qris', { kind: 'qr', amount: 185000, date: '2026-11-08', counterparty: 'KAFE CONTOH' });
  expectTx('bca_journal_cc_payment', { kind: 'transfer', amount: 750000, internal: true, counterparty: 'BCA credit card' });
  expectTx('bca_journal_purchase', { kind: 'payment', amount: 200000, counterparty: 'PLN PREPAID', date: '2026-11-05' });
  expectTx('bca_cash_withdrawal', { kind: 'withdrawal', direction: 'out', amount: 1500000 });
  expectTx('bca_cash_deposit', { kind: 'deposit', direction: 'in', amount: 20000000 });
  assert.deepStrictEqual(parse('bca_journal_failed'), { ok: false, reason: 'failed_transaction', template: 'bca_journal' });
  assert.deepStrictEqual(parse('bca_journal_unknown_type'), { ok: false, reason: 'unknown_template', template: 'bca_journal' });
});

test('Jago templates', () => {
  const pocket = expectTx('jago_pocket', { bank: 'jago', accountHint: 'acc_jago', direction: 'out', amount: 350000, date: '2026-11-21', secondary: true });
  assert.ok(pocket.confidence < 0.7);
  expectTx('jago_transfer', { kind: 'transfer', amount: 350000, date: '2026-11-21', time: '21:27', counterparty: 'CONTOH PENERIMA EMPAT', secondary: false });
  expectTx('jago_debit_card', { kind: 'card', amount: 125500, date: '2026-11-18' });
  expectTx('jago_topup', { kind: 'topup', amount: 200000, date: '2026-11-14' });
  expectTx('jago_payment', { kind: 'qr', amount: 1234000, counterparty: 'PT Toko Contoh', date: '2026-11-13' });
  expectTx('jago_fee', { kind: 'fee', amount: 5000, counterparty: 'Jago fee (EXAMPLEAI)' });
  expectTx('jago_reversal', { kind: 'reversal', direction: 'in', amount: 99000, counterparty: 'EXAMPLEADS' });
  assert.deepStrictEqual(parse('jago_unknown'), { ok: false, reason: 'unknown_template' });
});

test('Permata templates', () => {
  expectTx('permata_bifast', { bank: 'permata', accountHint: 'acc_permata', direction: 'out', kind: 'transfer', amount: 4200000, fee: 0, date: '2026-11-21', reference: '000000001', internal: false });
  expectTx('permata_bifast_self', { internal: true });
  expectTx('permata_other_account', { amount: 4200000, kind: 'transfer' });
  expectTx('permata_qr', { kind: 'qr', amount: 185000, counterparty: 'KAFE CONTOH ENAM', date: '2026-11-21', time: '18:56', reference: '000000000002' });
  expectTx('permata_incoming', { direction: 'in', kind: 'transfer', amount: 15750000, counterparty: 'CONTOH TAMU TUJUH', internal: false });
  expectTx('permata_atm', { kind: 'withdrawal', amount: 2000000 });
  expectTx('permata_pln', { kind: 'payment', amount: 300000, date: '2026-10-14' });
  assert.deepStrictEqual(parse('permata_bifast_failed'), { ok: false, reason: 'failed_transaction', template: 'permata_transfer_out' });
});

test('skip cases never produce a transaction', () => {
  assert.deepStrictEqual(parse('bca_promo'), { ok: false, reason: 'not_transaction' });
  assert.deepStrictEqual(parse('permata_login'), { ok: false, reason: 'not_transaction' });
  assert.deepStrictEqual(parse('cimb_statement'), { ok: false, reason: 'statement_not_parsed' });
  assert.deepStrictEqual(bp.parse({ domain: 'evil.example', subject: 'Internet Transaction Journal', text: fx('bca_journal_transfer').text }), { ok: false, reason: 'unknown_template' });
  assert.deepStrictEqual(bp.parse({ domain: 'bca.co.id', subject: 'Something new', text: 'Amount IDR 1.000' }), { ok: false, reason: 'unknown_template' });
  assert.deepStrictEqual(bp.parse(null), { ok: false, reason: 'bad_input' });
  // right subject, wrong body layout → unknown, never a guess
  assert.strictEqual(bp.parse({ ...fx('permata_qr'), text: 'Total Rp 5.000' }).reason, 'unknown_template');
});

// ---------- bank-gmail: text extraction + DKIM gate (synthetic Gmail payloads)
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');
function gmailMsg({ from = 'BCA <bca@bca.co.id>', auth, html = '<div>Status</div><div>:</div><div>Successful</div>', subject = 'Internet Transaction Journal' } = {}) {
  const headers = [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: 'Sat, 21 Nov 2026 10:00:00 +0700' }];
  for (const a of [].concat(auth || [])) headers.push({ name: 'Authentication-Results', value: a });
  return { id: 'm1', internalDate: '1', payload: { mimeType: 'multipart/alternative', headers, parts: [
    { mimeType: 'text/plain', body: { data: b64('plain fallback') } }, { mimeType: 'text/html', body: { data: b64(html) } }] } };
}
const PASS = 'mx.google.com; dkim=pass header.i=@bca.co.id header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bca.co.id; dmarc=pass header.from=bca.co.id';

test('message text: HTML stripped, entities decoded (also double-encoded)', () => {
  const r = gm.messageFromPayload(gmailMsg({ auth: PASS, html: '<html><head><style>x{}</style></head><body><p>at SHOP &amp;#64;123&nbsp;CA</p><br>Rp1.000</body></html>' }));
  assert.strictEqual(r.domain, 'bca.co.id');
  assert.strictEqual(r.text, 'at SHOP @123 CA\nRp1.000');
});

test('DKIM gate rejects spoofed or unsigned bank mail', () => {
  assert.ok(gm.messageFromPayload(gmailMsg({ auth: PASS })));
  const code = m => { try { gm.messageFromPayload(m); return 'accepted'; } catch (e) { return e.code; } };
  assert.strictEqual(code(gmailMsg({ auth: 'mx.google.com; dkim=fail header.i=@bca.co.id; spf=fail' })), 'dkim_not_pass');
  assert.strictEqual(code(gmailMsg({})), 'dkim_not_pass');
  // dkim=pass but signed by an unrelated domain
  assert.strictEqual(code(gmailMsg({ auth: 'mx.google.com; dkim=pass header.i=@evil.example header.s=x; spf=pass' })), 'dkim_not_pass');
  // pass claimed by a non-Google Authentication-Results header (could be injected upstream)
  assert.strictEqual(code(gmailMsg({ auth: 'evil.example; dkim=pass header.i=@bca.co.id' })), 'dkim_not_pass');
  // lookalike domain
  assert.strictEqual(code(gmailMsg({ from: 'BCA <bca@bca.co.id.evil.example>', auth: 'mx.google.com; dkim=pass header.i=@bca.co.id.evil.example' })), 'not_bank_sender');
  assert.strictEqual(code(gmailMsg({ from: 'x@notbca.co.id', auth: PASS })), 'not_bank_sender');
  // subdomain sender signed by parent domain is fine
  assert.ok(gm.messageFromPayload(gmailMsg({ from: 'BCA <a@info.bca.co.id>', auth: PASS })));
});

test('review regressions: refuse instead of guessing', () => {
  assert.strictEqual(bp.parseAmount('IDR 1,234.56'), null, 'IDR with real cents is refused, not rounded');
  assert.strictEqual(bp.parseAmount('foo 12 Rp 1.000'), null, 'no number picked out of free text');
  assert.strictEqual(bp.parseAmount('IDR 9007199254740993'), null, 'unsafe integer refused');
  assert.strictEqual(bp.parseBodyDate('31/02/2026 12:00 WIB'), null, 'impossible calendar date refused');
  assert.deepStrictEqual([...bp.kv('Nominal: IDR 1,000,000.00')], [['nominal', 'IDR 1,000,000.00']]);
  // foreign currency inside an IDR-only template is not relabelled as IDR
  const f = fx('bca_journal_transfer');
  assert.strictEqual(bp.parse({ ...f, text: f.text.replace('IDR 2,500,000.00', 'USD 150.00') }).reason, 'amount_not_found');
  // Permata without a status line is not accepted
  const q = fx('permata_qr');
  assert.strictEqual(bp.parse({ ...q, text: q.text.replace('Status Transaksi\n: Sukses\n', '') }).reason, 'status_missing');
  // Jago with a malformed body date does not silently fall back to the header date
  const j = fx('jago_transfer');
  assert.strictEqual(bp.parse({ ...j, text: j.text.replace('21 November 2026 20:27 WIB', 'sometime') }).reason, 'date_not_found');
  // oversized input is capped and still handled
  assert.strictEqual(bp.parse({ ...j, text: 'x'.repeat(500000) }).ok, false);
});

test('cross-border QRIS: IDR total with FX cents is rounded, flagged, original amount kept', () => {
  const f = fx('bca_journal_qris');
  const text = f.text.replace('Total Payment\n:\nIDR 185,000.00', 'Amount\n:\nCNY 88.50\nTotal Payment\n:\nIDR 201,234.56');
  const r = bp.parse({ ...f, text });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.amount, 201235);
  assert.strictEqual(r.rounded, true);
  assert.strictEqual(r.originalAmount, 'CNY 88.5');
  assert.ok(r.confidence <= 0.85);
  assert.strictEqual(bp.parseAmount('IDR 1,234.56', '', { roundIdr: true }).value, 1235);
});
