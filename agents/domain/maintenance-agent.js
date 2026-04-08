/**
 * MaintenanceAgent — Autonomous Maintenance Request Handler
 * Triggers: WhatsApp report, ProactiveMonitor overdue alert, manual entry
 * Responsibilities: classify severity → save task → notify PIC → schedule follow-up
 */
'use strict';

const memory = require('../../memory');

// Villa → PIC mapping (matches villas.md)
const VILLA_PIC = {
  'ALYSSA':   { maintenance: 'Syifa',  housekeeping: 'Dewi' },
  'ANN':      { maintenance: 'Syifa',  housekeeping: 'Wati' },
  'DIANE':    { maintenance: 'Syifa',  housekeeping: 'Sari' },
  'LIAN':     { maintenance: 'Bayu',   housekeeping: 'Rina' },
  'LOUNA':    { maintenance: 'Bayu',   housekeeping: 'Rina' },
  'LOURINKA': { maintenance: 'Syifa',  housekeeping: 'Dewi' },
  'LYSA':     { maintenance: 'Bayu',   housekeeping: 'Sari' },
  'NISSA':    { maintenance: 'Syifa',  housekeeping: 'Wati' },
};

// Severity classification keywords
const SEVERITY_KEYWORDS = {
  critical: ['flood', 'fire', 'no water', 'no power', 'no electricity', 'leak', 'broken pipe', 'emergency', 'darurat', 'banjir', 'kebakaran'],
  high:     ['AC broken', 'AC not working', 'pool broken', 'wifi down', 'toilet blocked', 'no hot water', 'lock broken', 'gate broken'],
  medium:   ['AC weak', 'pool dirty', 'light broken', 'drain slow', 'noise', 'crack', 'stain', 'rusty'],
  low:      ['needs cleaning', 'light bulb', 'minor', 'cosmetic', 'touch up', 'replace']
};

const MAINTENANCE_TVM_JID = '120363395350990428@g.us';

class MaintenanceAgent {
  constructor() {
    this.name = 'MaintenanceAgent';
    this.whatsapp = null;
  }

  inject({ whatsapp } = {}) {
    if (whatsapp) this.whatsapp = whatsapp;
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  async handle(issueData, opts = {}) {
    const source = opts.source || 'manual';
    console.log(`[MaintenanceAgent] Handling issue from ${source}:`, issueData.title);

    const result = { steps: {}, success: false, errors: [] };

    try {
      // Step 1: Classify severity
      const severity = this._classifySeverity(issueData.title + ' ' + (issueData.description || ''));
      issueData.severity = issueData.severity || severity;
      result.steps.classify = { severity };

      // Step 2: Save to DB — skip if called from executor (already written to Sheets + SQLite)
      if (issueData.fromExecutor) {
        result.steps.db = { action: 'skipped', reason: 'fromExecutor — executor already saved to Sheets + SQLite' };
      } else {
        result.steps.db = await this._saveTask(issueData, source);
      }

      // Step 3: Identify PIC
      const pic = this._getPIC(issueData.villa_name);
      result.steps.pic = { assigned: pic || 'Unknown' };

      // Step 4: Notify Maintenance TVM group
      if (this.whatsapp) {
        result.steps.whatsapp = await this._notifyMaintenance(issueData, pic).catch(e => ({ error: e.message }));
      }

      // Step 5: If critical — also notify owner
      if (issueData.severity === 'critical' && this.whatsapp) {
        result.steps.owner_alert = await this._notifyOwner(issueData).catch(e => ({ error: e.message }));
      }

      result.success = true;
      console.log(`[MaintenanceAgent] ✓ Processed: ${issueData.title} (${issueData.severity})`);

    } catch (err) {
      result.errors.push(err.message);
      console.error('[MaintenanceAgent] Error:', err.message);
    }

    return result;
  }

  // ── Severity Classification ───────────────────────────────────────────────
  _classifySeverity(text) {
    const lower = text.toLowerCase();
    for (const [level, keywords] of Object.entries(SEVERITY_KEYWORDS)) {
      if (keywords.some(k => lower.includes(k.toLowerCase()))) return level;
    }
    return 'medium';
  }

  // ── PIC Lookup ────────────────────────────────────────────────────────────
  _getPIC(villaName) {
    if (!villaName) return null;
    const key = villaName.replace(/^villa\s*/i, '').toUpperCase().trim();
    return VILLA_PIC[key] ? VILLA_PIC[key].maintenance : null;
  }

  // ── Save Task to DB ───────────────────────────────────────────────────────
  async _saveTask(data, source) {
    try {
      if (memory.saveMaintenanceTask) {
        memory.saveMaintenanceTask({
          title:       data.title       || 'Untitled Issue',
          description: data.description || '',
          villa_name:  data.villa_name  || '',
          status:      data.status      || 'open',
          priority:    data.severity    || 'medium',
          assigned_to: this._getPIC(data.villa_name) || '',
          reported_by: data.reported_by || source,
          notes:       `Auto-assigned by MaintenanceAgent on ${new Date().toISOString().slice(0,10)}`
        });
        return { action: 'inserted' };
      }
      return { action: 'skipped', reason: 'saveMaintenanceTask not available' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Notify Maintenance TVM ────────────────────────────────────────────────
  async _notifyMaintenance(data, pic) {
    try {
      const status = this.whatsapp.getStatus ? this.whatsapp.getStatus() : {};
      if (!status.connected) return { action: 'skipped', reason: 'WA not connected' };

      const severityEmoji = { critical: '🚨', high: '⚠️', medium: '🔧', low: '📝' };
      const emoji = severityEmoji[data.severity] || '🔧';

      const msg = `${emoji} *Maintenance Request*\n\n`
        + `Villa: ${data.villa_name || 'Unknown'}\n`
        + `Issue: ${data.title}\n`
        + `Severity: ${(data.severity || 'medium').toUpperCase()}\n`
        + (data.description ? `Details: ${data.description}\n` : '')
        + (pic ? `Assigned: ${pic}\n` : '')
        + `\n_TVMbot MaintenanceAgent_`;

      await this.whatsapp.sendMessage(MAINTENANCE_TVM_JID, msg);
      return { action: 'sent', group: 'Maintenance TVM' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Owner Alert (critical only) ───────────────────────────────────────────
  async _notifyOwner(data) {
    try {
      const status = this.whatsapp.getStatus ? this.whatsapp.getStatus() : {};
      if (!status.connected) return { action: 'skipped' };
      // TVM Management group JID
      const TVM_MGMT_JID = '120363195152959079@g.us';
      const msg = `🚨 *CRITICAL MAINTENANCE ALERT*\n\n`
        + `Villa: ${data.villa_name}\n`
        + `Issue: ${data.title}\n`
        + (data.description ? `Details: ${data.description}\n` : '')
        + `\nImmediate attention required.\n\n_TVMbot_`;
      await this.whatsapp.sendMessage(TVM_MGMT_JID, msg);
      return { action: 'sent', group: 'TVM Management' };
    } catch (e) {
      return { error: e.message };
    }
  }
}

module.exports = new MaintenanceAgent();
