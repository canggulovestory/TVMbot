/**
 * event-bus.js — TVMbot Internal Event System
 * Connects EmailWatcher, ProactiveMonitor, and WhatsApp to domain agents.
 * 
 * Events:
 *   booking.received  → BookingAgent.handle
 *   payment.received  → FinanceAgent.handle
 *   maintenance.issue → MaintenanceAgent.handle
 *   report.morning    → ReportAgent.morningBriefing
 *   report.weekly     → ReportAgent.weeklySummary
 */
'use strict';

const EventEmitter = require('events');

class TVMEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    this.stats = {
      booking_received: 0,
      payment_received: 0,
      maintenance_issue: 0,
      report_morning: 0,
      report_weekly: 0,
      errors: 0
    };
    console.log('[EventBus] Initialized');
  }

  // ── Emit helpers with logging ───────────────────────────────────────────
  emitBooking(bookingData, source) {
    this.stats.booking_received++;
    console.log(`[EventBus] → booking.received (${source})`);
    this.emit('booking.received', bookingData, { source });
  }

  emitPayment(paymentData, source) {
    this.stats.payment_received++;
    console.log(`[EventBus] → payment.received (${source})`);
    this.emit('payment.received', paymentData, { source });
  }

  emitMaintenance(issueData, source) {
    this.stats.maintenance_issue++;
    console.log(`[EventBus] → maintenance.issue (${source})`);
    this.emit('maintenance.issue', issueData, { source });
  }

  emitMorningBriefing() {
    this.stats.report_morning++;
    console.log('[EventBus] → report.morning');
    this.emit('report.morning');
  }

  emitWeeklySummary() {
    this.stats.report_weekly++;
    console.log('[EventBus] → report.weekly');
    this.emit('report.weekly');
  }

  getStats() {
    return { ...this.stats, listenerCount: this.eventNames().reduce((s, n) => s + this.listenerCount(n), 0) };
  }
}

// Singleton
const bus = new TVMEventBus();

module.exports = bus;
