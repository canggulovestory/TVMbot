'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const villaData = require('../villa-data');
const { financeCockpit } = require('../agent-tools');

test('financial cockpit separates what TVM collects from what it pays', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuzu-finance-'));
  villaData.init(dir);
  await villaData.upsert('installments', { code: 'RENT-1', amount: 100, currency: 'USD', dueDate: '2026-09-02', followUpDate: '2026-08-26', status: 'Scheduled' });
  await villaData.upsert('payables', { vendorName: 'Cleaner', category: 'Cleaning', amount: 50, currency: 'USD', dueDate: '2026-09-03', status: 'Scheduled' });
  const cockpit = await financeCockpit();
  assert.equal(cockpit.incoming.items[0].source, 'installment');
  assert.equal(cockpit.incoming.items[0].dueDate, '2026-09-02');
  assert.equal(cockpit.incoming.items[0].followUpDate, '2026-08-26');
  assert.equal(cockpit.outgoing.items[0].category, 'Cleaning');
  await fs.rm(dir, { recursive: true, force: true });
});
