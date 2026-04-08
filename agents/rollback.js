/**
 * TVMbot Transaction Rollback Agent
 *
 * Adapted from wshobson/agents "Conductor Plugin" semantic revert concept.
 * Instead of reverting line-by-line, this rolls back an entire logical unit.
 *
 * When finance.js writes to BOTH Staff Sheet AND Internal Sheet,
 * both writes are ONE transaction. If the second write fails,
 * this agent restores the first write to its original state.
 *
 * Works with auditor.js for previous-value storage.
 */

const { google } = require('googleapis');
let auditor;
try { auditor = require('./auditor'); } catch(e) {
  auditor = { logSystem: function() {} }; // stub if auditor not available
}

class TransactionManager {
  constructor() {
    this.sheetsClient = null;
    this.activeTransactions = new Map(); // transactionId → transaction data
    this.stats = {
      started: 0,
      committed: 0,
      rolledBack: 0,
      failed: 0
    };
  }

  /**
   * Initialize with Google Sheets auth client
   */
  init(authClient) {
    if (authClient) {
      this.sheetsClient = google.sheets({ version: 'v4', auth: authClient });
    }
    console.log('[Rollback] Initialized with Sheets auth');
  }

  _getClient() {
    if (this.sheetsClient) return this.sheetsClient;
    try {
      const fs = require('fs');
      const path = require('path');
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/integrations.json'), 'utf8'));
      const s = cfg.sheets || {};
      const auth = new google.auth.OAuth2(s.client_id, s.client_secret, 'https://developers.google.com/oauthplayground');
      auth.setCredentials({ access_token: s.access_token, refresh_token: s.refresh_token });
      this.sheetsClient = google.sheets({ version: 'v4', auth });
      return this.sheetsClient;
    } catch(e) {
      console.error('[Rollback] Auto-auth failed:', e.message);
      return null;
    }
  }

  /**
   * Start a new transaction
   * All writes between begin() and commit() can be rolled back as a unit
   *
   * Returns: transactionId
   */
  beginTransaction(name, triggeredBy) {
    const txId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    this.activeTransactions.set(txId, {
      id: txId,
      name: name || 'unnamed',
      triggeredBy: triggeredBy || 'unknown',
      startedAt: new Date().toISOString(),
      writes: [],        // ordered list of writes that can be undone
      status: 'active'   // active | committed | rolled_back | failed
    });

    this.stats.started++;
    console.log(`[Rollback] Transaction started: ${name} (${txId})`);

    auditor.logSystem({
      event: 'transaction_start',
      details: { transactionId: txId, name },
      status: 'info'
    });

    return txId;
  }

  /**
   * Register a write operation within a transaction
   * Stores the PREVIOUS values so we can restore them on rollback
   *
   * Call this AFTER reading the old values but BEFORE writing new values
   */
  async addWrite(txId, { spreadsheetId, range, previousValues, newValues, sheet }) {
    const tx = this.activeTransactions.get(txId);
    if (!tx) {
      console.error(`[Rollback] Transaction ${txId} not found`);
      return false;
    }
    if (tx.status !== 'active') {
      console.error(`[Rollback] Transaction ${txId} is ${tx.status}, cannot add writes`);
      return false;
    }

    tx.writes.push({
      order: tx.writes.length + 1,
      spreadsheetId,
      sheet: sheet || '',
      range,
      previousValues: previousValues || [],
      newValues: newValues || [],
      writtenAt: new Date().toISOString(),
      rolledBack: false
    });

    console.log(`[Rollback] Write #${tx.writes.length} registered in ${tx.name}: ${range}`);
    return true;
  }

  /**
   * Read current cell values before a write (helper for capturing previous state)
   */
  async captureBeforeValues(spreadsheetId, range) {
    try {
      const response = await this._getClient().spreadsheets.values.get({
        spreadsheetId,
        range
      });
      return response.data.values || [];
    } catch (err) {
      console.error('[Rollback] Failed to capture before-values:', err.message);
      return [];
    }
  }

  /**
   * Commit a transaction — marks all writes as final (no more rollback)
   */
  commitTransaction(txId) {
    const tx = this.activeTransactions.get(txId);
    if (!tx) {
      console.error(`[Rollback] Transaction ${txId} not found`);
      return false;
    }

    tx.status = 'committed';
    tx.committedAt = new Date().toISOString();
    this.stats.committed++;

    auditor.logSystem({
      event: 'transaction_commit',
      details: {
        transactionId: txId,
        name: tx.name,
        writeCount: tx.writes.length
      },
      status: 'success'
    });

    console.log(`[Rollback] Transaction committed: ${tx.name} (${tx.writes.length} writes)`);

    // Clean up after 1 hour (keep for potential late rollback)
    setTimeout(() => {
      this.activeTransactions.delete(txId);
    }, 60 * 60 * 1000);

    return true;
  }

  /**
   * ROLLBACK — undo all writes in a transaction, in reverse order
   * Restores every cell to its previous value
   */
  async rollbackTransaction(txId) {
    const tx = this.activeTransactions.get(txId);
    if (!tx) {
      console.error(`[Rollback] Transaction ${txId} not found`);
      return { success: false, error: 'Transaction not found' };
    }

    if (tx.status === 'rolled_back') {
      return { success: false, error: 'Transaction already rolled back' };
    }

    console.log(`[Rollback] ROLLING BACK: ${tx.name} (${tx.writes.length} writes)`);

    const results = [];
    // Reverse order — undo last write first
    const reversedWrites = [...tx.writes].reverse();

    for (const write of reversedWrites) {
      try {
        if (write.previousValues.length === 0) {
          // Previous was empty — clear the cells
          await this._getClient().spreadsheets.values.clear({
            spreadsheetId: write.spreadsheetId,
            range: write.range
          });
          write.rolledBack = true;
          results.push({ range: write.range, status: 'cleared' });
          console.log(`[Rollback] Cleared: ${write.range}`);
        } else {
          // Restore previous values
          await this._getClient().spreadsheets.values.update({
            spreadsheetId: write.spreadsheetId,
            range: write.range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: write.previousValues }
          });
          write.rolledBack = true;
          results.push({ range: write.range, status: 'restored' });
          console.log(`[Rollback] Restored: ${write.range}`);
        }

        // Log each rollback step
        auditor.logWrite({
          integration: 'rollback',
          action: 'rollback',
          spreadsheetId: write.spreadsheetId,
          sheet: write.sheet,
          range: write.range,
          previousValues: write.newValues,     // what we're removing
          newValues: write.previousValues,      // what we're restoring
          triggeredBy: tx.triggeredBy,
          status: 'success'
        });

      } catch (err) {
        results.push({ range: write.range, status: 'failed', error: err.message });
        console.error(`[Rollback] Failed to rollback ${write.range}:`, err.message);
      }
    }

    tx.status = 'rolled_back';
    tx.rolledBackAt = new Date().toISOString();
    this.stats.rolledBack++;

    const allSuccess = results.every(r => r.status !== 'failed');

    auditor.logSystem({
      event: 'transaction_rollback',
      details: {
        transactionId: txId,
        name: tx.name,
        results,
        fullSuccess: allSuccess
      },
      status: allSuccess ? 'success' : 'partial'
    });

    return {
      success: allSuccess,
      transactionName: tx.name,
      results
    };
  }

  /**
   * Get all active (uncommitted) transactions
   */
  getActiveTransactions() {
    const active = [];
    for (const [id, tx] of this.activeTransactions) {
      if (tx.status === 'active') {
        active.push({
          id: tx.id,
          name: tx.name,
          writeCount: tx.writes.length,
          startedAt: tx.startedAt,
          triggeredBy: tx.triggeredBy
        });
      }
    }
    return active;
  }

  /**
   * Get rollback statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeCount: Array.from(this.activeTransactions.values())
        .filter(tx => tx.status === 'active').length
    };
  }
}

// Export singleton instance
const rollback = new TransactionManager();

  

TransactionManager.prototype.trackToolExecution = function(toolName, toolInput, result, sessionId) {
  try {
    var entry = {
      id: 'exec_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      tool: toolName,
      input: JSON.stringify(toolInput).substring(0, 2000),
      result: JSON.stringify(result).substring(0, 2000),
      sessionId: sessionId || 'unknown',
      timestamp: new Date().toISOString(),
      undoable: ['calendar_create_event','calendar_update_event','sheets_write_data','sheets_append_row','drive_move_file','drive_rename_file','finance_log_payment','finance_log_expense'].indexOf(toolName) >= 0
    };

    if (!this._executionLog) this._executionLog = [];
    this._executionLog.push(entry);
    if (this._executionLog.length > 200) this._executionLog = this._executionLog.slice(-200);
    return entry.id;
  } catch (e) { return null; }
};

TransactionManager.prototype.getRecentUndoable = function(sessionId, limit) {
  limit = limit || 10;
  if (!this._executionLog) return [];
  return this._executionLog
    .filter(function(e) { return e.undoable && (!sessionId || e.sessionId === sessionId); })
    .slice(-limit);
};

module.exports = rollback;
