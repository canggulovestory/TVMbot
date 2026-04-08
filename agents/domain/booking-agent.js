/**
 * BookingAgent — Autonomous Booking Lifecycle Handler
 * Triggers: email parser, WhatsApp template, manual dashboard entry
 * Responsibilities: validate → save DB → sync calendar → notify staff → send confirmation
 */
'use strict';

const memory = require('../../memory');
const path = require('path');

class BookingAgent {
  constructor() {
    this.name = 'BookingAgent';
    // Integrations injected by server.js after init
    this.calendar = null;
    this.gmail = null;
    this.whatsapp = null;
    this.sheets = null;
  }

  inject({ calendar, gmail, whatsapp, sheets } = {}) {
    if (calendar) this.calendar = calendar;
    if (gmail)    this.gmail    = gmail;
    if (whatsapp) this.whatsapp = whatsapp;
    if (sheets)   this.sheets   = sheets;
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  async handle(bookingData, opts = {}) {
    const source = opts.source || 'unknown';
    console.log(`[BookingAgent] Handling booking from ${source}:`, bookingData.guest_name, bookingData.villa_name);

    const result = { steps: {}, success: false, errors: [] };

    try {
      // Step 1: Validate
      const validation = this._validate(bookingData);
      result.steps.validate = validation;
      if (!validation.ok) {
        result.errors.push(...validation.errors);
        console.warn('[BookingAgent] Validation failed:', validation.errors);
        return result;
      }

      // Step 2: Save to memory.db — skip if called from executor (already written)
      if (bookingData.fromExecutor) {
        result.steps.db = { action: 'skipped', reason: 'fromExecutor — executor already saved' };
      } else {
        const saved = await this._saveToDb(bookingData);
        result.steps.db = saved;
      }

      // Step 3: Sync to Google Calendar — skip if called from executor (already created)
      if (bookingData.fromExecutor) {
        result.steps.calendar = { action: 'skipped', reason: 'fromExecutor — executor already created event' };
      } else if (this.calendar && bookingData.check_in && bookingData.check_out) {
        result.steps.calendar = await this._syncCalendar(bookingData).catch(e => ({ error: e.message }));
      }

      // Step 4: Notify staff via WhatsApp (MONEY FLOW group)
      if (this.whatsapp) {
        result.steps.whatsapp = await this._notifyStaff(bookingData, source).catch(e => ({ error: e.message }));
      }

      // Step 5: Send guest confirmation email (only for direct bookings with email)
      if (this.gmail && bookingData.guest_email && source === 'direct') {
        result.steps.email = await this._sendConfirmation(bookingData).catch(e => ({ error: e.message }));
      }

      result.success = true;
      console.log(`[BookingAgent] ✓ Completed for ${bookingData.guest_name} @ ${bookingData.villa_name}`);

    } catch (err) {
      result.errors.push(err.message);
      console.error('[BookingAgent] Error:', err.message);
    }

    return result;
  }

  // ── Validation ────────────────────────────────────────────────────────────
  _validate(data) {
    const errors = [];
    if (!data.guest_name || data.guest_name.length < 2) errors.push('Missing guest name');
    if (!data.villa_name) errors.push('Missing villa name');
    if (!data.check_in)   errors.push('Missing check-in date');
    if (!data.check_out)  errors.push('Missing check-out date');
    return { ok: errors.length === 0, errors };
  }

  // ── DB Save ───────────────────────────────────────────────────────────────
  async _saveToDb(data) {
    try {
      const existing = memory.getBookings ? memory.getBookings({ villa_name: data.villa_name }) : [];
      const dup = existing.some(b =>
        b.guest_name === data.guest_name &&
        b.check_in   === data.check_in   &&
        b.villa_name === data.villa_name
      );
      if (dup) return { action: 'skipped', reason: 'duplicate' };
      if (memory.saveBooking) {
        memory.saveBooking({
          guest_name:  data.guest_name  || 'Unknown',
          guest_email: data.guest_email || '',
          villa_name:  data.villa_name  || '',
          check_in:    data.check_in    || '',
          check_out:   data.check_out   || '',
          price:       parseFloat(data.price || data.amount || 0),
          status:      data.status      || 'confirmed',
          notes:       data.notes       || `Logged via BookingAgent (${data.source || 'unknown'})`
        });
        return { action: 'inserted' };
      }
      return { action: 'skipped', reason: 'memory.saveBooking not available' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Calendar Sync ─────────────────────────────────────────────────────────
  async _syncCalendar(data) {
    try {
      const summary = `${data.guest_name} @ ${data.villa_name}`;
      const desc = `Source: ${data.source || 'unknown'}\nGuest: ${data.guest_name}\nAmount: ${data.price || data.amount || 'unknown'}`;
      // calendar.createEvent({ summary, startTime, endTime, description })
      if (this.calendar && this.calendar.createEvent) {
        await this.calendar.createEvent({
          summary,
          startTime: new Date(data.check_in).toISOString(),
          endTime:   new Date(data.check_out).toISOString(),
          description: desc
        });
        return { action: 'created' };
      }
      return { action: 'skipped', reason: 'calendar not available' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Staff Notification ────────────────────────────────────────────────────
  async _notifyStaff(data, source) {
    try {
      const MONEY_FLOW_JID = '120363183761561180@g.us';
      const status = this.whatsapp.getStatus ? this.whatsapp.getStatus() : {};
      if (!status.connected) return { action: 'skipped', reason: 'WA not connected' };

      const amount = data.price || data.amount;
      const amtFmt = amount ? `IDR ${Number(amount).toLocaleString('id-ID')}` : 'TBD';

      const msg = `📋 *New Booking*\n\n`
        + `Guest: ${data.guest_name}\n`
        + `Villa: ${data.villa_name}\n`
        + `In: ${data.check_in}\n`
        + `Out: ${data.check_out}\n`
        + `Amount: ${amtFmt}\n`
        + `Source: ${source}\n`
        + `\n_TVMbot BookingAgent_`;

      await this.whatsapp.sendMessage(MONEY_FLOW_JID, msg);
      return { action: 'sent', group: 'MONEY FLOW' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Guest Email Confirmation ──────────────────────────────────────────────
  async _sendConfirmation(data) {
    try {
      if (!this.gmail || !this.gmail.sendEmail) return { action: 'skipped', reason: 'gmail not available' };
      const subject = `Booking Confirmation — ${data.villa_name}`;
      const body = `Dear ${data.guest_name},\n\n`
        + `Your booking has been confirmed.\n\n`
        + `Villa: ${data.villa_name}\n`
        + `Check-in: ${data.check_in} at 14:00\n`
        + `Check-out: ${data.check_out} at 11:00\n\n`
        + `We look forward to welcoming you.\n\n`
        + `The Villa Managers Team`;
      await this.gmail.sendEmail({ to: data.guest_email, subject, body });
      return { action: 'sent', to: data.guest_email };
    } catch (e) {
      return { error: e.message };
    }
  }
}

module.exports = new BookingAgent();
