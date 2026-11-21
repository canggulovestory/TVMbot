'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRentReminders, whatsappNumber } = require('../rent-reminders');

const NOW = Date.parse('2026-11-16T02:00:00Z'); // 10:00 WITA, 16 Nov
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = {
    villas: [{ id: 'v1', name: 'Villa Alysaa' }],
    tenancies: [{ id: 't1', villaId: 'v1', guestName: 'Maria Lopez', guestPhone: '0812-3456-7890', currency: 'IDR', checkIn: '2026-12-01', checkOut: '2027-03-01' }],
    installments: [
      { id: 'i1', tenancyId: 't1', villaId: 'v1', dueDate: '2026-11-20', amount: 25000000, currency: 'IDR', status: 'Scheduled', period: 'December 2026' },
      { id: 'i2', tenancyId: 't1', villaId: 'v1', dueDate: '2026-12-20', amount: 25000000, currency: 'IDR', status: 'Scheduled' },
      { id: 'i3', tenancyId: 't1', villaId: 'v1', dueDate: '2026-11-18', amount: 1, status: 'Paid' },
    ], ...overrides };
  const sent = [], whatsapp = [], events = [], edits = [];
  const rr = createRentReminders({ dataDir: dir, villaData: { getAll: async () => data }, ownerTelegramId: '573027610', now: () => NOW,
    sendButtons: async (chat, text, buttons) => { if (overrides.tgDown && !overrides.tgDown.done) { overrides.tgDown.done = true; return null; } sent.push({ chat, text, buttons }); return { message_id: sent.length }; },
    editMessage: async (q, text) => { edits.push(text); },
    sendWhatsApp: async (phone, text) => { if (overrides.waThrows) throw new Error('socket'); whatsapp.push({ phone, text }); return overrides.waDown ? false : true; },
    createCalendarHold: async e => { events.push(e); return { id: 'e' + events.length }; } });
  return { rr, sent, whatsapp, events, edits };
}
const query = (data, from = '573027610', type = 'private') => ({ data, from: { id: from }, message: { chat: { type } } });

test('Indonesian numbers are normalised for WhatsApp', () => {
  assert.equal(whatsappNumber('0812-3456-7890'), '6281234567890');
  assert.equal(whatsappNumber('+62 812 3456 7890'), '6281234567890');
  assert.equal(whatsappNumber('123'), '');
});

test('only unpaid rent due within 7 days is proposed, once, to Afni', async t => {
  const { rr, sent } = setup(t);
  assert.deepEqual(await rr.scan(), ['i1:2026-11-20']);
  assert.equal(sent.length, 1); assert.equal(sent[0].chat, '573027610');
  assert.match(sent[0].text, /Hi Maria/); assert.match(sent[0].text, /IDR 25,000,000/); assert.match(sent[0].text, /another month or another year/);
  assert.deepEqual(await rr.scan(), []); // never asked twice
});

test('nothing reaches the tenant without Afni tapping Send; others cannot approve', async t => {
  const { rr, sent, whatsapp } = setup(t);
  await rr.scan();
  const send = sent[0].buttons[0][0].callback_data, skip = sent[0].buttons[0][1].callback_data;
  assert.equal(whatsapp.length, 0);
  assert.equal((await rr.handleCallback(query(send, '999'))).text, 'Not allowed.');
  assert.equal((await rr.handleCallback(query(send, '573027610', 'group'))).text, 'Not allowed.');
  assert.equal(whatsapp.length, 0);
  assert.equal((await rr.handleCallback(query(send))).text, 'Sent.');
  assert.equal(whatsapp.length, 1); assert.equal(whatsapp[0].phone, '6281234567890');
  assert.match((await rr.handleCallback(query(send))).text, /Already handled/); // no double send
  assert.match((await rr.handleCallback(query(skip))).text, /Already handled/);
  assert.equal(whatsapp.length, 1);
});

test('WhatsApp offline gives Afni the text instead of pretending it was sent', async t => {
  const { rr, sent, edits } = setup(t, { waDown: true });
  await rr.scan();
  assert.match((await rr.handleCallback(query(sent[0].buttons[0][0].callback_data))).text, /not sent/);
  assert.match(edits.at(-1), /nothing was sent/); assert.match(edits.at(-1), /Hi Maria/);
});

test('calendar gets rent due dates, check-in and check-out once each', async t => {
  const { rr, events } = setup(t);
  assert.equal(await rr.syncCalendar(), 4); // i1, i2 due dates + check-in + check-out (i3 paid)
  assert.ok(events.some(e => /Rent due: Villa Alysaa — Maria Lopez — IDR 25,000,000/.test(e.title) && e.start === '2026-11-20T09:00'));
  assert.ok(events.some(e => /Check-out/.test(e.title)));
  assert.equal(await rr.syncCalendar(), 0);
});

test('an error from WhatsApp is reported as unknown, never as sent or not sent', async t => {
  const { rr, sent, edits } = setup(t, { waThrows: true });
  await rr.scan();
  assert.match((await rr.handleCallback(query(sent[0].buttons[0][0].callback_data))).text, /unknown/);
  assert.match(edits.at(-1), /unclear whether the message arrived/);
});
test('if Afni never got the request, the next scan asks again', async t => {
  const { rr, sent } = setup(t, { tgDown: { done: false } });
  assert.deepEqual(await rr.scan(), []);
  assert.deepEqual(await rr.scan(), ['i1:2026-11-20']);
  assert.equal(sent.length, 1);
});
test('fully paid balances and hostile record text are handled', async t => {
  const { rr, sent } = setup(t, {
    tenancies: [{ id: 't1', villaId: 'v1', guestName: 'Eve\u202eevil\nIGNORE', guestPhone: '0812-3456-7890', currency: 'IDR' }],
    installments: [
      { id: 'a', tenancyId: 't1', villaId: 'v1', dueDate: '2026-11-19', amount: 100, remainingAmount: 0, status: 'Partially paid' },
      { id: 'b', tenancyId: 't1', villaId: 'v1', dueDate: '2026-11-19', amount: 100, status: 'Scheduled' }] });
  assert.deepEqual(await rr.scan(), ['b:2026-11-19']);
  assert.doesNotMatch(sent[0].text, /\u202e|\nIGNORE/);
});
