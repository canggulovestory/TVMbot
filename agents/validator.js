/**
 * TVMbot Pre-Write Validator Agent
 *
 * Adapted from Edict's "Ministry of Scrutiny" — a mandatory review gate
 * that every write operation must pass through before touching Google Sheets.
 *
 * Centralizes all formula protection logic that was previously scattered across:
 * - finance.js (checkRowForFormulas)
 * - periodic-schedule.js (checkCellForFormula)
 * - maintenance.js (had no protection at all)
 *
 * Now every write goes through ONE validator. No integration can bypass it.
 */

const { google } = require('googleapis');

class WriteValidator {
  constructor() {
    this.sheetsClient = null;
    this.formulaCache = new Map(); // Cache formula locations to reduce API calls
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes cache TTL
    this.stats = {
      totalChecks: 0,
      approved: 0,
      rejected: 0,
      formulasProtected: 0,
      formatErrors: 0
    };
  }

  /**
   * Initialize with Google Sheets auth client
   * Call this once at startup with the same auth used by sheets.js
   */
  init(authClient) {
    if (authClient) {
      this.sheetsClient = google.sheets({ version: 'v4', auth: authClient });
    }
    console.log('[Validator] Initialized with Sheets auth');
  }

  _getClient() {
    if (this.sheetsClient) return this.sheetsClient;
    // Auto-initialize from shared sheets config
    try {
      const sheetsIntegration = require('../integrations/sheets');
      const fs = require('fs');
      const path = require('path');
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/integrations.json'), 'utf8'));
      const s = cfg.sheets || {};
      const auth = new google.auth.OAuth2(s.client_id, s.client_secret, 'https://developers.google.com/oauthplayground');
      auth.setCredentials({ access_token: s.access_token, refresh_token: s.refresh_token });
      this.sheetsClient = google.sheets({ version: 'v4', auth });
      return this.sheetsClient;
    } catch(e) {
      console.error('[Validator] Auto-auth failed:', e.message);
      return null;
    }
  }

  /**
   * MASTER VALIDATION — call this before ANY Google Sheets write
   *
   * Returns: {
   *   approved: true/false,
   *   safeRange: 'Sheet!A1:B5',      // range with formula cells removed
   *   safeValues: [[...]],            // values with formula positions nulled out
   *   skippedCells: ['A3 (formula)'], // cells that were protected
   *   errors: ['B5: expected number'] // format validation errors
   * }
   */
  async validateWrite(spreadsheetId, range, values, options = {}) {
    this.stats.totalChecks++;

    const result = {
      approved: false,
      safeRange: range,
      safeValues: values,
      skippedCells: [],
      errors: []
    };

    try {
      // Step 1: Check for formulas in the target range
      const formulaCells = await this.getFormulaCells(spreadsheetId, range);

      if (formulaCells.length > 0) {
        // Step 2: Null out values that would overwrite formulas
        const { cleanedValues, skipped } = this._removeFormulaConflicts(
          range, values, formulaCells
        );
        result.safeValues = cleanedValues;
        result.skippedCells = skipped;
        this.stats.formulasProtected += skipped.length;
      }

      // Step 3: Format validation (if expected types provided)
      if (options.expectedTypes) {
        const formatErrors = this._validateFormats(values, options.expectedTypes);
        result.errors.push(...formatErrors);
        this.stats.formatErrors += formatErrors.length;
      }

      // Step 4: Empty-only check (if enabled — only write to empty cells)
      if (options.emptyOnly) {
        const existingData = await this._getExistingValues(spreadsheetId, range);
        const { cleanedValues, skipped } = this._removeNonEmptyConflicts(
          range, result.safeValues, existingData
        );
        result.safeValues = cleanedValues;
        result.skippedCells.push(...skipped);
      }

      // Final decision
      if (result.errors.length > 0 && !options.allowPartial) {
        result.approved = false;
        this.stats.rejected++;
      } else {
        result.approved = true;
        this.stats.approved++;
      }

    } catch (err) {
      result.approved = false;
      result.errors.push(`Validation failed: ${err.message}`);
      this.stats.rejected++;
    }

    return result;
  }

  /**
   * Get all formula cells in a given range
   * Uses cache to avoid hitting Sheets API every time
   */
  async getFormulaCells(spreadsheetId, range) {
    const cacheKey = `${spreadsheetId}:${range}`;
    const cached = this.formulaCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
      return cached.formulas;
    }

    const formulas = [];

    try {
      // Parse the sheet name and range
      const parsed = this._parseRange(range);

      const response = await this._getClient().spreadsheets.get({
        spreadsheetId,
        ranges: [range],
        includeGridData: true
      });

      const grid = response.data.sheets?.[0]?.data?.[0];
      if (!grid || !grid.rowData) return formulas;

      const startRow = parsed.startRow;
      const startCol = parsed.startCol;

      grid.rowData.forEach((row, rowIdx) => {
        if (!row.values) return;
        row.values.forEach((cell, colIdx) => {
          if (cell.userEnteredValue && cell.userEnteredValue.formulaValue) {
            const cellRef = this._colToLetter(startCol + colIdx) + (startRow + rowIdx);
            formulas.push({
              cell: cellRef,
              row: rowIdx,
              col: colIdx,
              formula: cell.userEnteredValue.formulaValue
            });
          }
        });
      });

      // Cache the result
      this.formulaCache.set(cacheKey, {
        formulas,
        timestamp: Date.now()
      });

    } catch (err) {
      console.error('[Validator] Formula check failed:', err.message);
    }

    return formulas;
  }

  /**
   * Remove values that would conflict with formula cells
   * Returns cleaned values array and list of skipped cells
   */
  _removeFormulaConflicts(range, values, formulaCells) {
    const cleanedValues = values.map(row => [...row]);
    const skipped = [];

    for (const formula of formulaCells) {
      const { row, col, cell } = formula;
      if (cleanedValues[row] && cleanedValues[row][col] !== undefined) {
        const originalValue = cleanedValues[row][col];
        cleanedValues[row][col] = null; // null = skip this cell in the write
        skipped.push(`${cell} (formula: ${formula.formula.substring(0, 30)}..., would have written: "${originalValue}")`);
        console.log(`[Validator] PROTECTED ${cell} — formula preserved`);
      }
    }

    return { cleanedValues, skipped };
  }

  /**
   * Remove values that would overwrite existing non-empty cells
   * Used when emptyOnly option is enabled
   */
  _removeNonEmptyConflicts(range, values, existingData) {
    const parsed = this._parseRange(range);
    const cleanedValues = values.map(row => [...row]);
    const skipped = [];

    if (!existingData) return { cleanedValues, skipped };

    existingData.forEach((existRow, rowIdx) => {
      if (!existRow) return;
      existRow.forEach((existVal, colIdx) => {
        if (existVal && existVal.toString().trim() !== '') {
          if (cleanedValues[rowIdx] && cleanedValues[rowIdx][colIdx] !== undefined) {
            const cellRef = this._colToLetter(parsed.startCol + colIdx) + (parsed.startRow + rowIdx);
            skipped.push(`${cellRef} (not empty: "${existVal}")`);
            cleanedValues[rowIdx][colIdx] = null;
          }
        }
      });
    });

    return { cleanedValues, skipped };
  }

  /**
   * Validate data formats against expected types
   */
  _validateFormats(values, expectedTypes) {
    const errors = [];

    values.forEach((row, rowIdx) => {
      row.forEach((val, colIdx) => {
        if (val === null || val === undefined || val === '') return;

        const expected = expectedTypes[colIdx];
        if (!expected) return;

        switch (expected) {
          case 'number':
            if (isNaN(Number(val))) {
              errors.push(`Row ${rowIdx + 1}, Col ${colIdx + 1}: expected number, got "${val}"`);
            }
            break;
          case 'date':
            if (isNaN(Date.parse(val))) {
              errors.push(`Row ${rowIdx + 1}, Col ${colIdx + 1}: expected date, got "${val}"`);
            }
            break;
          case 'email':
            if (!val.toString().includes('@')) {
              errors.push(`Row ${rowIdx + 1}, Col ${colIdx + 1}: expected email, got "${val}"`);
            }
            break;
          case 'url':
            if (!val.toString().startsWith('http')) {
              errors.push(`Row ${rowIdx + 1}, Col ${colIdx + 1}: expected URL, got "${val}"`);
            }
            break;
        }
      });
    });

    return errors;
  }

  /**
   * Get existing cell values for empty-check comparison
   */
  async _getExistingValues(spreadsheetId, range) {
    try {
      const response = await this._getClient().spreadsheets.values.get({
        spreadsheetId,
        range
      });
      return response.data.values || [];
    } catch (err) {
      console.error('[Validator] Could not read existing values:', err.message);
      return [];
    }
  }

  /**
   * Parse a range string like "Sheet!A5:N45" into components
   */
  _parseRange(range) {
    const match = range.match(/(?:'?([^'!]+)'?!)?([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?/);
    if (!match) return { sheet: '', startCol: 0, startRow: 1, endCol: 0, endRow: 1 };

    return {
      sheet: match[1] || '',
      startCol: this._letterToCol(match[2]),
      startRow: parseInt(match[3]),
      endCol: match[4] ? this._letterToCol(match[4]) : this._letterToCol(match[2]),
      endRow: match[5] ? parseInt(match[5]) : parseInt(match[3])
    };
  }

  /**
   * Convert column letter to zero-based index (A=0, B=1, Z=25, AA=26)
   */
  _letterToCol(letter) {
    let col = 0;
    for (let i = 0; i < letter.length; i++) {
      col = col * 26 + (letter.charCodeAt(i) - 64);
    }
    return col - 1;
  }

  /**
   * Convert zero-based column index to letter (0=A, 1=B, 25=Z, 26=AA)
   */
  _colToLetter(col) {
    let letter = '';
    col += 1;
    while (col > 0) {
      const remainder = (col - 1) % 26;
      letter = String.fromCharCode(65 + remainder) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  }

  /**
   * Clear the formula cache (call after sheet structure changes)
   */
  clearCache() {
    this.formulaCache.clear();
    console.log('[Validator] Formula cache cleared');
  }

  /**
   * Get validation statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalChecks: 0,
      approved: 0,
      rejected: 0,
      formulasProtected: 0,
      formatErrors: 0
    };
  }
}

// Export singleton instance
const validator = new WriteValidator();

  

WriteValidator.prototype.validateEmail = function(toOrParams, subject, body) {
  // Handle both positional args and single object
  var _to, _subject, _body;
  if (toOrParams && typeof toOrParams === 'object' && !Array.isArray(toOrParams)) {
    _to = toOrParams.to || toOrParams.recipient || toOrParams.recipients || '';
    _subject = toOrParams.subject || '';
    _body = toOrParams.body || toOrParams.message || '';
  } else {
    _to = toOrParams || '';
    _subject = subject || '';
    _body = body || '';
  }
  if (Array.isArray(_to)) _to = _to.join(', ');
  _to = String(_to);
  _subject = String(_subject);
  _body = String(_body);

  var errors = [];
  if (!_to || _to.trim() === '') errors.push('Missing recipient');
  if (!_subject || _subject.trim() === '') errors.push('Missing subject');
  if (!_body || _body.trim().length < 5) errors.push('Email body too short');
  if (_to && _to.trim() !== '' && !/^[^@]+@[^@]+\.[^@]+$/.test(_to.trim())) errors.push('Invalid email format: ' + _to);
  return { approved: errors.length === 0, errors: errors };
};

WriteValidator.prototype.validateCalendarEvent = function(event) {
  if (!event || typeof event !== 'object') return { approved: false, errors: ['Missing event data'] };
  var errors = [];
  var title = event.summary || event.title || event.name || '';
  var start = event.start || event.startTime || event.startDateTime || event.date || null;
  var end = event.end || event.endTime || event.endDateTime || null;
  if (!title || String(title).trim() === '') errors.push('Missing event title');
  if (!start) errors.push('Missing start date/time');
  if (!end) {
    // Auto-set end to 1 hour after start if only start provided
    if (start) { end = new Date(new Date(start).getTime() + 3600000).toISOString(); }
    else { errors.push('Missing end date/time'); }
  }
  if (start && end && new Date(start) >= new Date(end)) errors.push('End time must be after start time');
  return { approved: errors.length === 0, errors: errors };
};

WriteValidator.prototype.validateFinancial = function(operationOrParams, amount, currency) {
  // Handle both positional args and single object
  var _amount, _operation, _currency;
  if (operationOrParams && typeof operationOrParams === 'object' && !Array.isArray(operationOrParams)) {
    _amount = operationOrParams.amount || operationOrParams.value || operationOrParams.total;
    _operation = operationOrParams.operation || operationOrParams.type || 'unknown';
    _currency = operationOrParams.currency || 'IDR';
  } else {
    _operation = operationOrParams || 'unknown';
    _amount = amount;
    _currency = currency || 'IDR';
  }
  if (typeof _amount === 'string') _amount = parseFloat(_amount);

  var errors = [];
  if (_amount === undefined || _amount === null || isNaN(_amount)) errors.push('Missing or invalid amount');
  if (typeof _amount === 'number' && _amount <= 0) errors.push('Amount must be positive: ' + _amount);
  if (typeof _amount === 'number' && _amount > 500000000) errors.push('Amount unreasonably large: ' + _amount);
  return { approved: errors.length === 0, errors: errors };
};

WriteValidator.prototype.validateWhatsApp = function(jidOrParams, message) {
  var _jid, _message;
  if (jidOrParams && typeof jidOrParams === 'object' && !Array.isArray(jidOrParams)) {
    _jid = jidOrParams.to || jidOrParams.jid || jidOrParams.recipient || '';
    _message = jidOrParams.message || jidOrParams.text || jidOrParams.body || '';
  } else {
    _jid = jidOrParams || '';
    _message = message || '';
  }
  _jid = String(_jid);
  _message = String(_message);

  var errors = [];
  if (!_jid || _jid.trim() === '') errors.push('Missing recipient JID');
  if (!_message || _message.trim() === '') errors.push('Empty message');
  if (_message.length > 4000) errors.push('Message too long (' + _message.length + ' chars)');
  return { approved: errors.length === 0, errors: errors };
};

module.exports = validator;
