/**
 * Guidance Gates — Approval Workflows for High-Risk Actions
 * Inspired by ruflo's human-in-the-loop approval system.
 *
 * Certain actions require human approval before execution:
 *   - Large financial transactions (> IDR 5M)
 *   - Guest data modifications
 *   - Booking cancellations/modifications
 *   - Staff-related decisions
 *   - External communications on behalf of TVM
 *   - Contract/agreement changes
 *
 * Features:
 *   - Risk-level classification (LOW/MEDIUM/HIGH/CRITICAL)
 *   - Auto-approve LOW risk, flag MEDIUM+
 *   - Approval expiry (24h default)
 *   - Audit trail of all approval decisions
 *   - Escalation paths (agent → manager → owner)
 *   - Conditional auto-approve rules
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'guidance.db');

class GuidanceGates {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Gate definitions — each gate checks specific actions
    this.gates = {
      'finance:large-expense': {
        description: 'Expenses exceeding IDR 5,000,000',
        riskLevel: 'HIGH',
        check: (ctx) => {
          const amount = ctx.amount || 0;
          return amount > 5000000;
        },
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 24,
      },
      'finance:payment-out': {
        description: 'Any outgoing payment or transfer',
        riskLevel: 'MEDIUM',
        check: (ctx) => ctx.action === 'payment' && ctx.direction === 'outgoing',
        autoApproveIf: (ctx) => (ctx.amount || 0) < 500000, // Auto-approve small payments
        escalateTo: 'finance-director',
        expiryHours: 48,
      },
      'booking:cancel': {
        description: 'Booking cancellation',
        riskLevel: 'HIGH',
        check: (ctx) => ctx.action === 'cancel_booking',
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 12,
      },
      'booking:modify-price': {
        description: 'Booking price modification',
        riskLevel: 'HIGH',
        check: (ctx) => ctx.action === 'modify_booking' && ctx.priceChanged,
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 24,
      },
      'booking:create': {
        description: 'New booking creation',
        riskLevel: 'LOW',
        check: (ctx) => ctx.action === 'create_booking',
        autoApproveIf: () => true, // Auto-approve new bookings
        escalateTo: null,
        expiryHours: 48,
      },
      'guest:data-modify': {
        description: 'Guest personal data modification',
        riskLevel: 'MEDIUM',
        check: (ctx) => ctx.action === 'modify_guest_data',
        autoApproveIf: null,
        escalateTo: 'villa-ops',
        expiryHours: 24,
      },
      'comms:external-email': {
        description: 'Sending emails to external parties on behalf of TVM',
        riskLevel: 'MEDIUM',
        check: (ctx) => ctx.action === 'send_email' && ctx.external,
        autoApproveIf: (ctx) => ctx.isReply, // Auto-approve replies
        escalateTo: 'comms-agent',
        expiryHours: 12,
      },
      'comms:group-broadcast': {
        description: 'Broadcast message to WhatsApp group',
        riskLevel: 'MEDIUM',
        check: (ctx) => ctx.action === 'broadcast' || ctx.isGroup,
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 6,
      },
      'staff:hire-fire': {
        description: 'Staff hiring or termination',
        riskLevel: 'CRITICAL',
        check: (ctx) => ['hire', 'terminate', 'fire'].includes(ctx.action),
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 72,
      },
      'contract:modify': {
        description: 'Contract or agreement modification',
        riskLevel: 'CRITICAL',
        check: (ctx) => ctx.action === 'modify_contract',
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 72,
      },
      'data:delete': {
        description: 'Data deletion request',
        riskLevel: 'HIGH',
        check: (ctx) => ctx.action === 'delete' || ctx.destructive,
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 24,
      },
      'renovation:approve-work': {
        description: 'Renovation work order approval',
        riskLevel: 'HIGH',
        check: (ctx) => ctx.action === 'approve_renovation' || (ctx.division === 'renovation' && (ctx.amount || 0) > 2000000),
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 48,
      },
      'furniture:purchase': {
        description: 'Furniture purchase order',
        riskLevel: 'MEDIUM',
        check: (ctx) => ctx.action === 'purchase_furniture',
        autoApproveIf: (ctx) => (ctx.amount || 0) < 1000000,
        escalateTo: 'finance-director',
        expiryHours: 48,
      },
      'system:config-change': {
        description: 'System configuration change',
        riskLevel: 'CRITICAL',
        check: (ctx) => ctx.action === 'system_config',
        autoApproveIf: null,
        escalateTo: 'owner',
        expiryHours: 24,
      },
    };

    this.riskLevels = { 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3, 'CRITICAL': 4 };

    console.log(`[GuidanceGates] Initialized with ${Object.keys(this.gates).length} approval gates`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT UNIQUE,
        gate_name TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        description TEXT,
        context TEXT DEFAULT '{}',
        requested_by TEXT,
        escalate_to TEXT,
        status TEXT DEFAULT 'pending',
        decision_by TEXT,
        decision_reason TEXT,
        auto_approved INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approval_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT,
        details TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);
      CREATE INDEX IF NOT EXISTS idx_approval_gate ON approval_requests(gate_name);
    `);
  }

  /**
   * Check if an action requires approval and create request if needed
   * Returns: { approved, pending, blocked, requestId, message }
   */
  checkGate(actionContext) {
    const triggeredGates = [];

    for (const [gateName, gate] of Object.entries(this.gates)) {
      try {
        if (gate.check(actionContext)) {
          triggeredGates.push({ name: gateName, ...gate });
        }
      } catch (e) {
        // Gate check error — skip
      }
    }

    if (triggeredGates.length === 0) {
      return { approved: true, pending: false, blocked: false, gates: [] };
    }

    // Sort by risk level (highest first)
    triggeredGates.sort((a, b) => (this.riskLevels[b.riskLevel] || 0) - (this.riskLevels[a.riskLevel] || 0));

    const highestRisk = triggeredGates[0];

    // Check auto-approve
    if (highestRisk.autoApproveIf) {
      try {
        if (highestRisk.autoApproveIf(actionContext)) {
          const requestId = this._createRequest(highestRisk.name, highestRisk, actionContext, true);
          return {
            approved: true, pending: false, blocked: false,
            requestId, autoApproved: true,
            gates: triggeredGates.map(g => g.name),
            message: `Auto-approved: ${highestRisk.description}`,
          };
        }
      } catch (e) { /* auto-approve check failed, proceed to manual */ }
    }

    // Create pending approval request
    const requestId = this._createRequest(highestRisk.name, highestRisk, actionContext, false);

    const isBlocked = this.riskLevels[highestRisk.riskLevel] >= 4; // CRITICAL = blocked until approved

    return {
      approved: false,
      pending: !isBlocked,
      blocked: isBlocked,
      requestId,
      riskLevel: highestRisk.riskLevel,
      gates: triggeredGates.map(g => g.name),
      escalateTo: highestRisk.escalateTo,
      message: this._buildApprovalMessage(highestRisk, actionContext, requestId),
    };
  }

  _createRequest(gateName, gate, context, autoApproved) {
    const requestId = `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.db.prepare(`
      INSERT INTO approval_requests (request_id, gate_name, risk_level, description, context, requested_by, escalate_to, status, auto_approved, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
    `).run(
      requestId, gateName, gate.riskLevel, gate.description,
      JSON.stringify(context), context.requestedBy || 'system',
      gate.escalateTo, autoApproved ? 'approved' : 'pending',
      autoApproved ? 1 : 0, gate.expiryHours
    );

    if (autoApproved) {
      this._log(requestId, 'auto-approved', 'system', `Auto-approved by gate rule: ${gateName}`);
    } else {
      this._log(requestId, 'created', 'system', `Approval required: ${gate.description} [${gate.riskLevel}]`);
    }

    return requestId;
  }

  _buildApprovalMessage(gate, context, requestId) {
    const riskEmoji = { 'LOW': '', 'MEDIUM': '⚠️', 'HIGH': '🔴', 'CRITICAL': '🚨' };
    const emoji = riskEmoji[gate.riskLevel] || '';

    let msg = `${emoji} *Approval Required* [${gate.riskLevel}]\n`;
    msg += `Action: ${gate.description}\n`;

    if (context.amount) msg += `Amount: IDR ${Number(context.amount).toLocaleString()}\n`;
    if (context.villa) msg += `Villa: ${context.villa}\n`;
    if (context.description) msg += `Details: ${context.description}\n`;

    msg += `\nRef: ${requestId}\n`;
    msg += `Escalated to: ${gate.escalateTo || 'manager'}\n`;
    msg += `Reply "approve ${requestId}" or "reject ${requestId}" to decide.`;

    return msg;
  }

  /**
   * Approve a pending request
   */
  approve(requestId, approver, reason = '') {
    const req = this.db.prepare('SELECT * FROM approval_requests WHERE request_id = ? AND status = ?').get(requestId, 'pending');
    if (!req) return { success: false, error: 'Request not found or already decided' };

    this.db.prepare(`
      UPDATE approval_requests SET status = 'approved', decision_by = ?, decision_reason = ?, decided_at = datetime('now')
      WHERE request_id = ?
    `).run(approver, reason, requestId);

    this._log(requestId, 'approved', approver, reason || 'Approved');

    return { success: true, requestId, gate: req.gate_name };
  }

  /**
   * Reject a pending request
   */
  reject(requestId, rejector, reason = '') {
    const req = this.db.prepare('SELECT * FROM approval_requests WHERE request_id = ? AND status = ?').get(requestId, 'pending');
    if (!req) return { success: false, error: 'Request not found or already decided' };

    this.db.prepare(`
      UPDATE approval_requests SET status = 'rejected', decision_by = ?, decision_reason = ?, decided_at = datetime('now')
      WHERE request_id = ?
    `).run(rejector, reason, requestId);

    this._log(requestId, 'rejected', rejector, reason || 'Rejected');

    return { success: true, requestId, gate: req.gate_name };
  }

  /**
   * Check pending approvals for a user/role
   */
  getPending(escalateTo = null) {
    let query;
    if (escalateTo) {
      query = this.db.prepare(`
        SELECT * FROM approval_requests WHERE status = 'pending' AND escalate_to = ? AND expires_at > datetime('now')
        ORDER BY created_at DESC
      `);
      return query.all(escalateTo);
    }
    return this.db.prepare(`
      SELECT * FROM approval_requests WHERE status = 'pending' AND expires_at > datetime('now')
      ORDER BY created_at DESC
    `).all();
  }

  /**
   * Check if a specific action was pre-approved
   */
  isPreApproved(requestId) {
    const req = this.db.prepare('SELECT status FROM approval_requests WHERE request_id = ?').get(requestId);
    return req && req.status === 'approved';
  }

  /**
   * Get system prompt injection for pending approvals
   */
  getApprovalContext(sender) {
    const pending = this.getPending('owner');
    if (pending.length === 0) return '';

    let ctx = '\n\n--- Pending Approvals ---\n';
    ctx += `There are ${pending.length} action(s) awaiting approval:\n`;
    for (const p of pending.slice(0, 5)) {
      const pCtx = JSON.parse(p.context || '{}');
      ctx += `• [${p.risk_level}] ${p.description} (ref: ${p.request_id})`;
      if (pCtx.amount) ctx += ` — IDR ${Number(pCtx.amount).toLocaleString()}`;
      ctx += '\n';
    }
    ctx += 'The owner can reply "approve [ref]" or "reject [ref]" to decide.\n';
    return ctx;
  }

  /**
   * Expire old pending requests
   */
  expireOld() {
    const expired = this.db.prepare(`
      UPDATE approval_requests SET status = 'expired'
      WHERE status = 'pending' AND expires_at < datetime('now')
    `).run();
    return expired.changes;
  }

  _log(requestId, action, actor, details) {
    this.db.prepare(`
      INSERT INTO approval_log (request_id, action, actor, details) VALUES (?, ?, ?, ?)
    `).run(requestId, action, actor, details);
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM approval_requests').get().c;
    const byStatus = this.db.prepare(`
      SELECT status, COUNT(*) as c FROM approval_requests GROUP BY status
    `).all();
    const byRisk = this.db.prepare(`
      SELECT risk_level, COUNT(*) as c FROM approval_requests GROUP BY risk_level
    `).all();

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.c])),
      byRisk: Object.fromEntries(byRisk.map(r => [r.risk_level, r.c])),
      gates: Object.keys(this.gates).length,
    };
  }
}

module.exports = new GuidanceGates();
