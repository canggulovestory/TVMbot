const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../admin/index.html'), 'utf8');
test('zero money is explicit and differs from missing money', () => {
  const line=html.split('\n').find(line=>line.includes("const money=(a,c='IDR')"));
  const context={}; vm.createContext(context); vm.runInContext(line+';globalThis.format=money',context);
  assert.match(context.format(0), /0/); assert.equal(context.format(undefined),'—');
});
test('upfront rent displays schedule total, not monthly equivalent as annual price', () => {
  const line = html.split('\n').find(line => line.includes('function rentDisplay('));
  assert.ok(line, 'rent display helper exists');
  const context = { state: { villaData: { installments: [{ tenancyId: 't', currency: 'IDR', amount: 14 }, { tenancyId: 't', currency: 'IDR', amount: 266 }] } }, money: n => String(n), esc: s => s };
  vm.createContext(context); vm.runInContext(line, context);
  const display = context.rentDisplay({ id: 't', currency: 'IDR', rentAmount: 23.33, paymentFrequency: 'Upfront' });
  assert.match(display, /280/); assert.match(display, /schedule total/i); assert.match(display, /monthly equivalent/i);
});
test('uncollected deposits have no refund button and gallery follows finance', () => {
  assert.equal(html.includes("x.status!=='Refunded'?`<button class=\"btn sm\" data-refund="), false);
  const detail = html.slice(html.indexOf('<section class="view" id="view-villa-detail">'), html.indexOf('<!-- STAYS -->'));
  assert.ok(detail.indexOf('id="vd-gallery"') > detail.indexOf('id="vd-finance"'));
  assert.match(detail, /<details/);
});
test('automatic finance rows link to editable paid sources', () => {
  const line = html.split('\n').find(line => line.includes('function transactionActions('));
  assert.ok(line);
  const context = { esc: s => s }; vm.createContext(context); vm.runInContext(line, context);
  assert.match(context.transactionActions({sourceId:'payable:BILL-1'}), /data-edit="payables:BILL-1"/);
  assert.match(context.transactionActions({sourceId:'invoice:INV-1'}), /data-edit="invoices:INV-1"/);
  assert.match(context.transactionActions({sourceId:'PAY-1'}), /data-edit="installments:PAY-1"/);
  assert.match(context.transactionActions({id:'TRX-1'}), /data-edit="transactions:TRX-1"/);
});
