/**
 * TVMbot Smart Model Router
 *
 * Adapted from AutoGPT (Significant-Gravitas/AutoGPT) + wshobson/agents 3-tier strategy.
 * Routes each incoming message to the cheapest adequate model.
 *
 * Haiku   = read-only lookups, classification, routing       (Tier 1 — fast)
 * Sonnet  = write operations, tool use, reasoning, recovery  (Tier 2 — standard)
 * ChatGPT = content gen, marketing, general assistant        (Tier 1 — cheap creative)
 * Opus    = ❌ BANNED — not used anywhere in TVMbot
 *
 * Estimated savings: 60-80% vs running everything on Sonnet.
 */

const fs = require('fs');
const path = require('path');

// Default config — overridden by config/models.json if it exists
const DEFAULT_CONFIG = {
  models: {
    fast:     'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-5-20250929',
    advanced: 'claude-sonnet-4-5-20250929',  // ❌ Opus removed — Sonnet handles error recovery
  },
  routes: {
    read_only: 'fast',
    single_write: 'standard',
    multi_write: 'standard',
    error_recovery: 'advanced'
  },
  // Keywords that indicate read-only intent (no writes needed)
  readKeywords: [
    'status', 'check', 'show', 'list', 'what', 'how many', 'balance',
    'total', 'pending', 'overdue', 'schedule', 'upcoming', 'today',
    'summary', 'report', 'count', 'display', 'view', 'get', 'fetch',
    'look up', 'find', 'search', 'who', 'when', 'where', 'which', 'bookings', 'overview', 'how many', 'how much', 'count', 'total', 'list all'
  ],
  // Keywords that indicate single-write intent
  writeKeywords: [
    'log', 'add', 'update', 'record', 'mark', 'set', 'change',
    'enter', 'submit', 'save', 'complete', 'done', 'finish',
    'assign', 'create', 'new', 'book', 'register'
  ],
  // Keywords that indicate multi-write (cross-sheet) intent
  multiWriteKeywords: [
    'sync', 'transfer', 'reconcile', 'migrate', 'onboard',
    'month-end', 'close', 'bulk', 'all villas', 'full update'
  ],
  // Keywords that indicate error recovery is needed
  errorKeywords: [
    'fix', 'resolve', 'rollback', 'undo', 'revert', 'broken',
    'error', 'wrong', 'mistake', 'incorrect', 'failed', 'crash'
  ]
};

class ModelRouter {
  constructor(configPath) {
    this.configPath = configPath || path.join(__dirname, '..', 'config', 'models.json');
    this.config = this._loadConfig();
    this.stats = {
      fast: 0,
      standard: 0,
      advanced: 0,
      totalSaved: 0 // estimated token savings vs always using standard
    };
  }

  /**
   * Load config from file, fall back to defaults
   */
  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        return { ...DEFAULT_CONFIG, ...fileConfig };
      }
    } catch (err) {
      console.log('[Router] Config load failed, using defaults:', err.message);
    }
    return DEFAULT_CONFIG;
  }

  /**
   * Reload config without restarting the bot
   */
  reloadConfig() {
    this.config = this._loadConfig();
    console.log('[Router] Config reloaded');
  }

  /**
   * Classify a message into a route category
   * Returns: 'read_only' | 'single_write' | 'multi_write' | 'error_recovery'
   */
  classifyMessage(message) {
    if (!message || typeof message !== 'string') return 'single_write';

    const lower = message.toLowerCase().trim();

    // Priority 0: Multi-word read phrases (prevents 'how many bookings' matching 'book')
    const readPhrases = ['how many', 'how much', 'list all', 'show all', 'count of', 'total of', 'overview of'];
    if (readPhrases.some(p => lower.includes(p))) return 'read_only';

    // Priority 1: Error recovery keywords (highest priority)
    const errorScore = this._scoreKeywords(lower, this.config.errorKeywords);
    if (errorScore >= 2) return 'error_recovery';

    // Priority 2: Multi-write keywords
    const multiScore = this._scoreKeywords(lower, this.config.multiWriteKeywords);
    if (multiScore >= 1) return 'multi_write';

    // Priority 3: Single-write keywords
    const writeScore = this._scoreKeywords(lower, this.config.writeKeywords);

    // Priority 4: Read-only keywords
    const readScore = this._scoreKeywords(lower, this.config.readKeywords);

    // If message is a question (ends with ?) it's likely read-only
    const isQuestion = lower.endsWith('?');

    // Decision logic
    if (writeScore > readScore) return 'single_write';
    if (readScore > 0 && writeScore === 0) return 'read_only';
    if (isQuestion && writeScore === 0) return 'read_only';

    // Default: standard model for ambiguous messages
    return 'single_write';
  }

  /**
   * Count how many keywords from a list appear in the message
   */
  _scoreKeywords(message, keywords) {
    let score = 0;
    for (const keyword of keywords) {
      if (message.includes(keyword)) score++;
    }
    return score;
  }

  /**
   * Main entry point: select the right model for a message
   * Returns the full model string (e.g., 'claude-sonnet-4-5-20250929')
   */
  selectModel(message) {
    const category = this.classifyMessage(message);
    const tier = this.config.routes[category];
    const model = this.config.models[tier];

    // Track usage stats
    this.stats[tier]++;
    if (tier === 'fast') {
      // Haiku is roughly 10x cheaper than Sonnet per token
      this.stats.totalSaved++;
    }

    console.log(`[Router] "${message.substring(0, 50)}..." → ${category} → ${tier} (${model})`);
    return model;
  }

  /**
   * Force a specific tier for a known operation
   * Used by executor.js when it knows the task type already
   */
  forceModel(tier) {
    const model = this.config.models[tier] || this.config.models.standard;
    this.stats[tier]++;
    return model;
  }

  /**
   * Get usage statistics
   */
  getStats() {
    const total = this.stats.fast + this.stats.standard + this.stats.advanced;
    return {
      total,
      breakdown: {
        fast: this.stats.fast,
        standard: this.stats.standard,
        advanced: this.stats.advanced
      },
      estimatedSavingsPercent: total > 0
        ? Math.round((this.stats.fast / total) * 90) // Haiku is ~90% cheaper
        : 0,
      readQueryCount: this.stats.fast,
      writeQueryCount: this.stats.standard,
      complexQueryCount: this.stats.advanced
    };
  }

  /**
   * Reset stats (for daily/weekly reporting)
   */
  resetStats() {
    this.stats = { fast: 0, standard: 0, advanced: 0, totalSaved: 0 };
  }
}

// Export singleton instance
const router = new ModelRouter();
module.exports = router;
