// TVMbot Background Daemon
// Inspired by Ruflo's "12-worker" background daemon pattern
// Manages a pool of background workers for audits, optimization, and learning tasks

var Database = require('better-sqlite3');
var path = require('path');

var DATA_DIR = path.join(__dirname, 'data');

// Worker definitions
var WORKERS = {
  audit_trail: { interval: 30000, enabled: true },
  cache_warmer: { interval: 60000, enabled: true },
  memory_compactor: { interval: 120000, enabled: true },
  pattern_learner: { interval: 45000, enabled: true },
  metric_flusher: { interval: 15000, enabled: true },
  gossip_cleaner: { interval: 300000, enabled: true },
  drift_analyzer: { interval: 180000, enabled: true },
  feedback_processor: { interval: 40000, enabled: true },
  workflow_checker: { interval: 50000, enabled: true },
  escalation_reviewer: { interval: 90000, enabled: true },
  circuit_health: { interval: 25000, enabled: true },
  entity_linker: { interval: 60000, enabled: true }
};

var BackgroundDaemon = function() {
  this.db = null;
  this.workers = {};
  this.running = false;
  this.timers = [];
  this.currentWorkerIndex = 0;

  // Initialize worker state
  for (var workerName in WORKERS) {
    this.workers[workerName] = {
      name: workerName,
      interval: WORKERS[workerName].interval,
      enabled: WORKERS[workerName].enabled,
      lastRun: 0,
      runCount: 0,
      errorCount: 0
    };
  }
};

BackgroundDaemon.prototype.init = function() {
  try {
    var dbPath = path.join(DATA_DIR, 'daemon.db');
    this.db = new Database(dbPath);

    // Create daemon_log table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_name TEXT NOT NULL,
        run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        duration_ms INTEGER,
        status TEXT,
        error_message TEXT,
        run_count INTEGER
      )
    `);

    this.db.pragma('journal_mode = WAL');
    console.log('[Daemon] Initialized with ' + Object.keys(this.workers).length + ' workers');
    return true;
  } catch (err) {
    console.error('[Daemon] Init failed:', err.message);
    return false;
  }
};

BackgroundDaemon.prototype.start = function() {
  if (this.running) {
    console.log('[Daemon] Already running');
    return false;
  }

  if (!this.db) {
    this.init();
  }

  this.running = true;
  console.log('[Daemon] Starting daemon with round-robin scheduler');

  // Schedule round-robin worker execution
  var self = this;
  var scheduler = setInterval(function() {
    if (!self.running) return;

    var workerNames = Object.keys(self.workers);
    var currentWorker = self.workers[workerNames[self.currentWorkerIndex % workerNames.length]];

    self.currentWorkerIndex++;

    if (currentWorker.enabled) {
      var timeSinceLastRun = Date.now() - currentWorker.lastRun;
      if (timeSinceLastRun >= currentWorker.interval) {
        self._runWorker(currentWorker);
      }
    }
  }, 5000); // Check every 5 seconds which worker should run

  this.timers.push(scheduler);
  return true;
};

BackgroundDaemon.prototype._runWorker = function(worker) {
  var startTime = Date.now();

  try {
    var handler = this._getWorkerHandler(worker.name);
    handler.call(this);

    var duration = Date.now() - startTime;
    console.log('[Daemon] ' + worker.name + ' completed in ' + duration + 'ms');

    worker.lastRun = Date.now();
    worker.runCount++;

    // Log to database
    try {
      var stmt = this.db.prepare(`
        INSERT INTO daemon_log (worker_name, duration_ms, status, run_count)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(worker.name, duration, 'success', worker.runCount);
    } catch (dbErr) {
      console.error('[Daemon] Failed to log worker run:', dbErr.message);
    }
  } catch (err) {
    console.error('[Daemon] Worker ' + worker.name + ' failed:', err.message);
    worker.errorCount++;

    // Log error to database
    try {
      var stmt = this.db.prepare(`
        INSERT INTO daemon_log (worker_name, status, error_message, run_count)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(worker.name, 'error', err.message, worker.runCount);
    } catch (dbErr) {
      console.error('[Daemon] Failed to log worker error:', dbErr.message);
    }
  }
};

BackgroundDaemon.prototype._getWorkerHandler = function(workerName) {
  switch (workerName) {
    case 'audit_trail':
      return function() {
        // Log every AI action (tool calls, responses) with before/after state
        // This would integrate with the ResponseCache/ToolTracker
      };
    case 'cache_warmer':
      return function() {
        // Pre-warm the ResponseCache with common queries
        // Would read common patterns and pre-populate cache
      };
    case 'memory_compactor':
      return function() {
        // Run memory compaction when token count gets high
        // Would trigger cleanup of old entries if needed
      };
    case 'pattern_learner':
      return function() {
        // Analyze successful interactions to update ReasoningBank
        // Would analyze logs and extract patterns
      };
    case 'metric_flusher':
      return function() {
        // Flush buffered metrics to SQLite
        // Would write any in-memory metrics to database
      };
    case 'gossip_cleaner':
      return function() {
        // Clean expired gossip messages
        // Would remove old gossip entries from any gossip table
      };
    case 'drift_analyzer':
      return function() {
        // Check for performance/quality drift
        // Would analyze metrics for anomalies
      };
    case 'feedback_processor':
      return function() {
        // Process accumulated feedback signals
        // Would aggregate and analyze user feedback
      };
    case 'workflow_checker':
      return function() {
        // Check for stalled/failed workflows
        // Would identify workflows that need attention
      };
    case 'escalation_reviewer':
      return function() {
        // Review and auto-close old escalations
        // Would check escalation status and aging
      };
    case 'circuit_health':
      return function() {
        // Check circuit breaker health and attempt recovery
        // Would verify external service connections
      };
    case 'entity_linker':
      return function() {
        // Run entity extraction and knowledge graph linking
        // Would process extracted entities and link them
      };
    default:
      return function() {};
  }
};

BackgroundDaemon.prototype.stop = function() {
  if (!this.running) {
    console.log('[Daemon] Not running');
    return false;
  }

  this.running = false;

  // Clear all timers
  for (var i = 0; i < this.timers.length; i++) {
    clearInterval(this.timers[i]);
  }
  this.timers = [];

  if (this.db) {
    try {
      this.db.close();
    } catch (err) {
      console.error('[Daemon] Error closing database:', err.message);
    }
  }

  console.log('[Daemon] Stopped');
  return true;
};

BackgroundDaemon.prototype.getStats = function() {
  var stats = {
    running: this.running,
    workers: {}
  };

  for (var workerName in this.workers) {
    var worker = this.workers[workerName];
    stats.workers[workerName] = {
      enabled: worker.enabled,
      interval: worker.interval,
      lastRun: worker.lastRun,
      runCount: worker.runCount,
      errorCount: worker.errorCount
    };
  }

  return stats;
};

BackgroundDaemon.prototype.enableWorker = function(workerName) {
  if (!this.workers[workerName]) {
    console.error('[Daemon] Unknown worker:', workerName);
    return false;
  }

  this.workers[workerName].enabled = true;
  console.log('[Daemon] Enabled worker:', workerName);
  return true;
};

BackgroundDaemon.prototype.disableWorker = function(workerName) {
  if (!this.workers[workerName]) {
    console.error('[Daemon] Unknown worker:', workerName);
    return false;
  }

  this.workers[workerName].enabled = false;
  console.log('[Daemon] Disabled worker:', workerName);
  return true;
};

// Singleton pattern
var instance = null;

var getDaemon = function() {
  if (!instance) {
    instance = new BackgroundDaemon();
    instance.init();
  }
  return instance;
};

module.exports = getDaemon;
module.exports.BackgroundDaemon = BackgroundDaemon;
