'use strict';
/**
 * rent-reminders.js — 7 days before a rent installment is due, prepare a WhatsApp reminder for the
 * tenant and ask Afni to approve it in Telegram (Send / Skip). Nothing reaches a tenant without her tap.
 * Also mirrors rent due dates, check-ins, check-outs into the TVM Google Calendar (created once per item).
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const REMIND_DAYS = 7;
const CALENDAR_DAYS = 120;
const MAX_EVENTS_PER_RUN = 25;
const DAY = 86400000;

function witaToday(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
function daysBetween(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY); }
function whatsappNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '62' + digits.slice(1); // Indonesian local format
  return digits.length >= 9 && digits.length <= 15 ? digits : '';
}
// Record fields are shown to Afni and sent to tenants: strip control characters and cap length.
const safe = (value, max = 60) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (currency, amount) => `${currency || 'IDR'} ${Number(amount || 0).toLocaleString('en-US')}`;

function reminderText({ tenancy, villa, installment }) {
  const first = safe(tenancy.guestName, 40).split(' ')[0] || 'there';
  const due = new Date(installment.dueDate + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const amount = installment.remainingAmount ?? installment.amount;
  return `Hi ${first}, a friendly reminder from The Villa Managers: your rent for ${safe(villa?.name) || 'the villa'}${installment.period ? ` (${safe(installment.period, 40)})` : ''} of ${money(safe(installment.currency || tenancy.currency, 5), amount)} is due on ${due}.\n\nWill you be extending your stay for another month or another year? Just reply here and we'll arrange it. Thank you!`;
}

function createRentReminders({ dataDir, villaData, sendButtons, editMessage, sendWhatsApp, createCalendarHold, ownerTelegramId, now = () => Date.now() }) {
  const file = path.join(dataDir, 'rent-reminders.json');
  let queue = Promise.resolve();
  async function read() {
    try { return { reminders: {}, calendar: {}, ...JSON.parse(await fs.readFile(file, 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return { reminders: {}, calendar: {} }; throw error; }
  }
  function mutate(work) {
    const task = queue.then(async () => {
      const store = await read();
      const result = await work(store);
      await fs.writeFile(file + '.tmp', JSON.stringify(store, null, 2), { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }

  /** Find installments due within 7 days and ask Afni once per installment+due date. */
  async function scan() {
    const data = await villaData.getAll();
    const today = witaToday(now());
    const villas = new Map(data.villas.map(v => [v.id, v]));
    const tenancies = new Map(data.tenancies.map(t => [t.id, t]));
    const created = [];
    for (const installment of data.installments) {
      if (['Paid'].includes(installment.status) || !installment.dueDate) continue;
      const left = daysBetween(today, installment.dueDate);
      if (left < 0 || left > REMIND_DAYS) continue;
      const tenancy = tenancies.get(installment.tenancyId);
      if (!tenancy || ['Cancelled', 'Canceled'].includes(tenancy.bookingStatus)) continue;
      if (!(Number(installment.remainingAmount ?? installment.amount) > 0)) continue; // nothing left to pay
      const key = `${installment.id}:${installment.dueDate}`;
      const phone = whatsappNumber(tenancy.guestPhone);
      const text = reminderText({ tenancy, villa: villas.get(installment.villaId || tenancy.villaId), installment });
      const record = await mutate(store => {
        if (store.reminders[key] && store.reminders[key].status !== 'prompt_failed') return null;
        const item = { key, installmentId: installment.id, tenant: tenancy.guestName || '', phone, text, status: phone ? 'pending' : 'no_phone', token: crypto.randomBytes(12).toString('hex'), createdAt: new Date(now()).toISOString() };
        store.reminders[key] = item;
        return item;
      });
      if (!record) continue;
      const header = `RENT REMINDER — ${safe(villas.get(installment.villaId || tenancy.villaId)?.name) || 'villa'}\nTenant: ${safe(record.tenant) || '?'} · ${phone ? '+' + phone : 'NO PHONE NUMBER'}\nDue: ${installment.dueDate} (in ${left} day${left === 1 ? '' : 's'})\n\nMessage to send:\n\n${text}`;
      const buttons = phone ? [[{ text: 'Send via WhatsApp', callback_data: `rr:${record.token}:send` }, { text: 'Skip', callback_data: `rr:${record.token}:skip` }]] : [];
      let sent = null;
      try { sent = await sendButtons(ownerTelegramId, phone ? header : header + '\n\nAdd the tenant phone number in TVM to send this.', buttons); } catch (_) { sent = null; }
      // If Afni never got the approval request, keep it retryable on the next scan.
      await mutate(store => { if (sent?.message_id) store.reminders[key].telegramMessageId = sent.message_id; else store.reminders[key].status = 'prompt_failed'; });
      if (!sent?.message_id) continue;
      created.push(record.key);
    }
    return created;
  }

  /** Afni taps Send / Skip. Only her, only in her private chat, only a pending reminder. */
  async function handleCallback(query) {
    const match = /^rr:([a-f0-9]{24}):(send|skip)$/.exec(query.data || '');
    if (!match) return { handled: false };
    if (String(query.from?.id) !== String(ownerTelegramId) || query.message?.chat?.type !== 'private') return { handled: true, text: 'Not allowed.' };
    const claimed = await mutate(store => {
      const item = Object.values(store.reminders).find(r => r.token === match[1]);
      if (!item || item.status !== 'pending') return null;
      item.status = match[2] === 'send' ? 'sending' : 'skipped';
      item.decidedAt = new Date(now()).toISOString();
      return { ...item };
    });
    if (!claimed) return { handled: true, text: 'Already handled or expired.' };
    if (match[2] === 'skip') { await editMessage?.(query, 'Skipped. Nothing was sent.'); return { handled: true, text: 'Skipped.' }; }
    // false = WhatsApp offline, definitely not sent; an exception = outcome unknown, never claim either way.
    let outcome;
    try { outcome = (await sendWhatsApp(claimed.phone, claimed.text)) ? 'sent' : 'not_sent'; } catch (_) { outcome = 'unknown'; }
    await mutate(store => { store.reminders[claimed.key].status = outcome; store.reminders[claimed.key].sentAt = outcome === 'sent' ? new Date(now()).toISOString() : null; });
    const notes = {
      sent: `Sent to ${safe(claimed.tenant)} via WhatsApp.`,
      not_sent: `WhatsApp is not connected, so nothing was sent. Send this yourself to +${claimed.phone}:\n\n${claimed.text}`,
      unknown: `WhatsApp gave an error; it is unclear whether the message arrived. Check the WhatsApp chat with +${claimed.phone} before sending again.`,
    };
    await editMessage?.(query, notes[outcome]);
    return { handled: true, text: { sent: 'Sent.', not_sent: 'WhatsApp offline — not sent.', unknown: 'Delivery unknown — check WhatsApp.' }[outcome] };
  }

  /** Mirror upcoming rent due dates, check-ins and check-outs into Google Calendar, once each. */
  async function syncCalendar() {
    const data = await villaData.getAll();
    const today = witaToday(now());
    const villas = new Map(data.villas.map(v => [v.id, v]));
    const tenancies = new Map(data.tenancies.map(t => [t.id, t]));
    const items = [];
    const inRange = date => date && daysBetween(today, date) >= 0 && daysBetween(today, date) <= CALENDAR_DAYS;
    for (const i of data.installments) {
      if (i.status === 'Paid' || !inRange(i.dueDate)) continue;
      const t = tenancies.get(i.tenancyId) || {};
      items.push({ key: `rent:${i.id}:${i.dueDate}`, date: i.dueDate, title: `Rent due: ${villas.get(i.villaId || t.villaId)?.name || 'villa'} — ${t.guestName || 'tenant'} — ${money(i.currency || t.currency, i.amount)}` });
    }
    for (const t of data.tenancies) {
      if (['Cancelled', 'Canceled'].includes(t.bookingStatus)) continue;
      const name = `${villas.get(t.villaId)?.name || 'villa'} — ${t.guestName || 'tenant'}`;
      if (inRange(t.checkIn)) items.push({ key: `in:${t.id}:${t.checkIn}`, date: t.checkIn, title: `Check-in: ${name}` });
      if (inRange(t.checkOut)) items.push({ key: `out:${t.id}:${t.checkOut}`, date: t.checkOut, title: `Check-out / contract end: ${name}` });
    }
    const existing = (await read()).calendar;
    let made = 0;
    for (const item of items) {
      if (existing[item.key] || made >= MAX_EVENTS_PER_RUN) continue;
      // Mark before calling Google: a crash in between leaves 'pending' (checked by hand), never a duplicate event.
      await mutate(store => { store.calendar[item.key] = { eventId: '', pending: true, at: new Date(now()).toISOString() }; });
      const event = await createCalendarHold({ title: item.title, start: `${item.date}T09:00`, end: `${item.date}T09:30`, description: 'Added by Zuzu from TVM villa records.' });
      await mutate(store => { store.calendar[item.key] = { eventId: event?.id || '', at: new Date(now()).toISOString() }; });
      made++;
    }
    return made;
  }

  return { scan, handleCallback, syncCalendar };
}

module.exports = { createRentReminders, reminderText, whatsappNumber };
