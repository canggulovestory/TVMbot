/**
 * Circuit Breaker — Fault Tolerance for External Services
 * Inspired by ruflo's resilience patterns.
 *
 * Prevents cascading failures when external services (Google APIs, Claude API,
 * WhatsApp, web scraping targets) are down. Three states:
 *   CLOSED  → Normal operation, requests pass through
 *   OPEN    → Service is down, requests fail-fast without trying
 *   HALF    → Testing if service recovered, limited requests pass
 *
 * Features:
 *   - Per-service circuit breakers
 *   - Configurable failure thresholds + cooldown
 *   - Exponential backoff for retries
 *   - Fallback responses when circuit is open
 *   - Health monitoring dashboard data
 *   - Jitter to prevent thundering herd
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'circuit-breaker.db');

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // In-memory circuit states for fast access
    this.circuits = {};

    // Service definitions with thresholds
    this.services = {
      'claude-api': {
        failureThreshold: 3,
        cooldownMs: 60000,       // 1 min
        halfOpenMax: 1,
        timeoutMs: 120000,
        fallback: () => ({ error: 'AI service temporarily unavailable. Please try again in a minute.' }),
      },
      'google-sheets': {
        failureThreshold: 5,
        cooldownMs: 30000,       // 30s
        halfOpenMax: 2,
        timeoutMs: 30000,
        fallback: () => ({ error: 'Google Sheets is temporarily unavailable. Data may be slightly stale.' }),
      },
      'google-calendar': {
        failureThreshold: 5,
        cooldownMs: 30000,
        halfOpenMax: 2,
        timeoutMs: 30000,
        fallback: () => ({ error: 'Calendar service temporarily unavailable.' }),
      },
      'google-gmail': {
        failureThreshold: 5,
        cooldownMs: 45000,
        halfOpenMax: 2,
        timeoutMs: 30000,
        fallback: () => ({ error: 'Email service temporarily unavailable.' }),
      },
      'google-drive': {
        failureThreshold: 5,
        cooldownMs: 30000,
        halfOpenMax: 2,
        timeoutMs: 30000,
        fallback: () => ({ error: 'Drive service temporarily unavailable.' }),
      },
      'whatsapp': {
        failureThreshold: 3,
        cooldownMs: 10000,       // 10s — WA reconnects fast
        halfOpenMax: 1,
        timeoutMs: 15000,
        fallback: () => ({ error: 'WhatsApp connection issue. Message queued for retry.' }),
      },
      'web-scraper': {
        failureThreshold: 5,
        cooldownMs: 120000,      // 2 min
        halfOpenMax: 2,
        timeoutMs: 20000,
        fallback: () => ({ error: 'Web scraping temporarily unavailable. Target site may be blocking requests.' }),
      },
      'sqlite-db': {
        failureThreshold: 2,
        cooldownMs: 5000,
        halfOpenMax: 1,
        timeoutMs: 10000,
        fallback: () => ({ error: 'Database temporarily unavailable.' }),
      },
    };

    // Initialize circuits in CLOSED state
    for (const service of Object.keys(this.services)) {
      this.circuits[service] = {
        state: STATES.CLOSED,
        failures: 0,
        successes: 0,
        lastFailure: null,
        lastSuccess: null,
        openedAt: null,
        halfOpenRequests: 0,
      };
    }

    // Load persisted state
    this._loadState();

    console.log(`[CircuitBreaker] Initialized with ${Object.keys(this.services).length} service circuits`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS circuit_state (
        service TEXT PRIMARY KEY,
        state TEXT DEFAULT 'CLOSED',
        failures INTEGER DEFAULT 0,
        successes INTEGER DEFAULT 0,
        last_failure TEXT,
        last_success TEXT,
        opened_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS circuit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        event_type TEXT NOT NULL,
        old_state TEXT,
        new_state TEXT,
        details TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS retry_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        next_retry_at TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_circuit_events_service ON circuit_events(service);
      CREATE INDEX IF NOT EXISTS idx_retry_queue_status ON retry_queue(status, next_retry_at);
    `);
  }

  _loadState() {
    const rows = this.db.prepare('SELECT * FROM circuit_state').all();
    for (const row of rows) {
      if (this.circuits[row.service]) {
        this.circuits[row.service] = {
          state: row.state,
          failures: row.failures,
          successes: row.successes,
          lastFailure: row.last_failure,
          lastSuccess: row.last_success,
          openedAt: row.opened_at,
          halfOpenRequests: 0,
        };
      }
    }
  }

  _saveState(service) {
    const c = this.circuits[service];
    this.db.prepare(`
      INSERT OR REPLACE INTO circuit_state (service, state, failures, successes, last_failure, last_success, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(service, c.state, c.failures, c.successes, c.lastFailure, c.lastSuccess, c.openedAt);
  }

  _logEvent(service, eventType, oldState, newState, details = '') {
    this.db.prepare(`
      INSERT INTO circuit_events (service, event_type, old_state, new_state, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(service, eventType, oldState, newState, details);
  }

  /**
   * Check if a service call is allowed
   * Returns: { allowed, state, fallback? }
   */
  canCall(service) {
    const circuit = this.circuits[service];
    const config = this.services[service];

    if (!circuit || !config) {
      return { allowed: true, state: 'UNKNOWN' };
    }

    switch (circuit.state) {
      case STATES.CLOSED:
        return { allowed: true, state: STATES.CLOSED };

      case STATES.OPEN: {
        const elapsed = Date.now() - new Date(circuit.openedAt).getTime();
        const cooldown = config.cooldownMs + this._jitter(config.cooldownMs * 0.2);

        if (elapsed >= cooldown) {
          // Transition to HALF_OPEN
          this._transition(service, STATES.HALF_OPEN);
          circuit.halfOpenRequests = 0;
          return { allowed: true, state: STATES.HALF_OPEN };
        }

        return {
          allowed: false,
          state: STATES.OPEN,
          fallback: config.fallback ? config.fallback() : null,
          retryAfterMs: cooldown - elapsed,
        };
      }

      case STATES.HALF_OPEN: {
        if (circuit.halfOpenRequests < config.halfOpenMax) {
          circuit.halfOpenRequests++;
          return { allowed: true, state: STATES.HALF_OPEN };
        }
        return {
          allowed: false,
          state: STATES.HALF_OPEN,
          fallback: config.fallback ? config.fallback() : null,
          message: 'Circuit half-open, max test requests reached',
        };
      }

      default:
        return { allowed: true, state: 'UNKNOWN' };
    }
  }

  /**
   * Record a successful call
   */
  recordSuccess(service) {
    const circuit = this.circuits[service];
    if (!circuit) return;

    circuit.successes++;
    circuit.lastSuccess = new Date().toISOString();

    if (circuit.state === STATES.HALF_OPEN) {
      // Recovery confirmed — close circuit
      this._transition(service, STATES.CLOSED);
      circuit.failures = 0;
      circuit.halfOpenRequests = 0;
    } else if (circuit.state === STATES.CLOSED) {
      // Decay failures on success
      circuit.failures = Math.max(0, circuit.failures - 1);
    }

    this._saveState(service);
  }

  /**
   * Record a failed call
   */
  recordFailure(service, error = '') {
    const circuit = this.circuits[service];
    const config = this.services[service];
    if (!circuit || !config) return;

    circuit.failures++;
    circuit.lastFailure = new Date().toISOString();

    if (circuit.state === STATES.HALF_OPEN) {
      // Still failing — reopen circuit
      this._transition(service, STATES.OPEN, error);
      circuit.openedAt = new Date().toISOString();
    } else if (circuit.state === STATES.CLOSED && circuit.failures >= config.failureThreshold) {
      // Threshold reached — open circuit
      this._transition(service, STATES.OPEN, `${circuit.failures} failures: ${error}`);
      circuit.openedAt = new Date().toISOString();
    }

    this._saveState(service);
  }

  _transition(service, newState, details = '') {
    const circuit = this.circuits[service];
    const oldState = circuit.state;
    circuit.state = newState;

    this._logEvent(service, 'state_change', oldState, newState, details);

    if (oldState !== newState) {
      console.log(`[CircuitBreaker] ${service}: ${oldState} → ${newState}${details ? ' (' + details.substring(0, 80) + ')' : ''}`);
    }
  }

  _jitter(maxMs) {
    return Math.random() * maxMs;
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute(service, fn, fallbackFn = null) {
    const check = this.canCall(service);

    if (!check.allowed) {
      if (fallbackFn) return fallbackFn(check);
      if (check.fallback) return check.fallback;
      throw new Error(`Circuit OPEN for ${service}. Retry after ${Math.ceil((check.retryAfterMs || 0) / 1000)}s`);
    }

    try {
      const config = this.services[service];
      const timeout = config ? config.timeoutMs : 30000;

      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
      ]);

      this.recordSuccess(service);
      return result;
    } catch (error) {
      this.recordFailure(service, error.message);
      if (fallbackFn) return fallbackFn({ error: error.message, state: this.circuits[service]?.state });
      throw error;
    }
  }

  /**
   * Queue a failed operation for retry
   */
  queueRetry(service, operation, payload, maxRetries = 3) {
    const backoffMs = 5000 * Math.pow(2, 0); // First retry in 5s
    this.db.prepare(`
      INSERT INTO retry_queue (service, operation, payload, max_retries, next_retry_at)
      VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))
    `).run(service, operation, JSON.stringify(payload), maxRetries, Math.ceil(backoffMs / 1000));
  }

  /**
   * Get pending retries that are due
   */
  getDueRetries() {
    return this.db.prepare(`
      SELECT * FROM retry_queue
      WHERE status = 'pending' AND next_retry_at <= datetime('now')
      ORDER BY next_retry_at ASC LIMIT 10
    `).all();
  }

  /**
   * Update retry status
   */
  updateRetry(retryId, success) {
    if (success) {
      this.db.prepare("UPDATE retry_queue SET status = 'completed' WHERE id = ?").run(retryId);
    } else {
      const retry = this.db.prepare('SELECT * FROM retry_queue WHERE id = ?').get(retryId);
      if (retry && retry.retry_count < retry.max_retries) {
        const backoffMs = 5000 * Math.pow(2, retry.retry_count + 1);
        this.db.prepare(`
          UPDATE retry_queue SET retry_count = retry_count + 1, next_retry_at = datetime('now', '+' || ? || ' seconds')
          WHERE id = ?
        `).run(Math.ceil(backoffMs / 1000), retryId);
      } else {
        this.db.prepare("UPDATE retry_queue SET status = 'failed' WHERE id = ?").run(retryId);
      }
    }
  }

  /**
   * Force reset a circuit (for manual recovery)
   */
  reset(service) {
    if (this.circuits[service]) {
      const oldState = this.circuits[service].state;
      this.circuits[service] = {
        state: STATES.CLOSED,
        failures: 0,
        successes: 0,
        lastFailure: null,
        lastSuccess: null,
        openedAt: null,
        halfOpenRequests: 0,
      };
      this._saveState(service);
      this._logEvent(service, 'manual_reset', oldState, STATES.CLOSED, 'Manual reset');
      return true;
    }
    return false;
  }

  /**
   * Get health status for all circuits
   */
  getHealth() {
    const health = {};
    for (const [service, circuit] of Object.entries(this.circuits)) {
      health[service] = {
        state: circuit.state,
        failures: circuit.failures,
        successes: circuit.successes,
        lastFailure: circuit.lastFailure,
        lastSuccess: circuit.lastSuccess,
        healthy: circuit.state === STATES.CLOSED,
      };
    }
    return health;
  }

  /**
   * Get system prompt context about service health
   */
  getHealthContext() {
    const unhealthy = Object.entries(this.circuits)
      .filter(([_, c]) => c.state !== STATES.CLOSED)
      .map(([name, c]) => `${name}: ${c.state}`);

    if (unhealthy.length === 0) return '';

    return `\n\n--- Service Health ---\nDegraded services: ${unhealthy.join(', ')}. Some features may be limited.\n`;
  }

  /**
   * Cleanup old events
   */
  cleanup(daysOld = 7) {
    const deleted = this.db.prepare(`
      DELETE FROM circuit_events WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    const retries = this.db.prepare(`
      DELETE FROM retry_queue WHERE status IN ('completed', 'failed') AND created_at < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    return { deletedEvents: deleted.changes, deletedRetries: retries.changes };
  }

  getStats() {
    const states = {};
    for (const [service, circuit] of Object.entries(this.circuits)) {
      states[service] = circuit.state;
    }
    const openCount = Object.values(this.circuits).filter(c => c.state !== STATES.CLOSED).length;
    return {
      services: Object.keys(this.circuits).length,
      states,
      openCircuits: openCount,
      allHealthy: openCount === 0,
    };
  }
}

module.exports = new CircuitBreaker();
