/**
 * Metric Aggregator — Analytics Dashboard Data
 * Inspired by ruflo's observability and metrics collection layer.
 *
 * Centralized metrics collection across all TVMbot modules.
 * Provides real-time and historical analytics for business intelligence.
 *
 * Features:
 *   - Counter, gauge, histogram metric types
 *   - Per-division business metrics
 *   - Time-series aggregation (minute, hour, day, month)
 *   - Anomaly detection (simple z-score)
 *   - Dashboard data generation
 *   - Alert thresholds
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'metrics.db');

class MetricAggregator {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Metric definitions
    this.metrics = {
      // Message metrics
      'messages.received':         { type: 'counter', unit: 'count', description: 'Total messages received' },
      'messages.processed':        { type: 'counter', unit: 'count', description: 'Messages successfully processed' },
      'messages.boosted':          { type: 'counter', unit: 'count', description: 'Messages handled by Agent Booster (no API)' },
      'messages.cached':           { type: 'counter', unit: 'count', description: 'Messages served from cache' },
      'messages.escalated':        { type: 'counter', unit: 'count', description: 'Messages escalated to human' },

      // Performance metrics
      'performance.response_time': { type: 'histogram', unit: 'ms', description: 'Response time' },
      'performance.api_calls':     { type: 'counter', unit: 'count', description: 'Claude API calls made' },
      'performance.api_cost':      { type: 'counter', unit: 'usd', description: 'Estimated API cost' },
      'performance.cache_hit_rate':{ type: 'gauge', unit: 'percent', description: 'Cache hit rate' },
      'performance.booster_rate':  { type: 'gauge', unit: 'percent', description: 'Agent Booster hit rate' },

      // Business metrics
      'business.bookings_created': { type: 'counter', unit: 'count', description: 'Bookings created' },
      'business.bookings_revenue': { type: 'counter', unit: 'idr', description: 'Booking revenue' },
      'business.expenses_logged':  { type: 'counter', unit: 'count', description: 'Expenses logged' },
      'business.expenses_total':   { type: 'counter', unit: 'idr', description: 'Total expenses' },
      'business.maintenance_requests': { type: 'counter', unit: 'count', description: 'Maintenance requests' },
      'business.guest_inquiries':  { type: 'counter', unit: 'count', description: 'Guest inquiries' },
      'business.emails_sent':      { type: 'counter', unit: 'count', description: 'Emails sent' },
      'business.web_scrapes':      { type: 'counter', unit: 'count', description: 'Web scraping operations' },

      // Division activity
      'division.villa':            { type: 'counter', unit: 'count', description: 'Villa division queries' },
      'division.agency':           { type: 'counter', unit: 'count', description: 'Agency division queries' },
      'division.furniture':        { type: 'counter', unit: 'count', description: 'Furniture division queries' },
      'division.renovation':       { type: 'counter', unit: 'count', description: 'Renovation division queries' },
      'division.interior':         { type: 'counter', unit: 'count', description: 'Interior design queries' },

      // Security metrics
      'security.threats_blocked':  { type: 'counter', unit: 'count', description: 'Threats blocked by AIDefence' },
      'security.rate_limited':     { type: 'counter', unit: 'count', description: 'Rate-limited senders' },
      'security.approvals_pending':{ type: 'gauge', unit: 'count', description: 'Pending approval requests' },

      // Quality metrics
      'quality.satisfaction':      { type: 'gauge', unit: 'percent', description: 'User satisfaction score' },
      'quality.routing_accuracy':  { type: 'gauge', unit: 'percent', description: 'Routing confidence average' },
      'quality.error_rate':        { type: 'gauge', unit: 'percent', description: 'Error rate' },

      // Agent metrics
      'agents.tasks_completed':    { type: 'counter', unit: 'count', description: 'Agent tasks completed' },
      'agents.consensus_reached':  { type: 'counter', unit: 'count', description: 'Swarm consensus decisions' },
      'agents.gossip_exchanged':   { type: 'counter', unit: 'count', description: 'Gossip messages exchanged' },
    };

    // In-memory buffers for fast writes
    this._buffer = [];
    this._bufferMax = 50;
    this._flushInterval = setInterval(() => this._flush(), 30000); // Flush every 30s

    console.log(`[Metrics] Initialized with ${Object.keys(this.metrics).length} metric definitions`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metric_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        tags TEXT DEFAULT '{}',
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS metric_aggregates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        period TEXT NOT NULL,
        period_start TEXT NOT NULL,
        sum_value REAL DEFAULT 0,
        count_value INTEGER DEFAULT 0,
        min_value REAL,
        max_value REAL,
        avg_value REAL,
        UNIQUE(metric_name, period, period_start)
      );

      CREATE TABLE IF NOT EXISTS metric_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        condition TEXT NOT NULL,
        threshold REAL NOT NULL,
        current_value REAL,
        status TEXT DEFAULT 'active',
        triggered_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_metric_points_name ON metric_points(metric_name, timestamp);
      CREATE INDEX IF NOT EXISTS idx_metric_agg ON metric_aggregates(metric_name, period);
    `);
  }

  /**
   * Record a metric value
   */
  record(metricName, value, tags = {}) {
    this._buffer.push({
      name: metricName,
      value,
      tags: JSON.stringify(tags),
      timestamp: new Date().toISOString(),
    });

    if (this._buffer.length >= this._bufferMax) {
      this._flush();
    }
  }

  /**
   * Increment a counter
   */
  increment(metricName, amount = 1, tags = {}) {
    this.record(metricName, amount, tags);
  }

  /**
   * Set a gauge value
   */
  gauge(metricName, value, tags = {}) {
    this.record(metricName, value, tags);
  }

  /**
   * Record a timing (histogram)
   */
  timing(metricName, durationMs, tags = {}) {
    this.record(metricName, durationMs, tags);
  }

  _flush() {
    if (this._buffer.length === 0) return;

    const insert = this.db.prepare(`
      INSERT INTO metric_points (metric_name, value, tags, timestamp) VALUES (?, ?, ?, ?)
    `);

    const tx = this.db.transaction((items) => {
      for (const item of items) {
        insert.run(item.name, item.value, item.tags, item.timestamp);
      }
    });

    try {
      tx(this._buffer);
    } catch (e) {
      // Silent fail — metrics are not critical
    }

    this._buffer = [];
  }

  /**
   * Aggregate metrics for a time period
   */
  aggregate(period = 'hour') {
    this._flush(); // Ensure buffer is written

    const periodFormats = {
      'minute': '%Y-%m-%dT%H:%M',
      'hour':   '%Y-%m-%dT%H',
      'day':    '%Y-%m-%d',
      'month':  '%Y-%m',
    };

    const format = periodFormats[period] || periodFormats['hour'];

    const rows = this.db.prepare(`
      SELECT
        metric_name,
        strftime('${format}', timestamp) as period_start,
        SUM(value) as sum_value,
        COUNT(*) as count_value,
        MIN(value) as min_value,
        MAX(value) as max_value,
        AVG(value) as avg_value
      FROM metric_points
      WHERE timestamp > datetime('now', '-24 hours')
      GROUP BY metric_name, period_start
    `).all();

    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO metric_aggregates (metric_name, period, period_start, sum_value, count_value, min_value, max_value, avg_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      upsert.run(row.metric_name, period, row.period_start, row.sum_value, row.count_value, row.min_value, row.max_value, row.avg_value);
    }

    return { aggregated: rows.length, period };
  }

  /**
   * Get metric data for dashboard
   */
  getDashboard(timeRange = '24h') {
    this._flush();

    const ranges = {
      '1h':  '-1 hour',
      '6h':  '-6 hours',
      '24h': '-24 hours',
      '7d':  '-7 days',
      '30d': '-30 days',
    };
    const range = ranges[timeRange] || ranges['24h'];

    const dashboard = {};

    // Get summaries for key metrics
    const summaryMetrics = [
      'messages.received', 'messages.boosted', 'messages.cached',
      'performance.api_calls', 'security.threats_blocked',
      'business.bookings_created', 'business.expenses_logged',
    ];

    for (const metric of summaryMetrics) {
      const row = this.db.prepare(`
        SELECT SUM(value) as total, COUNT(*) as points, AVG(value) as avg
        FROM metric_points
        WHERE metric_name = ? AND timestamp > datetime('now', ?)
      `).get(metric, range);

      dashboard[metric] = {
        total: row.total || 0,
        points: row.points || 0,
        avg: row.avg || 0,
      };
    }

    // Get latest gauge values
    const gaugeMetrics = ['quality.satisfaction', 'quality.routing_accuracy', 'quality.error_rate', 'performance.cache_hit_rate'];
    for (const metric of gaugeMetrics) {
      const latest = this.db.prepare(`
        SELECT value FROM metric_points
        WHERE metric_name = ? ORDER BY timestamp DESC LIMIT 1
      `).get(metric);

      dashboard[metric] = { current: latest ? latest.value : 0 };
    }

    // Division breakdown
    const divisions = this.db.prepare(`
      SELECT metric_name, SUM(value) as total
      FROM metric_points
      WHERE metric_name LIKE 'division.%' AND timestamp > datetime('now', ?)
      GROUP BY metric_name ORDER BY total DESC
    `).all(range);

    dashboard.divisionBreakdown = Object.fromEntries(
      divisions.map(d => [d.metric_name.replace('division.', ''), d.total])
    );

    // API cost estimate
    const apiCalls = dashboard['performance.api_calls']?.total || 0;
    dashboard.estimatedCost = {
      total: `$${(apiCalls * 0.003).toFixed(2)}`,
      saved: `$${((dashboard['messages.boosted']?.total || 0) + (dashboard['messages.cached']?.total || 0)) * 0.003}`,
    };

    return dashboard;
  }

  /**
   * Get metric context for system prompt (concise)
   */
  getMetricContext() {
    this._flush();

    const today = this.db.prepare(`
      SELECT metric_name, SUM(value) as total FROM metric_points
      WHERE timestamp > datetime('now', '-24 hours')
      GROUP BY metric_name
    `).all();

    if (today.length === 0) return '';

    const data = Object.fromEntries(today.map(r => [r.metric_name, r.total]));

    let ctx = '\n\n--- Today\'s Metrics ---\n';
    if (data['messages.received']) ctx += `Messages: ${data['messages.received']} received`;
    if (data['messages.boosted']) ctx += `, ${data['messages.boosted']} boosted (free)`;
    ctx += '\n';

    if (data['business.bookings_created']) ctx += `Bookings: ${data['business.bookings_created']} created\n`;
    if (data['security.threats_blocked']) ctx += `Security: ${data['security.threats_blocked']} threats blocked\n`;

    return ctx;
  }

  /**
   * Simple anomaly detection (z-score based)
   */
  detectAnomalies(metricName, windowHours = 24) {
    const points = this.db.prepare(`
      SELECT value FROM metric_points
      WHERE metric_name = ? AND timestamp > datetime('now', '-' || ? || ' hours')
      ORDER BY timestamp ASC
    `).all(metricName, windowHours);

    if (points.length < 10) return { anomaly: false, reason: 'insufficient data' };

    const values = points.map(p => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);

    const latest = values[values.length - 1];
    const zScore = stdDev > 0 ? (latest - mean) / stdDev : 0;

    return {
      anomaly: Math.abs(zScore) > 2,
      zScore,
      mean,
      stdDev,
      latest,
      direction: zScore > 0 ? 'above' : 'below',
    };
  }

  /**
   * Cleanup old metric points
   */
  cleanup(daysOld = 7) {
    const deleted = this.db.prepare(`
      DELETE FROM metric_points WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    return { deletedPoints: deleted.changes };
  }

  /**
   * Stop flush interval (for cleanup)
   */
  destroy() {
    if (this._flushInterval) clearInterval(this._flushInterval);
    this._flush();
  }

  getStats() {
    this._flush();
    const totalPoints = this.db.prepare('SELECT COUNT(*) as c FROM metric_points').get().c;
    const uniqueMetrics = this.db.prepare('SELECT COUNT(DISTINCT metric_name) as c FROM metric_points').get().c;
    return {
      definitions: Object.keys(this.metrics).length,
      totalPoints,
      uniqueMetrics,
      bufferSize: this._buffer.length,
    };
  }
}

module.exports = new MetricAggregator();
