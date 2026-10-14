'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('../villa-data');

test('multiple receipts reduce one installment without duplicate income', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-receipts-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  store.init(dir);
  const villa = await store.upsert('villas', {name:'Receipt villa'});
  const payment = await store.upsert('installments', {villaId:villa.id,amount:100000000,currency:'IDR',status:'Scheduled',dueDate:'2026-10-20'});
  const first = await store.recordInstallmentReceipt({id:payment.id,key:'receipt-one',amount:40000000,date:'2026-10-14',paymentMethod:'Bank transfer'});
  assert.equal(first.installment.status,'Partially paid');
  assert.equal((await store.getAll()).installments[0].remainingAmount,60000000);
  await assert.rejects(store.upsert('installments',{id:payment.id,amount:90000000}),/has receipts/);
  await assert.rejects(store.upsert('installments',{id:payment.id,status:'Paid'}),/follows recorded receipts/);
  assert.equal((await store.recordInstallmentReceipt({id:payment.id,key:'receipt-one',amount:40000000,date:'2026-10-14'})).duplicate,true);
  await assert.rejects(store.recordInstallmentReceipt({id:payment.id,key:'receipt-too-large',amount:60000001,date:'2026-10-14'}),/exceeds/);
  await store.recordInstallmentReceipt({id:payment.id,key:'receipt-two',amount:60000000,date:'2026-10-15'});
  const result = await store.getAll();
  assert.equal(result.installments[0].status,'Paid');
  assert.equal(result.installments[0].remainingAmount,0);
  assert.equal(result.transactions.length,2);
  assert.equal(result.transactions.reduce((sum,x)=>sum+x.amount,0),100000000);
  await assert.rejects(store.remove('installments',payment.id),/financial history/);
});
