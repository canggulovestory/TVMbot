/**
 * ReportAgent — Autonomous Report Generator
 * Triggers: 7am morning cron, owner request, weekly summary cron
 * Responsibilities: compile metrics → format message → deliver via WhatsApp / email
 */
'use strict';

const memory = require('../../memory');

const TVM_MGMT_JID = '120363195152959079@g.us';

class ReportAgent {
  constructor() {
    this.name = 'ReportAgent';
    this.whatsapp = null;
    this.gmail    = null;
    this._lastBriefing = null;
  }

  inject({ whatsapp, gmail } = {}) {
    if (whatsapp) this.whatsapp = whatsapp;
    if (gmail)    this.gmail    = gmail;
  }

  // ── Morning Briefing ──────────────────────────────────────────────────────
  async morningBriefing() {
    const today = new Date().toISOString().slice(0, 10);
    // Debounce: only once per day
    if (this._lastBriefing === today) {
      return { action: 'skipped', reason: 'already sent today' };
    }

    console.log('[ReportAgent] Generating morning briefing...');
    const result = { steps: {}, success: false };

    try {
      const data = this._gatherBriefingData();
      result.steps.data = { ok: true, ...data };

      const msg = this._formatBriefing(data, today);

      // Send to TVM Management group
      if (this.whatsapp) {
        const status = this.whatsapp.getStatus ? this.whatsapp.getStatus() : {};
        if (status.connected) {
          await this.whatsapp.sendMessage(TVM_MGMT_JID, msg);
          result.steps.whatsapp = { action: 'sent', group: 'TVM Management' };
          this._lastBriefing = today;
        } else {
          result.steps.whatsapp = { action: 'skipped', reason: 'WA not connected' };
        }
      }

      result.success = true;
    } catch (err) {
      result.error = err.message;
      console.error('[ReportAgent] Morning briefing error:', err.message);
    }

    return result;
  }

  // ── Weekly Summary ────────────────────────────────────────────────────────
  async weeklySummary() {
    console.log('[ReportAgent] Generating weekly summary...');
    const result = { steps: {}, success: false };

    try {
      const now = new Date();
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const today = now.toISOString().slice(0, 10);

      // Gather weekly data
      let bookings = [], transactions = [], tasks = [];
      try { bookings = (memory.getBookings ? memory.getBookings({}) : []).filter(b => b.created_at >= weekAgo); } catch(e) {}
      try { transactions = (memory.getTransactions ? memory.getTransactions({}) : []).filter(t => t.date >= weekAgo && t.type === 'income'); } catch(e) {}
      try { tasks = (memory.getMaintenanceTasks ? memory.getMaintenanceTasks({ status: 'completed' }) : []).filter(t => t.created_at >= weekAgo); } catch(e) {}

      const revenue = transactions.reduce((s, t) => s + parseFloat(t.amount || 0), 0);

      const msg = `📊 *Weekly Summary — TVMbot*\n`
        + `Week: ${weekAgo} → ${today}\n\n`
        + `Bookings: ${bookings.length} new\n`
        + `Revenue: IDR ${revenue.toLocaleString('id-ID')}\n`
        + `Tasks completed: ${tasks.length}\n\n`
        + `_TVMbot ReportAgent_`;

      if (this.whatsapp) {
        const status = this.whatsapp.getStatus ? this.whatsapp.getStatus() : {};
        if (status.connected) {
          await this.whatsapp.sendMessage(TVM_MGMT_JID, msg);
          result.steps.whatsapp = { action: 'sent' };
        }
      }

      result.success = true;
    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  // ── Data Gathering ────────────────────────────────────────────────────────
  _gatherBriefingData() {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const data = { checkins: [], checkouts: [], overdue: [], tasks: [], alerts: [] };

    try {
      const allBookings = memory.getBookings ? memory.getBookings({}) : [];
      data.checkins  = allBookings.filter(b => b.check_in  && b.check_in.startsWith(today));
      data.checkouts = allBookings.filter(b => b.check_out && b.check_out.startsWith(today));
      data.tomorrowCheckins = allBookings.filter(b => b.check_in && b.check_in.startsWith(tomorrow));
    } catch(e) {}

    try {
      data.overdue = memory.getOutstandingPayments ? memory.getOutstandingPayments() : [];
    } catch(e) {}

    try {
      const allTasks = memory.getMaintenanceTasks ? memory.getMaintenanceTasks({ status: 'open' }) : [];
      data.tasks = allTasks.slice(0, 5);
    } catch(e) {}

    try {
      const db = memory.db;
      if (db) {
        const rows = db.prepare("SELECT * FROM monitor_alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT 5").all();
        data.alerts = rows || [];
      }
    } catch(e) {}

    return data;
  }

  // ── Format Briefing ───────────────────────────────────────────────────────
  _formatBriefing(data, today) {
    const lines = [`☀️ *Morning Briefing — ${today}*\n`];

    if (data.checkins.length > 0) {
      lines.push(`📥 Check-ins today (${data.checkins.length}):`);
      data.checkins.forEach(b => lines.push(`  • ${b.guest_name} @ ${b.villa_name}`));
    } else {
      lines.push('📥 No check-ins today');
    }

    if (data.checkouts.length > 0) {
      lines.push(`\n📤 Check-outs today (${data.checkouts.length}):`);
      data.checkouts.forEach(b => lines.push(`  • ${b.guest_name} @ ${b.villa_name}`));
    }

    if (data.tomorrowCheckins && data.tomorrowCheckins.length > 0) {
      lines.push(`\n🔜 Tomorrow's check-ins (${data.tomorrowCheckins.length}):`);
      data.tomorrowCheckins.forEach(b => lines.push(`  • ${b.guest_name} @ ${b.villa_name}`));
    }

    if (data.overdue && data.overdue.length > 0) {
      lines.push(`\n⚠️ Overdue payments (${data.overdue.length}):`);
      data.overdue.slice(0, 3).forEach(p => lines.push(`  • ${p.guest_name || 'Unknown'} — IDR ${Number(p.amount || 0).toLocaleString('id-ID')}`));
    }

    if (data.tasks && data.tasks.length > 0) {
      lines.push(`\n🔧 Open tasks (${data.tasks.length}):`);
      data.tasks.slice(0, 3).forEach(t => lines.push(`  • [${t.priority || 'med'}] ${t.title}`));
    }

    if (data.alerts && data.alerts.length > 0) {
      lines.push(`\n🚨 System alerts (${data.alerts.length}) — check dashboard`);
    }

    lines.push('\n_TVMbot ReportAgent_');
    return lines.join('\n');
  }
}

module.exports = new ReportAgent();
