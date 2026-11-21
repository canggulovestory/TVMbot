'use strict';
// Synthetic data only. Fakes for Gmail + finance; the real parser is replaced by a table of parser results.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bi = require('../bank-ingest');

const NOW = Date.parse('2026-11-21T12:00:00Z');
const ACCOUNTS = [
  { id: 'acc_bca', name: 'BCA', currency: 'IDR' }, { id: 'acc_cash', name: 'LinkAI card', currency: 'IDR' },
  { id: 'acc_cimb', name: 'CIMB Niaga', currency: 'IDR' }, { id: 'acc_permata', name: 'Permata', currency: 'IDR' },
];
const tx = o => ({ ok: true, currency: 'IDR', fee: 0, reference: '', internal: false, secondary: false, confidence: 0.95, date: '2026-11-21', direction: 'out', kind: 'transfer', ...o });

function setup(table, { failPrepare } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-ingest-'));
  const stateFile = path.join(dir, 'state.json');
  const calls = { prepare: [], read: 0, messageIds: [] };
  const deps = {
    gmail: {
      async listIds() { return Object.keys(table); },
      async getText(id) {
        if (table[id] === 'dkim') { const e = new Error('dkim_not_pass'); e.code = 'dkim_not_pass'; throw e; }
        return { id, domain: 'x', subject: 's', date: '', internalDate: NOW - 3600e3, text: '' };
      },
    },
    parse: msg => table[msg.id],
    finance: messageId => {
      assert.ok(Number.isSafeInteger(messageId) && messageId > 1e9);
      calls.messageIds.push(messageId);
      return {
        async finance_read(a) { calls.read++; assert.strictEqual(a.resource, 'accounts'); return { items: ACCOUNTS }; },
        async finance_prepare(a) {
          calls.prepare.push({ messageId, intent: a.intent });
          if (failPrepare) return { ok: false, error: 'Financial service unavailable. No other provider was contacted.' };
          return { proposalId: `p${calls.prepare.length}`, confirmationUrl: `https://financial-ten-inky.vercel.app/?financeProposal=p${calls.prepare.length}` };
        },
      };
    },
    stateFile, now: () => NOW,
  };
  return { ingest: bi.createIngest(deps), calls, stateFile };
}

const TABLE = {
  m_jago: tx({ bank: 'jago', accountHint: 'acc_jago', counterparty: 'Tokopedia', amount: 150000 }),
  m_permata: tx({ bank: 'permata', accountHint: 'acc_permata', direction: 'in', counterparty: 'Guest A', amount: 2000000, reference: 'REF0001' }),
  m_cimb: tx({ bank: 'cimb', accountHint: 'acc_cimb', counterparty: 'Supplier B', amount: 500000 }),
  m_cc: tx({ bank: 'bca', accountHint: 'bca_credit_card', kind: 'card', counterparty: 'Tokopedia', amount: 75000 }),
  m_ovo: tx({ bank: 'ovo', accountHint: 'acc_ovo', kind: 'payment', counterparty: 'Warung C', amount: 20000 }),
  m_internal: tx({ bank: 'permata', accountHint: 'acc_permata', counterparty: 'Afni', amount: 1000000, internal: true }),
  m_pocket: tx({ bank: 'jago', accountHint: 'acc_jago', counterparty: 'Pocket', amount: 150000, secondary: true, confidence: 0.6 }),
  m_usd: tx({ bank: 'bca', accountHint: 'bca_credit_card', kind: 'card', currency: 'USD', amount: 12.5, counterparty: 'Netflix', confidence: 0.7 }),
  m_low: tx({ bank: 'jago', accountHint: 'acc_jago', counterparty: 'Someone', amount: 10000, confidence: 0.75 }),
  m_unknown: { ok: false, reason: 'unknown_template' },
  m_promo: { ok: false, reason: 'not_transaction' },
  m_acct: tx({ bank: 'bca', accountHint: 'acc_bca', counterparty: 'Budi 1234567890', amount: 300000, fee: 2500, reference: 'REF123456789012' }),
  m_dkim: 'dkim',
};

test('rule mapping: Permata, CIMB, CIMB-via notes for Jago/credit card/OVO, never LinkAI card', async () => {
  const { ingest, calls } = setup(TABLE);
  const r = await ingest.run({ since: '2026-11-21' });
  const by = Object.fromEntries(calls.prepare.map(c => [c.intent.description.split(' – ')[0] + '|' + c.intent.amount, c.intent]));
  assert.strictEqual(by['CIMB Niaga (via Jago)|150000'].accountId, 'acc_cimb');
  assert.strictEqual(by['CIMB Niaga (via Jago)|150000'].description, 'CIMB Niaga (via Jago) – transfer to Tokopedia');
  assert.strictEqual(by['CIMB Niaga (via BCA credit card)|75000'].description, 'CIMB Niaga (via BCA credit card) – Tokopedia');
  assert.strictEqual(by['CIMB Niaga (via OVO)|20000'].accountId, 'acc_cimb');
  assert.strictEqual(by['Permata|2000000'].accountId, 'acc_permata');
  assert.strictEqual(by['Permata|2000000'].kind, 'income');
  assert.strictEqual(by['CIMB Niaga|500000'].accountId, 'acc_cimb');
  assert.strictEqual(by['CIMB Niaga|500000'].kind, 'expense');
  assert.ok(calls.prepare.every(c => c.intent.accountId !== 'acc_cash'));
  assert.ok(calls.prepare.every(c => c.intent.currency === 'IDR' && /^\d+$/.test(c.intent.amount)));
  assert.strictEqual(r.prepared.length, 6);
  // fee included in an outgoing amount
  assert.strictEqual(by['CIMB Niaga (via BCA)|302500'].description, 'CIMB Niaga (via BCA) – transfer to Budi (incl. 2,500 fee)');
});

test('internal skipped and counted; secondary silent; foreign listed; low/unknown need check', async () => {
  const { ingest, calls } = setup(TABLE);
  const r = await ingest.run({ since: '2026-11-21' });
  assert.strictEqual(r.ownTransfers.length, 1);
  assert.strictEqual(r.counts.secondary, 1);
  assert.strictEqual(r.foreign.length, 1);
  assert.strictEqual(r.needsCheck.length, 2);
  assert.strictEqual(r.counts.ignored, 1);
  assert.strictEqual(r.counts.rejected, 1);
  assert.ok(!calls.prepare.some(c => /Netflix|Afni|Pocket|Someone/.test(c.intent.description)));
  const s = bi.buildSummary(r);
  assert.match(s, /Own transfers skipped: 1/);
  assert.match(s, /Needs manual entry \(foreign currency\): 1/);
  assert.match(s, /Needs check: 2/);
  assert.match(s, /CIMB Niaga \(via BCA credit card\) · out USD 12\.5 · Netflix/);
  assert.doesNotMatch(s, /Pocket/);
});

test('dedupe on rerun (gmail id) and on bank reference', async () => {
  const { ingest, calls, stateFile } = setup(TABLE);
  await ingest.run({ since: '2026-11-21' });
  const n = calls.prepare.length;
  const r2 = await ingest.run({ since: '2026-11-21' });
  assert.strictEqual(calls.prepare.length, n);
  assert.strictEqual(r2.prepared.length, 0);
  assert.strictEqual((fs.statSync(stateFile).mode & 0o777), 0o600);
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(!JSON.stringify(st).includes('REF0001'), 'references stored hashed only');

  const t2 = { a: tx({ bank: 'permata', counterparty: 'X', amount: 100, reference: 'R9' }), b: tx({ bank: 'permata', counterparty: 'X', amount: 100, reference: 'R9' }) };
  const s2 = setup(t2);
  const r3 = await s2.ingest.run({ since: '2026-11-21' });
  assert.strictEqual(s2.calls.prepare.length, 1);
  assert.strictEqual(r3.counts.duplicateRef, 1);
});

test('unique message ids per prepare; deterministic per gmail id', async () => {
  const { ingest, calls } = setup(TABLE);
  await ingest.run({ since: '2026-11-21' });
  const ids = calls.prepare.map(c => c.messageId);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => Number.isSafeInteger(id) && id >= 2 ** 52));
  assert.strictEqual(bi.messageIdFor('abc', new Set()), bi.messageIdFor('abc', new Set()));
});

test('failed prepare is not marked processed and is retried', async () => {
  const t = { a: tx({ bank: 'jago', counterparty: 'Shop', amount: 5000 }) };
  const s = setup(t, { failPrepare: true });
  const r = await s.ingest.run({ since: '2026-11-21' });
  assert.strictEqual(r.failed.length, 1);
  await s.ingest.run({ since: '2026-11-21' });
  assert.strictEqual(s.calls.prepare.length, 2);
  assert.strictEqual(s.calls.prepare[0].messageId, s.calls.prepare[1].messageId, 'same sourceRequestId on retry');
});

test('summary has no account numbers or references, lists links, caps at 25', async () => {
  const { ingest } = setup(TABLE);
  const r = await ingest.run({ since: '2026-11-21' });
  const s = bi.buildSummary(r);
  assert.doesNotMatch(s, /1234567890|REF123456789012|REF0001/);
  assert.match(s, /1\. 21 Nov · .* → https:\/\/financial-ten-inky\.vercel\.app\/\?financeProposal=p\d/);
  assert.match(s, /CIMB Niaga \(via Jago\) · out 150,000 · Tokopedia →/);

  const many = {};
  for (let i = 0; i < 30; i++) many['m' + i] = tx({ bank: 'jago', counterparty: 'Shop ' + i, amount: 1000 + i });
  const s2 = setup(many);
  const text = bi.buildSummary(await s2.ingest.run({ since: '2026-11-21' }));
  assert.match(text, /^25\. /m);
  assert.doesNotMatch(text, /^26\. /m);
  assert.match(text, /and 5 more on the website/);
});

test('dryRun makes zero finance_prepare calls and leaves state untouched', async () => {
  const { ingest, calls, stateFile } = setup(TABLE);
  const r = await ingest.run({ since: '2026-11-21', dryRun: true });
  assert.strictEqual(calls.prepare.length, 0);
  assert.strictEqual(r.prepared.length, 6);
  assert.ok(!fs.existsSync(stateFile));
  assert.match(bi.buildSummary(r), /test run/);
});

test('scrub removes account-like numbers but keeps names', () => {
  assert.strictEqual(bi.scrub('Budi 1234567890'), 'Budi');
  assert.strictEqual(bi.scrub('PT Maju 1234-5678-9012'), 'PT Maju');
  assert.strictEqual(bi.scrub('Tokopedia'), 'Tokopedia');
});

test('codex review: doubtful own transfer, bad fields and LinkAI hint go to needs check; string amounts add up', async () => {
  const t = {
    a: tx({ bank: 'jago', counterparty: 'Afni', amount: 1000, internal: true, confidence: 0.75 }),
    b: tx({ bank: 'jago', counterparty: 'X', amount: 1000, direction: 'sideways' }),
    c: tx({ bank: 'jago', counterparty: 'X', amount: 1000, date: '2026-02-31' }),
    d: tx({ bank: 'bca', accountHint: 'linkai_card', counterparty: 'X', amount: 1000 }),
    e: tx({ bank: 'permata', counterparty: 'Y', amount: '10000', fee: '500', reference: 'AB12CD34' }),
  };
  const s = setup(t);
  const r = await s.ingest.run({ since: '2026-11-21' });
  assert.strictEqual(r.ownTransfers.length, 0);
  assert.strictEqual(r.needsCheck.length, 4);
  assert.strictEqual(s.calls.prepare.length, 1);
  assert.strictEqual(s.calls.prepare[0].intent.amount, '10500');
});

test('exact reference is stripped from the description; concurrent run is refused', async () => {
  const t = { a: tx({ bank: 'permata', counterparty: 'Shop AB12CD34', amount: 100, reference: 'AB12CD34' }) };
  const s = setup(t);
  fs.writeFileSync(s.stateFile + '.lock', '1');
  await assert.rejects(s.ingest.run({ since: '2026-11-21' }), /already running/);
  fs.rmSync(s.stateFile + '.lock');
  await s.ingest.run({ since: '2026-11-21' });
  assert.strictEqual(s.calls.prepare[0].intent.description, 'Permata – transfer to Shop');
});
