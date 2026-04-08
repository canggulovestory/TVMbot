/**
 * drift-detector.js — Behavioral Drift Detection for TVMbot
 * Inspired by ruflo's drift prevention through hierarchical checkpoints
 *
 * Monitors TVMbot's behavior over time and detects degradation:
 *   - Response quality trending down
 *   - Error rates increasing
 *   - Tool failures spiking
 *   - Response times getting slower
 *   - Booster hits declining (means routing is degrading)
 *   - Memory/learning not improving
 *
 * Alerts management when drift is detected so action can be taken.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'drift-detector.db');
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
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value REAL NOT NULL,
    window TEXT DEFAULT 'hourly'
  );

  CREATE TABLE IF NOT EXISTS drift_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    current_value REAL,
    baseline_value REAL,
    drift_percentage REAL,
    severity TEXT,
    message TEXT
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    metrics_snapshot TEXT NOT NULL,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON metrics(metric_name, timestamp);
`);

// ─── METRIC DEFINITIONS ─────────────────────────────────────────────────────

const METRICS = {
  'response_time_ms': { baseline: 5000, warnThreshold: 1.5, criticalThreshold: 2.0, direction: 'lower_better' },
  'error_rate': { baseline: 0.05, warnThreshold: 2.0, criticalThreshold: 3.0, direction: 'lower_better' },
  'tool_failure_rate': { baseline: 0.1, warnThreshold: 1.5, criticalThreshold: 2.5, direction: 'lower_better' },
  'booster_hit_rate': { baseline: 0.15, warnThreshold: 0.5, criticalThreshold: 0.3, direction: 'higher_better' },
  'avg_token_count': { baseline: 3000, warnThreshold: 1.5, criticalThreshold: 2.0, direction: 'lower_better' },
  'routing_confidence': { baseline: 0.6, warnThreshold: 0.7, criticalThreshold: 0.5, direction: 'higher_better' },
  'messages_per_hour': { baseline: 5, warnThreshold: 0, criticalThreshold: 0, direction: 'info_only' },
};

// ─── DRIFT DETECTOR CLASS ───────────────────────────────────────────────────

class DriftDetector {
  constructor() {
    console.log(`[DriftDetector] Initialized with ${Object.keys(METRICS).length} tracked metrics`);
  }

  /**
   * Record a metric data point
   */
  record(metricName, value) {
    try {
      db.prepare('INSERT INTO metrics (timestamp, metric_name, value) VALUES (?, ?, ?)')
        .run(new Date().toISOString(), metricName, value);
    } catch (e) { /* ignore */ }
  }

  /**
   * Record multiple metrics from a message processing cycle
   */
  recordCycle(data = {}) {
    const {
      responseTimeMs = 0,
      success = true,
      toolsCalled = 0,
      toolsFailed = 0,
      wasBoosted = false,
      tokenCount = 0,
      routingConfidence = 0,
    } = data;

    this.record('response_time_ms', responseTimeMs);
    this.record('error_rate', success ? 0 : 1);
    this.record('tool_failure_rate', toolsCalled > 0 ? toolsFailed / toolsCalled : 0);
    this.record('booster_hit_rate', wasBoosted ? 1 : 0);
    this.record('avg_token_count', tokenCount);
    this.record('routing_confidence', routingConfidence);
    this.record('messages_per_hour', 1);
  }

  /**
   * Run drift detection — compare recent metrics to baseline
   * @returns {{ hasDrift: boolean, alerts: Array }}
   */
  detect() {
    const alerts = [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const [metricName, config] of Object.entries(METRICS)) {
      if (config.direction === 'info_only') continue;

      // Get recent average (last hour)
      const recent = db.prepare(
        'SELECT AVG(value) as avg, COUNT(*) as count FROM metrics WHERE metric_name = ? AND timestamp >= ?'
      ).get(metricName, oneHourAgo);

      // Get baseline average (last 24h)
      const baseline = db.prepare(
        'SELECT AVG(value) as avg, COUNT(*) as count FROM metrics WHERE metric_name = ? AND timestamp >= ? AND timestamp < ?'
      ).get(metricName, oneDayAgo, oneHourAgo);

      if (!recent || recent.count < 3 || !baseline || baseline.count < 10) continue;

      const recentAvg = recent.avg;
      const baselineAvg = baseline.avg || config.baseline;

      if (baselineAvg === 0) continue;

      let driftRatio;
      if (config.direction === 'lower_better') {
        driftRatio = recentAvg / baselineAvg; // >1 means getting worse
      } else {
        driftRatio = baselineAvg / recentAvg; // >1 means getting worse (value dropping)
      }

      let severity = null;
      if (driftRatio >= config.criticalThreshold) {
        severity = 'CRITICAL';
      } else if (driftRatio >= config.warnThreshold) {
        severity = 'WARNING';
      }

      if (severity) {
        const driftPct = Math.round((driftRatio - 1) * 100);
        const alert = {
          metricName,
          currentValue: Math.round(recentAvg * 100) / 100,
          baselineValue: Math.round(baselineAvg * 100) / 100,
          driftPercentage: driftPct,
          severity,
          message: `${metricName}: ${driftPct}% ${config.direction === 'lower_better' ? 'increase' : 'decrease'} (${Math.round(recentAvg * 100) / 100} vs baseline ${Math.round(baselineAvg * 100) / 100})`,
        };
        alerts.push(alert);

        // Log alert
        try {
          db.prepare('INSERT INTO drift_alerts (timestamp, metric_name, current_value, baseline_value, drift_percentage, severity, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(new Date().toISOString(), metricName, recentAvg, baselineAvg, driftPct, severity, alert.message);
        } catch (e) { /* ignore */ }
      }
    }

    return {
      hasDrift: alerts.length > 0,
      alerts,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a checkpoint (snapshot of current metrics)
   */
  createCheckpoint(notes = '') {
    const snapshot = {};
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    for (const metricName of Object.keys(METRICS)) {
      const avg = db.prepare('SELECT AVG(value) as avg FROM metrics WHERE metric_name = ? AND timestamp >= ?')
        .get(metricName, oneHourAgo);
      snapshot[metricName] = avg?.avg || 0;
    }

    db.prepare('INSERT INTO checkpoints (timestamp, metrics_snapshot, notes) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), JSON.stringify(snapshot), notes);

    return snapshot;
  }

  /**
   * Build a health report string
   */
  buildHealthReport() {
    const detection = this.detect();
    if (!detection.hasDrift) return '';

    const parts = ['\n--- SYSTEM HEALTH ALERT ---'];
    for (const alert of detection.alerts) {
      parts.push(`[${alert.severity}] ${alert.message}`);
    }
    parts.push('--- END HEALTH ALERT ---\n');
    return parts.join('\n');
  }

  // ─── CLEANUP ────────────────────────────────────────────────────────────

  cleanup(daysToKeep = 7) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const metrics = db.prepare('DELETE FROM metrics WHERE timestamp < ?').run(cutoff);
    const alerts = db.prepare('DELETE FROM drift_alerts WHERE timestamp < ?').run(cutoff);
    return { metricsRemoved: metrics.changes, alertsRemoved: alerts.changes };
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats() {
    const totalDataPoints = db.prepare('SELECT COUNT(*) as c FROM metrics').get().c;
    const totalAlerts = db.prepare('SELECT COUNT(*) as c FROM drift_alerts').get().c;
    const recentAlerts = db.prepare('SELECT * FROM drift_alerts ORDER BY id DESC LIMIT 5').all();
    const latestCheckpoint = db.prepare('SELECT * FROM checkpoints ORDER BY id DESC LIMIT 1').get();

    // Current averages
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const current = {};
    for (const metricName of Object.keys(METRICS)) {
      const avg = db.prepare('SELECT AVG(value) as avg, COUNT(*) as count FROM metrics WHERE metric_name = ? AND timestamp >= ?')
        .get(metricName, oneHourAgo);
      current[metricName] = { avg: Math.round((avg?.avg || 0) * 100) / 100, samples: avg?.count || 0 };
    }

    return { totalDataPoints, totalAlerts, recentAlerts, latestCheckpoint, current };
  }
}

const driftDetector = new DriftDetector();
module.exports = driftDetector;
module.exports.DriftDetector = DriftDetector;
module.exports.METRICS = METRICS;
