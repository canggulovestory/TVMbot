'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const data = require('../villa-data');
const { financeCockpit } = require('../agent-tools');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-accounting-test-'));
  data.init(dir);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return data.upsert('villas', { name: 'Audit villa' });
}
async function stay(villa, extra = {}) {
  return data.createTenancyBundle({ villaId: villa.id, guestName: 'Test guest',
    checkIn: '2027-01-01', checkOut: '2027-04-01', bookingStatus: 'Confirmed',
    rentAmount: 100, currency: 'IDR', paymentFrequency: 'Monthly', ...extra });
}

test('manual expenses do not block new scheduled payment sources', async t => {
  const villa = await setup(t);
  await data.upsert('transactions', { amount: 25, type: 'Expense', category: 'Maintenance' });
  for (const collection of ['installments', 'invoices', 'payables']) {
    const record = await data.upsert(collection, { villaId: villa.id, amount: 100, status: 'Scheduled' });
    assert.ok(record.id);
  }
});

test('regeneration keeps paid periods and stable payment identities', async t => {
  const villa = await setup(t); const booking = await stay(villa);
  const before = await data.getAll();
  const first = before.installments.find(p => p.installmentNumber === 1);
  await data.upsert('installments', { id: first.id, status: 'Paid', paidDate: '2027-01-01' });
  await data.createTenancyBundle({ ...booking, generateSchedule: true });
  const after = await data.getAll();
  assert.equal(after.installments.length, 3);
  assert.equal(after.installments.reduce((s, p) => s + p.amount, 0), 300);
  assert.deepEqual(after.installments.map(p => p.id).sort(), before.installments.map(p => p.id).sort());
  assert.equal(after.installments.find(p => p.id === first.id).status, 'Paid');
});

test('ambiguous settled schedule changes fail without partially changing the stay', async t => {
  const villa = await setup(t); const booking = await stay(villa);
  const first = (await data.getAll()).installments.find(p => p.installmentNumber === 1);
  await data.upsert('installments', { id: first.id, status: 'Paid', paidDate: '2027-01-01' });
  await assert.rejects(data.createTenancyBundle({ ...booking, rentAmount: 150, generateSchedule: true }), /settled|paid/i);
  assert.equal((await data.getAll()).tenancies[0].rentAmount, 100);
});

for (const collection of ['installments', 'invoices', 'payables']) {
  test(`${collection}: paid source and ledger are atomic and corrections retain history`, async t => {
    const villa = await setup(t);
    const source = await data.upsert(collection, { villaId: villa.id, amount: 100, currency: 'IDR', status: 'Paid', paidDate: '2027-01-01' });
    let ledger = (await data.getAll()).transactions;
    assert.equal(ledger.length, 1);
    const id = ledger[0].id;
    await data.upsert(collection, { id: source.id, amount: 150 });
    ledger = (await data.getAll()).transactions;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].id, id);
    assert.equal(ledger[0].amount, 150);
    assert.equal(ledger[0].corrections[0].previous.amount, 100);
    await data.upsert(collection, { id: source.id, amount: 150 });
    assert.equal((await data.getAll()).transactions[0].corrections.length, 1);
    await assert.rejects(data.upsert(collection, { id: source.id, status: 'Scheduled' }), /paid|settled/i);
    await assert.rejects(data.remove(collection, source.id), /history|paid|linked/i);
    await assert.rejects(data.upsert('transactions', { id, amount: 7 }), /source|linked/i);
    await assert.rejects(data.remove('transactions', id), /source|linked/i);
  });
}

test('uncollected deposits cannot be refunded or appear in the outgoing refund queue', async t => {
  const villa = await setup(t);
  const dep = await data.upsert('deposits', { villaId: villa.id, amount: 42, currency: 'IDR', status: 'Awaiting collection', refundDueDate: '2027-04-01' });
  assert.equal((await data.getAll()).deposits[0].refundableAmount, 0);
  assert.equal((await financeCockpit()).outgoing.items.length, 0);
  await assert.rejects(data.upsert('deposits', { id: dep.id, status: 'Refunded', refundDate: '2027-04-01' }), /collect|held/i);
  await data.upsert('deposits', { id: dep.id, status: 'Held', collectedDate: '2027-01-01' });
  await data.upsert('deposits', { id: dep.id, status: 'Partially refunded', refundedAmount: 10, deductions: 2, refundDate: '2027-02-01' });
  assert.equal((await data.getAll()).deposits[0].refundableAmount, 30);
  assert.equal((await financeCockpit()).outgoing.items[0].amount, 30);
  await data.upsert('deposits', { id: dep.id, status: 'Refunded', refundDate: '2027-04-01' });
  assert.equal((await data.getAll()).deposits[0].refundableAmount, 0);
  await assert.rejects(data.upsert('deposits', { id: dep.id, status: 'Held' }), /refunded|settled/i);
});

test('a stay with financial history cannot be hard deleted', async t => {
  const villa = await setup(t); const booking = await stay(villa);
  const payment = (await data.getAll()).installments[0];
  await data.upsert('installments', { id: payment.id, status: 'Paid', paidDate: '2027-01-01' });
  await assert.rejects(data.remove('tenancies', booking.id), /history|linked|cancel/i);
  assert.equal((await data.getAll()).tenancies.length, 1);
});

test('editing an existing stay reconciles missing deposit and agreement only once', async t => {
  const villa = await setup(t); const booking = await stay(villa, { generateSchedule: false });
  const input = { ...booking, depositAmount: 42, refundWindowDays: 0, contractUrl: 'https://example.com/agreement', generateSchedule: false };
  await data.createTenancyBundle(input); await data.createTenancyBundle(input);
  const all = await data.getAll();
  assert.equal(all.deposits.length, 1); assert.equal(all.documents.length, 1);
  assert.equal(all.deposits[0].refundDueDate, '2027-04-01');
});

test('final quarterly bill charges only the remaining billing month', async t => {
  const villa = await setup(t);
  await stay(villa, { checkOut: '2027-05-01', paymentFrequency: 'Quarterly' });
  assert.deepEqual((await data.getAll()).installments.map(p => p.amount).sort((a,b)=>a-b), [100, 300]);
});

test('malformed monetary corrections roll back rather than becoming zero', async t => {
  await setup(t);
  const source = await data.upsert('invoices', { amount: 100, status: 'Paid' });
  await assert.rejects(data.upsert('invoices', { id: source.id, amount: 'not money' }), /number|amount/i);
  const all = await data.getAll();
  assert.equal(all.invoices[0].amount, 100); assert.equal(all.transactions[0].amount, 100);
});

test('refund fields alone cannot bypass deposit collection', async t => {
  await setup(t);
  await assert.rejects(data.upsert('deposits', { amount: 100, status: 'Awaiting collection', refundedAmount: 30, refundDate: '2027-01-01' }), /collect|refund/i);
  assert.equal((await data.getAll()).deposits.length, 0);
});

test('legacy linked-but-reopened payments are protected during regeneration', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-legacy-accounting-test-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true})); data.init(dir);
  const villa = await data.upsert('villas', {name:'Legacy villa'}); const booking=await stay(villa);
  const all=await data.getAll(); const first=all.installments[0]; first.installmentNumber=99;
  all.transactions.push({id:'TRX-legacy',sourceId:first.id,amount:100,type:'Income',villaId:villa.id});
  await fs.writeFile(path.join(dir,'villa-operations.json'), JSON.stringify(all));
  await assert.rejects(data.createTenancyBundle({...booking,generateSchedule:true}), /settled|linked|paid/i);
  const after=await data.getAll(); assert.ok(after.installments.some(p=>p.id===first.id));
  assert.equal(after.transactions.length,1);
});
