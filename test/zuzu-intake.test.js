'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveDraft } = require('../zuzu-intake');

test('contract draft keeps extracted contract values as review candidates', () => {
  const draft = deriveDraft('villa-lease-agreement.pdf', `
    TENANCY AGREEMENT
    Tenant: Jane Doe
    Commencement date: 01 January 2026
    Expiry date: 2026-12-31
    Monthly rent: IDR 25,000,000
    Security deposit: IDR 25,000,000
    First payment due: 2026-01-01
  `);
  assert.equal(draft.suggestedType, 'Contract');
  assert.equal(draft.contract.guestNameCandidate, 'Jane Doe');
  assert.equal(draft.contract.startDate, '2026-01-01');
  assert.equal(draft.contract.endDate, '2026-12-31');
  assert.equal(draft.contract.rentCandidate, 'IDR 25,000,000');
  assert.equal(draft.contract.depositCandidate, 'IDR 25,000,000');
  assert.equal(draft.contract.suggestedFollowUpDate, '2025-12-25');
  assert.equal(draft.contract.confidence, 'Review required');
});
