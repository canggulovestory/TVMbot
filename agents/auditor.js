/**
 * TVMbot Audit Trail Agent
 *
 * Adapted from Edict's "Memorial System" — every action in the imperial court
 * was recorded as a formal memorial with timestamps and full details.
 *
 * Every Google Sheets write is logged with:
 * - What was written and where
 * - What was there before
 * - Which cells were protected (formulas skipped)
 * - Who triggered it (WhatsApp number)
 * - Success or failure status
 *
 * Logs are stored as daily JSON files with 30-day rotation.
 */

const fs = require('fs');
const path = require('path');

class AuditTrail {
  constructor(logDir) {
    this.logDir = logDir || path.join(__dirname, '..', 'logs');
    this.retentionDays = 30;
    this.todayEntries = [];

    // Ensure logs directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    console.log('[Auditor] Initialized, logging to:', this.logDir);
  }

  /**
   * Log a successful write operation
   */
  logWrite({
    integration,     // 'finance' | 'maintenance' | 'periodic-schedule' | 'calendar' | 'gmail'
    action,          // 'write' | 'append' | 'update' | 'delete'
    spreadsheetId,
    sheet,
    range,
    previousValues,  // what was in the cells before
    newValues,       // what we wrote
    skippedCells,    // cells protected from overwrite (formulas)
    triggeredBy,     // WhatsApp number or 'system' or 'cron'
    status           // 'success' | 'partial' | 'failed'
  }) {
    const entry = {
      id: this._generateId(),
      timestamp: new Date().toISOString(),
      integration,
      action,
      target: {
        spreadsheetId: spreadsheetId ? spreadsheetId.substring(0, 10) + '...' : null,
        sheet,
        range
      },
      data: {
        previousValues: previousValues || null,
        newValues: newValues || null,
        skippedCells: skippedCells || []
      },
      triggeredBy: triggeredBy || 'unknown',
      status: status || 'success'
    };

    this.todayEntries.push(entry);
    this._appendToFile(entry);

    const skipCount = entry.data.skippedCells.length;
    console.log(
      `[Auditor] ${status.toUpperCase()} | ${integration}.${action} | ${sheet}!${range}` +
      (skipCount > 0 ? ` | ${skipCount} cells protected` : '')
    );

    return entry.id;
  }

  /**
   * Log a formula protection event (cell was skipped to protect a formula)
   */
  logSkip({ cell, formula, sheet, integration, triggeredBy }) {
    const entry = {
      id: this._generateId(),
      timestamp: new Date().toISOString(),
      integration,
      action: 'skip',
      target: {
        sheet,
        cell
      },
      data: {
        reason: 'formula_protection',
        formula: formula ? formula.substring(0, 50) : 'unknown'
      },
      triggeredBy: triggeredBy || 'unknown',
      status: 'protected'
    };

    this.todayEntries.push(entry);
    this._appendToFile(entry);

    console.log(`[Auditor] PROTECTED | ${cell} in ${sheet} | formula preserved`);
    return entry.id;
  }

  /**
   * Log a system event (bot start, restart, error, etc.)
   */
  logSystem({ event, details, status }) {
    const entry = {
      id: this._generateId(),
      timestamp: new Date().toISOString(),
      integration: 'system',
      action: event,
      target: null,
      data: { details },
      triggeredBy: 'system',
      status: status || 'info'
    };

    this.todayEntries.push(entry);
    this._appendToFile(entry);

    console.log(`[Auditor] SYSTEM | ${event} | ${status}`);
    return entry.id;
  }

  /**
   * Get recent audit entries
   */
  getRecent(count = 20) {
    // First try in-memory entries
    if (this.todayEntries.length >= count) {
      return this.todayEntries.slice(-count).reverse();
    }

    // Fall back to reading from file
    const today = this._getTodayFilename();
    try {
      if (fs.existsSync(today)) {
        const lines = fs.readFileSync(today, 'utf8').trim().split('\n');
        const entries = lines
          .filter(line => line.trim())
          .map(line => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(Boolean);
        return entries.slice(-count).reverse();
      }
    } catch (err) {
      console.error('[Auditor] Failed to read audit log:', err.message);
    }

    return this.todayEntries.slice(-count).reverse();
  }

  /**
   * Get write history for a specific spreadsheet/range
   */
  getHistory(spreadsheetId, range, days = 7) {
    const entries = [];
    const shortId = spreadsheetId ? spreadsheetId.substring(0, 10) + '...' : null;

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const filename = this._getFilenameForDate(date);

      try {
        if (fs.existsSync(filename)) {
          const lines = fs.readFileSync(filename, 'utf8').trim().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              const matchesId = !shortId || (entry.target && entry.target.spreadsheetId === shortId);
              const matchesRange = !range || (entry.target && entry.target.range === range);
              if (matchesId && matchesRange) {
                entries.push(entry);
              }
            } catch { /* skip malformed lines */ }
          }
        }
      } catch (err) {
        console.error(`[Auditor] Failed to read log for day -${i}:`, err.message);
      }
    }

    return entries.reverse();
  }

  /**
   * Get what the bot last changed for a specific integration
   */
  getLastWrite(integration) {
    for (let i = this.todayEntries.length - 1; i >= 0; i--) {
      const entry = this.todayEntries[i];
      if (entry.integration === integration && entry.action !== 'skip') {
        return entry;
      }
    }
    return null;
  }

  /**
   * Get daily summary statistics
   */
  getDailySummary() {
    const writes = this.todayEntries.filter(e => e.action === 'write' || e.action === 'update');
    const skips = this.todayEntries.filter(e => e.action === 'skip');
    const errors = this.todayEntries.filter(e => e.status === 'failed');

    const byIntegration = {};
    for (const entry of this.todayEntries) {
      if (!byIntegration[entry.integration]) {
        byIntegration[entry.integration] = 0;
      }
      byIntegration[entry.integration]++;
    }

    return {
      date: new Date().toISOString().split('T')[0],
      totalEvents: this.todayEntries.length,
      writes: writes.length,
      formulasProtected: skips.length,
      errors: errors.length,
      byIntegration
    };
  }

  /**
   * Clean up old log files (older than retentionDays)
   */
  cleanOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.retentionDays);

      let cleaned = 0;
      for (const file of files) {
        if (!file.startsWith('audit-') || !file.endsWith('.json')) continue;
        const dateStr = file.replace('audit-', '').replace('.json', '');
        const fileDate = new Date(dateStr);
        if (fileDate < cutoff) {
          fs.unlinkSync(path.join(this.logDir, file));
          cleaned++;
        }
      }

      if (cleaned > 0) {
        console.log(`[Auditor] Cleaned ${cleaned} old log files`);
      }
    } catch (err) {
      console.error('[Auditor] Log cleanup failed:', err.message);
    }
  }

  // ── Internal helpers ──

  _appendToFile(entry) {
    try {
      const filename = this._getTodayFilename();
      fs.appendFileSync(filename, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('[Auditor] Failed to write audit log:', err.message);
    }
  }

  _getTodayFilename() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `audit-${date}.json`);
  }

  _getFilenameForDate(date) {
    const dateStr = date.toISOString().split('T')[0];
    return path.join(this.logDir, `audit-${dateStr}.json`);
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }
}

// Export singleton instance
const auditor = new AuditTrail();

  


AuditTrail.prototype.generateDailyDigest = function() {
  try {
    var today = new Date().toISOString().split('T')[0];
    var logFile = require('path').join(this.logDir, 'audit-' + today + '.json');
    var fs = require('fs');

    if (!fs.existsSync(logFile)) {
      return { summary: 'No activity logged today.', insights: [], alertLevel: 'low' };
    }

    var lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    var events = [];
    for (var i = 0; i < lines.length; i++) {
      try { events.push(JSON.parse(lines[i])); } catch(e) {}
    }

    var errorCount = 0, writeCount = 0, skipCount = 0;
    var toolCounts = {};
    for (var j = 0; j < events.length; j++) {
      var ev = events[j];
      if (ev.status === 'error' || ev.status === 'failed') errorCount++;
      if (ev.type === 'write') writeCount++;
      if (ev.type === 'skip') skipCount++;
      if (ev.tool) toolCounts[ev.tool] = (toolCounts[ev.tool] || 0) + 1;
    }

    var insights = [];
    if (errorCount > 5) insights.push('High error rate: ' + errorCount + ' errors today');
    if (writeCount > 20) insights.push('Heavy write day: ' + writeCount + ' sheet writes');
    if (skipCount > 0) insights.push('Validator protected ' + skipCount + ' formula cells');

    var topTools = Object.entries(toolCounts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
    if (topTools.length > 0) {
      insights.push('Top tools: ' + topTools.map(function(t) { return t[0] + '(' + t[1] + ')'; }).join(', '));
    }

    var alertLevel = errorCount > 10 ? 'high' : errorCount > 3 ? 'medium' : 'low';

    return {
      date: today, totalEvents: events.length, writes: writeCount,
      errors: errorCount, protectedCells: skipCount, topTools: topTools,
      insights: insights, alertLevel: alertLevel,
      summary: 'TVMbot Daily Digest (' + today + ')\n' +
               'Total operations: ' + events.length + '\n' +
               'Sheet writes: ' + writeCount + ' | Errors: ' + errorCount + ' | Protected: ' + skipCount + '\n' +
               (insights.length > 0 ? '\nInsights:\n' + insights.join('\n') : '\nAll systems normal')
    };
  } catch (e) {
    return { summary: 'Failed to generate digest: ' + e.message, insights: [], alertLevel: 'unknown' };
  }
};

module.exports = auditor;
