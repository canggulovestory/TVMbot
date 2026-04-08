/**
 * FinanceAgent — Autonomous Payment & Transaction Handler
 * Triggers: EmailWatcher payment, manual log-expense, bank notification
 * Responsibilities: match to booking → log SQLite → log Sheets → notify MONEY FLOW
 */
'use strict';

const memory = require('../../memory');

const MONEY_FLOW_JID = '120363183761561180@g.us';

class FinanceAgent {
  constructor() {
    this.name = 'FinanceAgent';
    this.whatsapp = null;
    this.sheets    = null;
  }

  inject({ whatsapp, sheets } = {}) {
    if (whatsapp) this.whatsapp = whatsapp;
    if (sheets)   this.sheets   = sheets;
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  async handle(paymentData, opts = {}) {
    const source = opts.source || 'unknown';
    console.log(`[FinanceAgent] Handling payment from ${source}:`, paymentData.amount, paymentData.currency);

    const result = { steps: {}, success: false, errors: [] };

    try {
      // Step 1: Match to booking
      const match = this._matchToBooking(paymentData);
      result.steps.match = match;
      if (match.booking_id) paymentData.booking_id = match.booking_id;

      // Step 2: Log to SQLite — skip if called from executor (already logged)
      if (paymentData.fromExecutor) {
        result.steps.sqlite = { action: 'skipped', reason: 'fromExecutor — executor already logged' };
      } else {
        result.steps.sqlite = await this._logToSQLite(paymentData, source);
      }

      // Step 3: Log to Google Sheets — skip if called from executor (already logged)
      if (paymentData.fromExecutor) {
        result.steps.sheets = { action: 'skipped', reason: 'fromExecutor — executor already logged to sheets' };
      } else if (this.sheets) {
        result.steps.sheets = await this._logToSheets(paymentData, source).catch(e => ({ error: e.message }));
      }

      // Step 4: Notify MONEY FLOW group
      if (this.whatsapp) {
        result.steps.whatsapp = await this._notifyMoneyFlow(paymentData, match, source).catch(e => ({ error: e.message }));
      }

      // Step 5: Update invoice status if matched
      if (match.booking_id && memory.updateBookingStatus) {
        memory.updateBookingStatus(match.booking_id, 'paid');
        result.steps.invoice_status = { updated: true };
      }

      result.success = true;
      console.log(`[FinanceAgent] ✓ Processed: ${paymentData.currency} ${paymentData.amount} from ${paymentData.guest_name || 'unknown'}`);

    } catch (err) {
      result.errors.push(err.message);
      console.error('[FinanceAgent] Error:', err.message);
    }

    return result;
  }

  // ── Booking Match ─────────────────────────────────────────────────────────
  _matchToBooking(payment) {
    try {
      if (!memory.getBookings) return { matched: false };
      const bookings = memory.getBookings({ status: 'confirmed' }) || [];
      // Try to match by guest name or villa + amount proximity
      const match = bookings.find(b => {
        if (payment.guest_name && b.guest_name &&
            b.guest_name.toLowerCase().includes(payment.guest_name.toLowerCase().split(' ')[0])) {
          return true;
        }
        if (payment.villa_name && b.villa_name &&
            b.villa_name.toLowerCase().includes((payment.villa_name || '').toLowerCase().replace(/^villa\s*/i, ''))) {
          const priceDiff = Math.abs((b.price || 0) - (payment.amount || 0));
          return priceDiff < (b.price || 1) * 0.1; // Within 10% of booking price
        }
        return false;
      });
      if (match) return { matched: true, booking_id: match.id, guest_name: match.guest_name, villa_name: match.villa_name };
      return { matched: false };
    } catch (e) {
      return { matched: false, error: e.message };
    }
  }

  // ── SQLite Log ────────────────────────────────────────────────────────────
  async _logToSQLite(data, source) {
    try {
      if (!memory.logTransaction) return { action: 'skipped', reason: 'logTransaction not available' };
      // Check for duplicate
      const existing = memory.getTransactions ? memory.getTransactions({ date: data.date }) : [];
      const isDup = existing.some(t =>
        Math.abs((parseFloat(t.amount) || 0) - (parseFloat(data.amount) || 0)) < 1 &&
        (t.reference || '') === (data.booking_ref || data.reference || '')
      );
      if (isDup) return { action: 'skipped', reason: 'duplicate' };

      memory.logTransaction({
        type:        'income',
        category:    data.category || `${data.source || source} payment`,
        description: data.description || `Payment from ${data.guest_name || 'unknown'}`,
        amount:      parseFloat(data.amount || 0),
        currency:    data.currency || 'IDR',
        villa_name:  data.villa_name || '',
        guest_name:  data.guest_name || '',
        date:        data.date || new Date().toISOString().slice(0, 10),
        status:      'paid',
        reference:   data.booking_ref || data.reference || ''
      });
      return { action: 'inserted' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Sheets Log ────────────────────────────────────────────────────────────
  async _logToSheets(data, source) {
    try {
      if (!this.sheets || !this.sheets.appendRow) return { action: 'skipped' };
      const PAYMENTS_SHEET_ID = '1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4';
      const now = new Date();
      const dateStr = `${now.getDate().toString().padStart(2,'0')}/${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getFullYear()}`;
      const row = [
        dateStr,
        data.source || source,
        data.guest_name || '',
        data.villa_name || '',
        parseFloat(data.amount || 0),
        data.currency || 'IDR',
        data.booking_ref || '',
        `FinanceAgent — ${source}`
      ];
      await this.sheets.appendRow(PAYMENTS_SHEET_ID, 'PAYMENTS_RECEIVED', row);
      return { action: 'appended' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── MONEY FLOW Notification ───────────────────────────────────────────────
  async _notifyMoneyFlow(data, match, source) {
    try {
      const status = this.whatsapp.getStatus ? this.whatsapp.getStatus() : {};
      if (!status.connected) return { action: 'skipped', reason: 'WA not connected' };

      const amt = data.amount ? `${data.currency || 'IDR'} ${Number(data.amount).toLocaleString('id-ID')}` : 'unknown amount';
      let msg = `💰 *Payment Received*\n\n`;
      msg += `Amount: ${amt}\n`;
      if (data.guest_name)  msg += `From: ${data.guest_name}\n`;
      if (data.villa_name)  msg += `Villa: ${data.villa_name}\n`;
      if (data.source)      msg += `Via: ${data.source}\n`;
      if (match.matched)    msg += `Booking: ✓ matched (${match.guest_name})\n`;
      else                  msg += `Booking: unmatched — verify manually\n`;
      msg += `\n_TVMbot FinanceAgent_`;

      await this.whatsapp.sendMessage(MONEY_FLOW_JID, msg);
      return { action: 'sent', group: 'MONEY FLOW' };
    } catch (e) {
      return { error: e.message };
    }
  }
}

module.exports = new FinanceAgent();
