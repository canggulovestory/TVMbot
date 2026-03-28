/**
 * event-store.js — Event Sourcing Audit Trail for TVMbot
 * Inspired by ruflo's Event Sourcing pattern (ADR-007)
 *
 * Every meaningful action is logged as an immutable event:
 *   - Tool calls (which tool, what args, what result)
 *   - Business actions (booking created, expense logged, task closed)
 *   - System events (bot started, error occurred, policy blocked)
 *   - User interactions (message received, response sent)
 *
 * This creates a complete, queryable history of everything TVMbot has done.
 * Useful for: auditing, debugging, compliance, undo operations, analytics.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'event-store.db');
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
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    category TEXT NOT NULL,
    actor TEXT DEFAULT 'system',
    session_id TEXT,
    entity_type TEXT,
    entity_id TEXT,
    action TEXT NOT NULL,
    data TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    parent_event_id INTEGER,
    correlation_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
  CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
`);

// ─── EVENT CATEGORIES ────────────────────────────────────────────────────────
const CATEGORIES = {
  MESSAGE: 'message',       // User messages in/out
  TOOL: 'tool',             // Tool calls and results
  BUSINESS: 'business',     // Business actions (booking, payment, etc.)
  SYSTEM: 'system',         // System events (start, error, restart)
  SECURITY: 'security',     // Security events (blocked, flagged)
  LEARNING: 'learning',     // Learning events (pattern stored, Q-value updated)
  POLICY: 'policy',         // Policy enforcement events
};

// ─── EVENT STORE CLASS ──────────────────────────────────────────────────────

class EventStore {
  constructor() {
    this._correlationStack = [];
    const count = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    console.log(`[EventStore] Initialized with ${count} events`);
  }

  /**
   * Record an event
   */
  emit(eventType, action, data = {}, opts = {}) {
    const {
      category = CATEGORIES.SYSTEM,
      actor = 'system',
      sessionId = null,
      entityType = null,
      entityId = null,
      metadata = {},
      parentEventId = null,
      correlationId = null,
    } = opts;

    try {
      const result = db.prepare(`INSERT INTO events
        (timestamp, event_type, category, actor, session_id, entity_type, entity_id, action, data, metadata, parent_event_id, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          new Date().toISOString(),
          eventType, category, actor, sessionId,
          entityType, entityId, action,
          JSON.stringify(data).substring(0, 5000),
          JSON.stringify(metadata).substring(0, 2000),
          parentEventId,
          correlationId || this._currentCorrelation()
        );
      return result.lastInsertRowid;
    } catch (e) {
      return null;
    }
  }

  // ─── CONVENIENCE METHODS ────────────────────────────────────────────────

  messageReceived(message, sender, sessionId, isGroup = false) {
    return this.emit('message.received', 'received', {
      preview: message.substring(0, 200),
      sender, isGroup,
      length: message.length,
    }, { category: CATEGORIES.MESSAGE, actor: sender, sessionId });
  }

  messageSent(response, sessionId, responseTimeMs, tokenCount) {
    return this.emit('message.sent', 'sent', {
      preview: (response || '').substring(0, 200),
      length: (response || '').length,
      responseTimeMs, tokenCount,
    }, { category: CATEGORIES.MESSAGE, sessionId });
  }

  toolCalled(toolName, args, sessionId) {
    return this.emit('tool.called', toolName, {
      tool: toolName,
      args: JSON.stringify(args || {}).substring(0, 500),
    }, { category: CATEGORIES.TOOL, sessionId });
  }

  toolResult(toolName, success, resultPreview, sessionId) {
    return this.emit('tool.result', toolName, {
      tool: toolName, success,
      preview: (resultPreview || '').substring(0, 300),
    }, { category: CATEGORIES.TOOL, sessionId });
  }

  bookingCreated(villa, guest, dates, amount, actor) {
    return this.emit('booking.created', 'create', {
      villa, guest, dates, amount,
    }, { category: CATEGORIES.BUSINESS, actor, entityType: 'booking', entityId: `${villa}_${guest}` });
  }

  expenseLogged(description, amount, villa, actor) {
    return this.emit('expense.logged', 'create', {
      description, amount, villa,
    }, { category: CATEGORIES.BUSINESS, actor, entityType: 'expense' });
  }

  maintenanceUpdated(villa, issue, status, actor) {
    return this.emit('maintenance.updated', status, {
      villa, issue, status,
    }, { category: CATEGORIES.BUSINESS, actor, entityType: 'maintenance', entityId: `${villa}_${issue}` });
  }

  securityEvent(threatType, level, sender, details) {
    return this.emit('security.threat', threatType, {
      level, sender, details,
    }, { category: CATEGORIES.SECURITY, actor: sender });
  }

  policyEvent(policyId, action, details) {
    return this.emit('policy.enforced', action, {
      policyId, details,
    }, { category: CATEGORIES.POLICY });
  }

  systemEvent(action, details = {}) {
    return this.emit('system.' + action, action, details, { category: CATEGORIES.SYSTEM });
  }

  errorEvent(error, context = {}) {
    return this.emit('system.error', 'error', {
      message: error.message || String(error),
      stack: (error.stack || '').substring(0, 500),
      context,
    }, { category: CATEGORIES.SYSTEM });
  }

  // ─── CORRELATION ────────────────────────────────────────────────────────

  startCorrelation(id) {
    if (!id) id = `corr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    this._correlationStack.push(id);
    return id;
  }

  endCorrelation() {
    return this._correlationStack.pop();
  }

  _currentCorrelation() {
    return this._correlationStack.length > 0
      ? this._correlationStack[this._correlationStack.length - 1]
      : null;
  }

  // ─── QUERY ──────────────────────────────────────────────────────────────

  getEvents(filters = {}, limit = 50) {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params = [];

    if (filters.category) { sql += ' AND category = ?'; params.push(filters.category); }
    if (filters.eventType) { sql += ' AND event_type = ?'; params.push(filters.eventType); }
    if (filters.sessionId) { sql += ' AND session_id = ?'; params.push(filters.sessionId); }
    if (filters.entityType) { sql += ' AND entity_type = ?'; params.push(filters.entityType); }
    if (filters.entityId) { sql += ' AND entity_id = ?'; params.push(filters.entityId); }
    if (filters.actor) { sql += ' AND actor = ?'; params.push(filters.actor); }
    if (filters.correlationId) { sql += ' AND correlation_id = ?'; params.push(filters.correlationId); }
    if (filters.since) { sql += ' AND timestamp >= ?'; params.push(filters.since); }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  getEntityHistory(entityType, entityId, limit = 20) {
    return this.getEvents({ entityType, entityId }, limit);
  }

  getSessionTimeline(sessionId, limit = 50) {
    return db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, limit);
  }

  getCorrelatedEvents(correlationId) {
    return db.prepare('SELECT * FROM events WHERE correlation_id = ? ORDER BY id ASC')
      .all(correlationId);
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats(since = null) {
    const whereClause = since ? "WHERE timestamp >= ?" : "";
    const params = since ? [since] : [];

    const total = db.prepare(`SELECT COUNT(*) as c FROM events ${whereClause}`).get(...params).c;
    const byCategory = db.prepare(`SELECT category, COUNT(*) as count FROM events ${whereClause} GROUP BY category ORDER BY count DESC`).all(...params);
    const byType = db.prepare(`SELECT event_type, COUNT(*) as count FROM events ${whereClause} GROUP BY event_type ORDER BY count DESC LIMIT 10`).all(...params);
    const recentErrors = db.prepare("SELECT * FROM events WHERE event_type = 'system.error' ORDER BY id DESC LIMIT 5").all();

    return { total, byCategory, byType, recentErrors };
  }

  /**
   * Get a summary for a time period
   */
  getSummary(hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const messages = db.prepare("SELECT COUNT(*) as c FROM events WHERE category = 'message' AND timestamp >= ?").get(since).c;
    const tools = db.prepare("SELECT COUNT(*) as c FROM events WHERE category = 'tool' AND timestamp >= ?").get(since).c;
    const business = db.prepare("SELECT COUNT(*) as c FROM events WHERE category = 'business' AND timestamp >= ?").get(since).c;
    const security = db.prepare("SELECT COUNT(*) as c FROM events WHERE category = 'security' AND timestamp >= ?").get(since).c;
    const errors = db.prepare("SELECT COUNT(*) as c FROM events WHERE event_type = 'system.error' AND timestamp >= ?").get(since).c;

    return {
      period: `Last ${hours} hours`,
      messages, tools, business, security, errors,
      total: messages + tools + business + security + errors,
    };
  }

  /**
   * Cleanup old events (keep last 30 days)
   */
  cleanup(daysToKeep = 30) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
    return { removed: result.changes };
  }
}

const eventStore = new EventStore();
module.exports = eventStore;
module.exports.EventStore = EventStore;
module.exports.CATEGORIES = CATEGORIES;
