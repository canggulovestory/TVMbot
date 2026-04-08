/**
 * Model Router — Multi-Model Routing (Haiku + Sonnet + GPT-4o-mini)
 *
 * Inspired by:
 *   - AutoGPT (Significant-Gravitas/AutoGPT): LlmModel + ModelMetadata(price_tier) pattern
 *   - ruflo multi-model optimization
 *
 * Routes queries to the cheapest adequate model:
 *   - Haiku 4.5:    Simple queries, classification, routing, FAQ, lookups    (Tier 1)
 *   - GPT-4o mini:  Content gen, marketing, general assistant, translations  (Tier 1)
 *   - Sonnet 4.5:   Complex reasoning, tool-use, analysis, strategy          (Tier 2)
 *   - Opus:         ❌ BANNED — Do not use, ever.
 *
 * Cost comparison (approximate USD per 1K tokens):
 *   GPT-4o mini: $0.00015 input / $0.0006 output  ← cheapest
 *   Haiku:       $0.0008  input / $0.004  output
 *   Sonnet:      $0.003   input / $0.015  output
 *
 * Design:
 *   - Intent-based model selection (INTENT_ROUTING table)
 *   - Complexity scoring (word count, entities, multi-step indicators)
 *   - Tool count threshold (≥2 tools → Sonnet)
 *   - Agent Booster bypass (simple queries skip LLM entirely = $0)
 *   - Automatic Anthropic → OpenAI fallback on rate limit
 *   - Full cost tracking for all 3 models
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { MODEL_REGISTRY, INTENT_ROUTING, modelForIntent } = require('./llm-provider');

const DB_PATH = path.join(__dirname, 'data', 'model-router.db');

// Expose model IDs from the central registry
const MODELS = {
  haiku:    MODEL_REGISTRY['haiku'].id,
  sonnet:   MODEL_REGISTRY['sonnet'].id,
  chatgpt:  MODEL_REGISTRY['gpt-mini'].id,
};

// Cost per 1K tokens from central registry
const COST_PER_1K = {
  haiku:   MODEL_REGISTRY['haiku'].costPer1K,
  sonnet:  MODEL_REGISTRY['sonnet'].costPer1K,
  chatgpt: MODEL_REGISTRY['gpt-mini'].costPer1K,
};

class ModelRouter {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Intents → Haiku (cheap tier-1, fast classification + simple lookups)
    this.haikuIntents = new Set([
      'greeting', 'status', 'thanks', 'acknowledgment',
      'villa_list', 'identity', 'faq',
      'file_search', 'hr', 'classify', 'route',
    ]);

    // Intents → ChatGPT/GPT-4o-mini (content, creative, general assistant)
    // ❌ These were previously Opus — now handled by GPT-4o-mini (20× cheaper)
    this.chatgptIntents = new Set([
      'marketing',          // Instagram, Airbnb, Facebook content
      'general_assistant',  // general Q&A, translations, advice
      'translation',        // language translation
      'content_gen',        // any creative content generation
      'guest_comms',        // welcome letters, review requests
    ]);

    // Intents that MUST use Sonnet (complex reasoning + tool orchestration)
    this.sonnetOnlyIntents = new Set([
      'booking', 'finance', 'calendar', 'email',
      'data_analysis', 'document_intelligence',
      'advice', 'audit', 'renovation', 'interior',
      'maintenance', 'data_ops', 'agency', 'scraping',
      'error_recovery', 'multi_write',
    ]);

    // Complexity indicators that push toward Sonnet
    this.complexityPatterns = [
      { pattern: /\b(?:compare|analyze|analysis|evaluate|assess|recommend|strategy|optimize|plan)\b/i, weight: 0.3 },
      { pattern: /\b(?:report|summary|overview|breakdown|insight|trend)\b/i, weight: 0.25 },
      { pattern: /\b(?:why|how come|explain|reason|because)\b/i, weight: 0.15 },
      { pattern: /\b(?:all (?:villas|bookings|expenses|guests)|across|every|each)\b/i, weight: 0.2 },
      { pattern: /\b(?:create|draft|write|compose|prepare|generate)\b/i, weight: 0.2 },
      { pattern: /\b(?:and also|additionally|furthermore|plus|as well as)\b/i, weight: 0.15 },
      { pattern: /\b(?:calculate|compute|total|sum|average|percentage)\b/i, weight: 0.2 },
      { pattern: /\b(?:if.*then|scenario|what if|suppose|imagine)\b/i, weight: 0.25 },
      { pattern: /\b(?:urgent|emergency|critical|asap|immediately)\b/i, weight: 0.1 }, // urgency → better model
    ];

    // Simple query indicators that push toward Haiku
    this.simplicityPatterns = [
      { pattern: /^(?:hi|hello|hey|halo|hai|good (?:morning|afternoon|evening))/i, weight: -0.5 },
      { pattern: /^(?:thanks|thank you|terima kasih|makasih|ok|okay|oke|got it|noted)/i, weight: -0.5 },
      { pattern: /^(?:yes|no|ya|tidak|benar|salah)\b/i, weight: -0.4 },
      { pattern: /^(?:what(?:'s| is) (?:the )?(?:status|time|date|weather))/i, weight: -0.3 },
      { pattern: /^(?:show|list|get|check|look up|find)\s+\w+$/i, weight: -0.2 },
    ];

    console.log(`[ModelRouter] Initialized — Haiku: ${MODELS.haiku}, Sonnet: ${MODELS.sonnet}`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_chosen TEXT NOT NULL,
        intent TEXT,
        complexity_score REAL,
        reason TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_actual REAL DEFAULT 0,
        cost_if_sonnet REAL DEFAULT 0,
        cost_saved REAL DEFAULT 0,
        fallback_used INTEGER DEFAULT 0,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS model_stats (
        period TEXT NOT NULL,
        model TEXT NOT NULL,
        call_count INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        total_savings REAL DEFAULT 0,
        avg_complexity REAL DEFAULT 0,
        PRIMARY KEY (period, model)
      );

      CREATE INDEX IF NOT EXISTS idx_model_decisions_ts ON model_decisions(timestamp);
    `);
  }

  /**
   * Choose the best model for a given message/context
   * Returns: { model, modelId, reason, complexity }
   */
  chooseModel(message, context = {}) {
    const {
      intent = null,
      confidence = 0.5,
      toolCount = 0,
      isEscalated = false,
      isVIP = false,
      decomposed = false,
      agentCount = 1,
    } = context;

    // ── Override rules ────────────────────────────────────────────────────

    // 1. Sonnet-only intents (complex reasoning, tool use)
    if (intent && this.sonnetOnlyIntents.has(intent)) {
      return this._decide('sonnet', intent, 0.85, `Intent "${intent}" → Sonnet (reasoning/tools)`);
    }

    // 2. ChatGPT intents (content generation, creative, general assistant)
    if (intent && this.chatgptIntents.has(intent)) {
      return this._decide('chatgpt', intent, 0.85, `Intent "${intent}" → GPT-4o-mini (content/creative)`);
    }

    // 3. VIP or escalated → Sonnet
    if (isVIP || isEscalated) {
      return this._decide('sonnet', intent, 1.0, 'VIP or escalated → Sonnet');
    }

    // 4. Decomposed multi-step task → Sonnet
    if (decomposed) {
      return this._decide('sonnet', intent, 0.9, 'Multi-step decomposed → Sonnet');
    }

    // 5. ≥2 tools → Sonnet (tool orchestration)
    if (toolCount >= 2) {
      return this._decide('sonnet', intent, 0.8, `${toolCount} tools → Sonnet`);
    }

    // 6. Multiple agents → Sonnet
    if (agentCount >= 3) {
      return this._decide('sonnet', intent, 0.85, `${agentCount} agents → Sonnet`);
    }

    // ── Complexity scoring ──
    let complexityScore = 0;

    // Check simplicity patterns (pull toward Haiku)
    for (const { pattern, weight } of this.simplicityPatterns) {
      if (pattern.test(message)) {
        complexityScore += weight; // negative = simpler
      }
    }

    // Check complexity patterns (pull toward Sonnet)
    for (const { pattern, weight } of this.complexityPatterns) {
      if (pattern.test(message)) {
        complexityScore += weight; // positive = more complex
      }
    }

    // Message length factor
    const wordCount = message.split(/\s+/).length;
    if (wordCount > 50) complexityScore += 0.2;
    if (wordCount > 100) complexityScore += 0.2;
    if (wordCount < 10) complexityScore -= 0.15;

    // Low routing confidence = probably complex/ambiguous → Sonnet
    if (confidence < 0.3) complexityScore += 0.3;

    // Intent-based preference
    if (intent && this.haikuIntents.has(intent)) {
      complexityScore -= 0.25;
    }

    // Tool usage factor
    if (toolCount === 0) complexityScore -= 0.1;
    if (toolCount >= 2) complexityScore += 0.15;

    // ── Decision ──
    const threshold = 0.15; // Above this = Sonnet, below = Haiku

    if (complexityScore <= threshold) {
      return this._decide('haiku', intent, complexityScore, `Low complexity (${complexityScore.toFixed(2)})`);
    } else {
      return this._decide('sonnet', intent, complexityScore, `High complexity (${complexityScore.toFixed(2)})`);
    }
  }

  _decide(model, intent, complexity, reason) {
    // Guard: never return Opus
    if (model && model.includes('opus')) {
      console.error('[ModelRouter] ❌ Opus blocked — routing to sonnet instead');
      model = 'sonnet';
    }
    return {
      model: model,
      modelId: MODELS[model],
      provider: MODEL_REGISTRY[model === 'chatgpt' ? 'gpt-mini' : model]?.provider || 'anthropic',
      reason: reason,
      complexity: complexity,
      costPer1K: COST_PER_1K[model],
    };
  }

  /**
   * Record the result of a model call (for cost tracking)
   */
  recordUsage(model, intent, inputTokens, outputTokens, complexity, fallbackUsed = false) {
    const cost = COST_PER_1K[model] || COST_PER_1K.sonnet;
    const actualCost = (inputTokens / 1000) * cost.input + (outputTokens / 1000) * cost.output;
    const sonnetCost = (inputTokens / 1000) * COST_PER_1K.sonnet.input + (outputTokens / 1000) * COST_PER_1K.sonnet.output;
    // Savings = how much cheaper than running everything on Sonnet
    const saved = (model === 'haiku' || model === 'chatgpt') ? Math.max(0, sonnetCost - actualCost) : 0;

    this.db.prepare(`
      INSERT INTO model_decisions (model_chosen, intent, complexity_score, reason, input_tokens, output_tokens, cost_actual, cost_if_sonnet, cost_saved, fallback_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(model, intent, complexity, '', inputTokens, outputTokens, actualCost, sonnetCost, saved, fallbackUsed ? 1 : 0);

    // Update monthly stats
    const period = new Date().toISOString().substring(0, 7);
    this.db.prepare(`
      INSERT INTO model_stats (period, model, call_count, total_cost, total_savings, avg_complexity)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(period, model) DO UPDATE SET
        call_count = call_count + 1,
        total_cost = total_cost + ?,
        total_savings = total_savings + ?,
        avg_complexity = (avg_complexity * call_count + ?) / (call_count + 1)
    `).run(period, model, actualCost, saved, complexity, actualCost, saved, complexity);

    return { actualCost, sonnetCost, saved };
  }

  /**
   * Get cost summary
   */
  getCostSummary(period = null) {
    const p = period || new Date().toISOString().substring(0, 7);

    const stats = this.db.prepare(`
      SELECT model, call_count, total_cost, total_savings, avg_complexity
      FROM model_stats WHERE period = ?
    `).all(p);

    const totalCalls = stats.reduce((s, r) => s + r.call_count, 0);
    const totalCost = stats.reduce((s, r) => s + r.total_cost, 0);
    const totalSavings = stats.reduce((s, r) => s + r.total_savings, 0);
    const haikuStats   = stats.find(s => s.model === 'haiku')   || { call_count: 0, total_cost: 0 };
    const sonnetStats  = stats.find(s => s.model === 'sonnet')  || { call_count: 0, total_cost: 0 };
    const chatgptStats = stats.find(s => s.model === 'chatgpt') || { call_count: 0, total_cost: 0 };

    const cheapPercent = totalCalls > 0
      ? ((haikuStats.call_count + chatgptStats.call_count) / totalCalls * 100).toFixed(1) : 0;

    return {
      period: p,
      totalCalls,
      totalCost: `$${totalCost.toFixed(4)}`,
      totalSavings: `$${totalSavings.toFixed(4)}`,
      haiku:   { calls: haikuStats.call_count,   cost: `$${haikuStats.total_cost.toFixed(4)}` },
      sonnet:  { calls: sonnetStats.call_count,  cost: `$${sonnetStats.total_cost.toFixed(4)}` },
      chatgpt: { calls: chatgptStats.call_count, cost: `$${chatgptStats.total_cost.toFixed(4)}` },
      cheapPercent: `${cheapPercent}%`,
    };
  }

  /**
   * Get context for system prompt
   */
  getModelContext() {
    const summary = this.getCostSummary();
    if (summary.totalCalls === 0) return '';
    return `\n[Model Router] ${summary.haiku.percent} of queries routed to Haiku. Saved ${summary.totalSavings} this month.\n`;
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM model_decisions').get().c;
    const summary = this.getCostSummary();
    return {
      totalDecisions: total,
      ...summary,
      models: {
        haiku:   MODELS.haiku,
        sonnet:  MODELS.sonnet,
        chatgpt: MODELS.chatgpt,
        opus:    '❌ BANNED',
      },
    };
  }
}

module.exports = new ModelRouter();
module.exports.MODELS = MODELS;
module.exports.COST_PER_1K = COST_PER_1K;
