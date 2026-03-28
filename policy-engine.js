/**
 * policy-engine.js — Guidance & Policy Engine for TVMbot
 * Inspired by ruflo's Guidance module (compiler, gates, ledger, optimizer)
 *
 * Enforces business rules that MUST be followed regardless of AI reasoning:
 *   - Data protection (never write to read-only sheets)
 *   - Approval gates (large expenses need confirmation)
 *   - Mandatory fields (maintenance must have PIC, priority)
 *   - Business logic (no double bookings, check-in after 2pm)
 *   - Division boundaries (correct sheet per division)
 *   - Escalation rules (when to alert management)
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'policy-engine.db');
let db;
try {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (e) {
  db = new Database(':memory:');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS policy_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    action TEXT NOT NULL,
    context TEXT,
    result TEXT NOT NULL,
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS policy_overrides (
    policy_id TEXT PRIMARY KEY,
    overridden_by TEXT,
    reason TEXT,
    expires_at TEXT,
    created_at TEXT
  );
`);

// ─── POLICY DEFINITIONS ─────────────────────────────────────────────────────

const POLICIES = {
  // ═══ DATA PROTECTION ═══════════════════════════════════════════
  'data:readonly-sheets': {
    name: 'Read-Only Sheet Protection',
    description: 'Never write to the Internal/Owner Sheet (auto-calculated formulas)',
    severity: 'CRITICAL',
    check: (context) => {
      const readOnlyIds = ['1Whlirq']; // Internal/Owner Sheet prefix
      if (context.toolName && context.toolName.includes('write') || context.toolName?.includes('append') || context.toolName?.includes('update')) {
        if (context.args?.spreadsheetId && readOnlyIds.some(id => context.args.spreadsheetId.startsWith(id))) {
          return { pass: false, message: 'BLOCKED: Cannot write to Internal/Owner Sheet — it contains auto-calculated formulas. Write to Staff Sheet or Expenses Sheet instead.' };
        }
      }
      return { pass: true };
    },
  },

  'data:no-bulk-delete': {
    name: 'Bulk Delete Prevention',
    description: 'Prevent deletion of more than 5 rows at once without explicit confirmation',
    severity: 'HIGH',
    check: (context) => {
      if (context.toolName?.includes('delete') || context.toolName?.includes('clear')) {
        const rowCount = context.args?.rowCount || context.args?.range?.match(/\d+:\d+/);
        if (rowCount && parseInt(rowCount) > 5) {
          return { pass: false, message: 'BLOCKED: Bulk deletion of more than 5 rows requires explicit user confirmation. Ask the user to confirm.' };
        }
      }
      return { pass: true };
    },
  },

  // ═══ BOOKING RULES ═════════════════════════════════════════════
  'booking:no-overlap': {
    name: 'No Double Bookings',
    description: 'Always check calendar before creating a booking',
    severity: 'CRITICAL',
    check: (context) => {
      if (context.intent === 'booking' && context.action === 'create') {
        if (!context.calendarChecked) {
          return { pass: false, message: 'POLICY: Must check villa calendar for conflicts BEFORE creating any booking.' };
        }
      }
      return { pass: true };
    },
  },

  'booking:checkin-time': {
    name: 'Check-in/Check-out Times',
    description: 'Check-in after 2 PM, check-out before 11 AM',
    severity: 'MEDIUM',
    inject: () => 'Standard check-in time is 2:00 PM (14:00) and check-out is 11:00 AM (11:00). Mention this to guests when discussing bookings.',
  },

  'booking:minimum-stay': {
    name: 'Minimum Stay Requirement',
    description: 'Minimum 2-night stay for all villas',
    severity: 'MEDIUM',
    inject: () => 'Minimum stay is 2 nights for all villas. For high season (Jul-Aug, Dec-Jan), minimum is 3 nights.',
  },

  // ═══ FINANCE RULES ═════════════════════════════════════════════
  'finance:large-expense-confirm': {
    name: 'Large Expense Confirmation',
    description: 'Expenses over IDR 5,000,000 need explicit approval mention',
    severity: 'HIGH',
    check: (context) => {
      if (context.intent === 'finance' && context.action === 'log_expense') {
        const amount = context.args?.amount || 0;
        if (amount > 5000000) {
          return { pass: true, warning: `Large expense: IDR ${amount.toLocaleString()}. Ask user to confirm approval before logging.` };
        }
      }
      return { pass: true };
    },
  },

  'finance:correct-sheet': {
    name: 'Correct Sheet Routing',
    description: 'Income goes to Staff Sheet, Expenses go to Expenses Sheet',
    severity: 'HIGH',
    inject: () => `FINANCIAL DATA ROUTING:
- Income/Revenue/Payments received → Staff Sheet (Income tab)
- Expenses/Costs/Bills paid → Expenses Sheet (EXPENSES tab)
- Maintenance costs → Expenses Sheet (EXPENSES tab) + Maintenance Sheet
- NEVER mix income and expenses in the same sheet.`,
  },

  'finance:currency': {
    name: 'Currency Standards',
    description: 'Always use IDR for local transactions, specify currency for international',
    severity: 'LOW',
    inject: () => 'Default currency is IDR (Indonesian Rupiah). For international guests, always clarify if amounts are in IDR or USD/EUR. Convert at current rate when needed.',
  },

  // ═══ MAINTENANCE RULES ═════════════════════════════════════════
  'maintenance:required-fields': {
    name: 'Maintenance Required Fields',
    description: 'Every maintenance task must have: villa, description, priority, PIC',
    severity: 'HIGH',
    check: (context) => {
      if (context.intent === 'maintenance' && context.action === 'create') {
        const missing = [];
        if (!context.args?.villa) missing.push('villa name');
        if (!context.args?.description) missing.push('issue description');
        if (!context.args?.priority) missing.push('priority level');
        if (missing.length > 0) {
          return { pass: true, warning: `Maintenance task missing: ${missing.join(', ')}. Ask the user for these details.` };
        }
      }
      return { pass: true };
    },
  },

  'maintenance:escalation': {
    name: 'Maintenance Escalation',
    description: 'URGENT + guest check-in within 48h = auto-escalate to management',
    severity: 'HIGH',
    inject: () => `ESCALATION RULE: If a maintenance issue is URGENT and a guest is checking in within 48 hours at that villa, immediately flag this as CRITICAL and suggest alerting the management group.`,
  },

  // ═══ COMMUNICATION RULES ═══════════════════════════════════════
  'comms:language': {
    name: 'Bilingual Communication',
    description: 'Respond in the language the user writes in (English or Bahasa Indonesia)',
    severity: 'MEDIUM',
    inject: () => 'Match the user\'s language: if they write in Bahasa Indonesia, respond in Bahasa. If English, respond in English. For mixed, prefer the dominant language.',
  },

  'comms:whatsapp-format': {
    name: 'WhatsApp Formatting',
    description: 'Use WhatsApp-compatible formatting',
    severity: 'LOW',
    inject: () => 'Format for WhatsApp: use *bold* (single asterisk), _italic_ (underscore), ~strikethrough~ (tilde). Keep messages under 4000 characters. Use bullet points with • character.',
  },

  'comms:professional-tone': {
    name: 'Professional Tone for External',
    description: 'Guest-facing messages must be warm and professional',
    severity: 'MEDIUM',
    inject: () => 'For guest-facing messages (emails, WhatsApp to guests): warm, professional, hospitable. For internal team messages: concise, action-oriented, direct.',
  },

  // ═══ PRIVACY RULES ═════════════════════════════════════════════
  'privacy:guest-data': {
    name: 'Guest Data Protection',
    description: 'Never share guest passport/personal details in group chats',
    severity: 'CRITICAL',
    check: (context) => {
      if (context.isGroup && context.response) {
        const sensitivePatterns = [
          /passport\s*(number|no|#)\s*[:=]?\s*\w{6,}/i,
          /\b[A-Z]{1,2}\d{6,9}\b/, // Passport format
          /credit\s*card\s*[:=]?\s*\d{4}/i,
          /\bCVV\b/i,
        ];
        for (const pattern of sensitivePatterns) {
          if (pattern.test(context.response)) {
            return { pass: false, message: 'BLOCKED: Cannot share passport numbers or payment card details in group chats. Send via DM or secure channel.' };
          }
        }
      }
      return { pass: true };
    },
  },

  'privacy:no-system-info': {
    name: 'System Info Protection',
    description: 'Never reveal API keys, server details, or internal architecture',
    severity: 'CRITICAL',
    inject: () => 'NEVER reveal: API keys, server IP addresses, database paths, passwords, OAuth tokens, or internal system architecture details. If asked, say you cannot share system configuration.',
  },

  // ═══ DIVISION BOUNDARIES ═══════════════════════════════════════
  'division:data-routing': {
    name: 'Division Data Routing',
    description: 'Each division writes to its own designated sheets/systems',
    severity: 'HIGH',
    inject: () => `DIVISION DATA ROUTING:
- Villa bookings → Villa calendars + Staff Sheet (Income)
- Villa maintenance → Maintenance Sheet
- Agency deals → Agency tracking sheet
- Furniture orders → Furniture inventory sheet
- Renovation projects → Renovation project tracker
- Interior design → Design project folder in Drive
Always route data to the correct division system.`,
  },

  // ═══ OPERATIONAL RULES ═════════════════════════════════════════
  'ops:confirm-destructive': {
    name: 'Confirm Destructive Actions',
    description: 'Always confirm before deleting, cancelling, or overwriting data',
    severity: 'HIGH',
    inject: () => 'ALWAYS ask for explicit confirmation before: deleting records, cancelling bookings, overwriting data, marking tasks as cancelled, or sending emails to clients. State exactly what will happen and ask "Should I proceed?"',
  },

  'ops:audit-trail': {
    name: 'Audit Trail',
    description: 'Log who requested what and when for important actions',
    severity: 'MEDIUM',
    inject: () => 'For important actions (bookings, payments, cancellations, expense logs), always note WHO requested the action and WHEN in the record.',
  },
};

// ─── POLICY ENGINE CLASS ────────────────────────────────────────────────────

class PolicyEngine {
  constructor() {
    const count = Object.keys(POLICIES).length;
    console.log(`[PolicyEngine] Initialized with ${count} policies`);
  }

  /**
   * Check all relevant policies against a context
   * Called before tool execution
   */
  check(context = {}) {
    const results = {
      allowed: true,
      blocked: [],
      warnings: [],
      injections: [],
    };

    for (const [id, policy] of Object.entries(POLICIES)) {
      // Skip if overridden
      if (this._isOverridden(id)) continue;

      // Run check function if exists
      if (policy.check) {
        try {
          const result = policy.check(context);
          if (!result.pass) {
            results.allowed = false;
            results.blocked.push({
              policyId: id,
              name: policy.name,
              severity: policy.severity,
              message: result.message,
            });
            this._log(id, 'blocked', context, result.message);
          } else if (result.warning) {
            results.warnings.push({
              policyId: id,
              name: policy.name,
              message: result.warning,
            });
            this._log(id, 'warned', context, result.warning);
          }
        } catch (e) { /* policy check error, skip */ }
      }
    }

    return results;
  }

  /**
   * Build policy injection string for system prompt
   * Returns rules relevant to the current intent
   */
  buildPolicyContext(intent = 'general') {
    const parts = ['\n--- BUSINESS RULES (MUST FOLLOW) ---'];
    let count = 0;

    // Always include critical and high-severity injectable policies
    for (const [id, policy] of Object.entries(POLICIES)) {
      if (!policy.inject) continue;
      if (this._isOverridden(id)) continue;

      // Include if: critical/high severity, OR relevant to intent
      const isRelevant = this._isPolicyRelevant(id, intent);
      const isImportant = policy.severity === 'CRITICAL' || policy.severity === 'HIGH';

      if (isRelevant || isImportant) {
        parts.push(`[${policy.severity}] ${policy.inject()}`);
        count++;
      }
    }

    if (count === 0) return '';
    parts.push('--- END BUSINESS RULES ---\n');
    return parts.join('\n');
  }

  /**
   * Screen a response before sending
   */
  screenResponse(response, context = {}) {
    const checkResult = this.check({ ...context, response, action: 'respond' });
    return checkResult;
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────

  _isPolicyRelevant(policyId, intent) {
    const mapping = {
      'booking': ['booking:', 'finance:currency', 'comms:'],
      'maintenance': ['maintenance:', 'ops:', 'division:'],
      'finance': ['finance:', 'data:', 'ops:'],
      'email': ['comms:', 'privacy:'],
      'guest_comms': ['comms:', 'privacy:', 'booking:checkin'],
      'audit': ['data:', 'ops:', 'division:'],
      'agency': ['division:', 'finance:', 'comms:'],
      'furniture': ['division:', 'finance:', 'ops:'],
      'renovation': ['division:', 'finance:', 'ops:'],
      'interior': ['division:', 'comms:'],
    };

    const prefixes = mapping[intent] || ['ops:', 'comms:'];
    return prefixes.some(prefix => policyId.startsWith(prefix));
  }

  _isOverridden(policyId) {
    try {
      const override = db.prepare('SELECT * FROM policy_overrides WHERE policy_id = ?').get(policyId);
      if (!override) return false;
      if (override.expires_at && new Date(override.expires_at) < new Date()) {
        db.prepare('DELETE FROM policy_overrides WHERE policy_id = ?').run(policyId);
        return false;
      }
      return true;
    } catch (e) { return false; }
  }

  _log(policyId, action, context, details) {
    try {
      db.prepare('INSERT INTO policy_log (timestamp, policy_id, action, context, result, details) VALUES (?, ?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), policyId, action,
          JSON.stringify({ intent: context.intent, tool: context.toolName }).substring(0, 500),
          action, details || '');
    } catch (e) { /* ignore */ }
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats() {
    const totalPolicies = Object.keys(POLICIES).length;
    const blocked = db.prepare("SELECT COUNT(*) as c FROM policy_log WHERE result = 'blocked'").get().c;
    const warned = db.prepare("SELECT COUNT(*) as c FROM policy_log WHERE result = 'warned'").get().c;
    const topBlocked = db.prepare("SELECT policy_id, COUNT(*) as count FROM policy_log WHERE result = 'blocked' GROUP BY policy_id ORDER BY count DESC LIMIT 5").all();
    return { totalPolicies, blocked, warned, topBlocked };
  }

  getPolicies() {
    return Object.entries(POLICIES).map(([id, p]) => ({
      id, name: p.name, severity: p.severity, description: p.description,
      hasCheck: !!p.check, hasInject: !!p.inject,
    }));
  }
}

const policyEngine = new PolicyEngine();
module.exports = policyEngine;
module.exports.PolicyEngine = PolicyEngine;
module.exports.POLICIES = POLICIES;
