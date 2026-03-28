/**
 * reasoning-bank.js — Self-Learning ReasoningBank for TVMbot
 * Inspired by ruflo's ReasoningBank with RETRIEVE→JUDGE→DISTILL→CONSOLIDATE→ROUTE lifecycle
 *
 * TVMbot learns from every interaction:
 *   - Successful patterns are stored with fingerprints
 *   - Similar future tasks are routed to proven strategies
 *   - Failed patterns are penalized and avoided
 *   - Over time, the bot gets faster and more accurate
 *
 * Learning Loop:
 *   Message → RETRIEVE similar patterns → JUDGE quality → Execute →
 *   DISTILL outcome → CONSOLIDATE into memory → ROUTE future tasks
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── DATABASE ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'reasoning-bank.db');
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
  CREATE TABLE IF NOT EXISTS patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT UNIQUE NOT NULL,
    intent TEXT NOT NULL,
    message_template TEXT NOT NULL,
    skills_used TEXT DEFAULT '[]',
    tools_used TEXT DEFAULT '[]',
    agents_used TEXT DEFAULT '[]',
    strategy TEXT,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    total_uses INTEGER DEFAULT 0,
    avg_response_time_ms REAL DEFAULT 0,
    avg_quality REAL DEFAULT 0.5,
    confidence REAL DEFAULT 0.5,
    last_used TEXT,
    created_at TEXT,
    tags TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_id INTEGER,
    message TEXT NOT NULL,
    response_summary TEXT,
    success INTEGER DEFAULT 1,
    quality REAL DEFAULT 0.5,
    response_time_ms INTEGER,
    user_feedback TEXT,
    tokens_used INTEGER DEFAULT 0,
    was_boosted INTEGER DEFAULT 0,
    timestamp TEXT,
    FOREIGN KEY (pattern_id) REFERENCES patterns(id)
  );

  CREATE TABLE IF NOT EXISTS strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    applicable_intents TEXT DEFAULT '[]',
    success_rate REAL DEFAULT 0.5,
    total_uses INTEGER DEFAULT 0,
    avg_tokens INTEGER DEFAULT 0,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS learning_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    details TEXT,
    impact REAL DEFAULT 0,
    timestamp TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_patterns_intent ON patterns(intent);
  CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
  CREATE INDEX IF NOT EXISTS idx_outcomes_pattern ON outcomes(pattern_id);
`);

// ─── FINGERPRINTING ──────────────────────────────────────────────────────────
// Convert a message into a canonical fingerprint for pattern matching

function fingerprint(message) {
  const clean = message.toLowerCase()
    .replace(/\[whatsapp.*?\]/gi, '')    // Remove WhatsApp context
    .replace(/\[replying to:.*?\]/gi, '') // Remove reply context
    .replace(/[^\w\s]/g, ' ')            // Remove punctuation
    .replace(/\s+/g, ' ')               // Normalize whitespace
    .trim();

  // Extract key semantic tokens (skip stop words)
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'at', 'by', 'with', 'from', 'up', 'about', 'into', 'through',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
    'too', 'very', 'just', 'because', 'as', 'until', 'while', 'this',
    'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you',
    'your', 'it', 'its', 'they', 'them', 'their', 'what', 'which',
    'who', 'whom', 'when', 'where', 'why', 'how', 'please', 'thanks',
    // Bahasa Indonesia stop words
    'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada',
    'ini', 'itu', 'ada', 'tidak', 'sudah', 'akan', 'bisa', 'juga',
    'saya', 'kami', 'kita', 'anda', 'mereka', 'nya', 'lah', 'kah',
    'dong', 'deh', 'sih', 'ya', 'tolong', 'mohon',
  ]);

  const tokens = clean.split(' ')
    .filter(w => w.length > 2 && !stopWords.has(w))
    .sort();

  // Group into a canonical form
  return tokens.join('_') || 'empty';
}

// Similarity between two fingerprints (Jaccard index)
function similarity(fp1, fp2) {
  const set1 = new Set(fp1.split('_'));
  const set2 = new Set(fp2.split('_'));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

// ─── REASONING BANK CLASS ───────────────────────────────────────────────────

class ReasoningBank {
  constructor() {
    this._seedStrategies();
    const patternCount = db.prepare('SELECT COUNT(*) as c FROM patterns').get().c;
    console.log(`[ReasoningBank] Initialized with ${patternCount} learned patterns`);
  }

  // ═══════════════════════════════════════════════════════════
  // RETRIEVE — Find similar past patterns
  // ═══════════════════════════════════════════════════════════

  retrieve(message, intent, limit = 3) {
    const fp = fingerprint(message);

    // First: exact fingerprint match
    const exact = db.prepare('SELECT * FROM patterns WHERE fingerprint = ? AND confidence > 0.3')
      .get(fp);
    if (exact) {
      return {
        type: 'exact',
        patterns: [this._enrichPattern(exact)],
        confidence: exact.confidence,
      };
    }

    // Second: same-intent patterns sorted by confidence
    const intentPatterns = db.prepare(
      'SELECT * FROM patterns WHERE intent = ? AND confidence > 0.3 ORDER BY confidence DESC, total_uses DESC LIMIT ?'
    ).all(intent, limit * 2);

    // Score by similarity
    const scored = intentPatterns.map(p => ({
      ...this._enrichPattern(p),
      similarity: similarity(fp, p.fingerprint),
    }))
    .filter(p => p.similarity > 0.2) // At least 20% token overlap
    .sort((a, b) => (b.similarity * b.confidence) - (a.similarity * a.confidence))
    .slice(0, limit);

    if (scored.length > 0) {
      return {
        type: 'similar',
        patterns: scored,
        confidence: scored[0].confidence * scored[0].similarity,
      };
    }

    // Third: any high-confidence pattern for guidance
    const general = db.prepare(
      'SELECT * FROM patterns WHERE confidence > 0.7 ORDER BY total_uses DESC LIMIT ?'
    ).all(limit);

    return {
      type: 'general',
      patterns: general.map(p => this._enrichPattern(p)),
      confidence: 0.1,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // JUDGE — Evaluate if a retrieved pattern applies
  // ═══════════════════════════════════════════════════════════

  judge(pattern, currentMessage, currentIntent) {
    if (!pattern) return { applicable: false, score: 0 };

    let score = pattern.confidence || 0.5;

    // Boost if intent matches
    if (pattern.intent === currentIntent) score += 0.2;

    // Boost if high success rate
    const successRate = pattern.total_uses > 0
      ? pattern.success_count / pattern.total_uses
      : 0.5;
    score += successRate * 0.2;

    // Penalize if recently failed
    if (pattern.fail_count > pattern.success_count) score -= 0.3;

    // Penalize if stale (no use in 30 days)
    if (pattern.last_used) {
      const daysSince = (Date.now() - new Date(pattern.last_used).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) score -= 0.1;
    }

    return {
      applicable: score > 0.4,
      score: Math.max(0, Math.min(1, score)),
      recommendation: score > 0.7 ? 'use_pattern' : score > 0.4 ? 'use_with_caution' : 'ignore',
    };
  }

  // ═══════════════════════════════════════════════════════════
  // DISTILL — Extract learnings from a completed task
  // ═══════════════════════════════════════════════════════════

  distill(message, intent, outcome) {
    const {
      skills = [],
      tools = [],
      agents = [],
      success = true,
      quality = 0.5,
      responseTimeMs = 0,
      tokenCount = 0,
      wasBoosted = false,
      responseSummary = '',
    } = outcome;

    const fp = fingerprint(message);

    // Create or update pattern
    const existing = db.prepare('SELECT * FROM patterns WHERE fingerprint = ?').get(fp);

    if (existing) {
      // Update existing pattern
      const newAvgTime = (existing.avg_response_time_ms * existing.total_uses + responseTimeMs) / (existing.total_uses + 1);
      const newAvgQuality = (existing.avg_quality * existing.total_uses + quality) / (existing.total_uses + 1);
      const newConfidence = this._calculateConfidence(
        existing.success_count + (success ? 1 : 0),
        existing.fail_count + (success ? 0 : 1),
        newAvgQuality
      );

      db.prepare(`UPDATE patterns SET
        success_count = success_count + ?,
        fail_count = fail_count + ?,
        total_uses = total_uses + 1,
        avg_response_time_ms = ?,
        avg_quality = ?,
        confidence = ?,
        last_used = ?,
        skills_used = ?,
        tools_used = ?,
        agents_used = ?
        WHERE fingerprint = ?`)
        .run(
          success ? 1 : 0,
          success ? 0 : 1,
          newAvgTime,
          newAvgQuality,
          newConfidence,
          new Date().toISOString(),
          JSON.stringify(skills),
          JSON.stringify(tools),
          JSON.stringify(agents),
          fp
        );
    } else {
      // Create new pattern
      const confidence = this._calculateConfidence(success ? 1 : 0, success ? 0 : 1, quality);

      db.prepare(`INSERT INTO patterns
        (fingerprint, intent, message_template, skills_used, tools_used, agents_used, success_count, fail_count, total_uses, avg_response_time_ms, avg_quality, confidence, last_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(
          fp, intent, message.substring(0, 200),
          JSON.stringify(skills), JSON.stringify(tools), JSON.stringify(agents),
          success ? 1 : 0, success ? 0 : 1,
          responseTimeMs, quality, confidence,
          new Date().toISOString(), new Date().toISOString()
        );
    }

    // Log the outcome
    const patternRow = db.prepare('SELECT id FROM patterns WHERE fingerprint = ?').get(fp);
    if (patternRow) {
      db.prepare(`INSERT INTO outcomes (pattern_id, message, response_summary, success, quality, response_time_ms, tokens_used, was_boosted, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(patternRow.id, message.substring(0, 500), responseSummary.substring(0, 500),
          success ? 1 : 0, quality, responseTimeMs, tokenCount, wasBoosted ? 1 : 0,
          new Date().toISOString());
    }

    // Log learning event
    this._logLearning(success ? 'pattern_reinforced' : 'pattern_penalized',
      `Intent: ${intent}, Quality: ${quality}, Time: ${responseTimeMs}ms`,
      quality - 0.5 // Positive impact if quality > 0.5
    );

    return { fingerprint: fp, patternUpdated: !!existing, confidence: this._calculateConfidence(
      (existing?.success_count || 0) + (success ? 1 : 0),
      (existing?.fail_count || 0) + (success ? 0 : 1),
      quality
    )};
  }

  // ═══════════════════════════════════════════════════════════
  // CONSOLIDATE — Periodic cleanup and pattern optimization
  // ═══════════════════════════════════════════════════════════

  consolidate() {
    const startTime = Date.now();
    let actions = 0;

    // 1. Decay old patterns (reduce confidence of unused patterns)
    const stalePatterns = db.prepare(
      "SELECT id, confidence FROM patterns WHERE last_used < datetime('now', '-30 days') AND confidence > 0.2"
    ).all();

    for (const p of stalePatterns) {
      db.prepare('UPDATE patterns SET confidence = ? WHERE id = ?')
        .run(p.confidence * 0.9, p.id); // 10% decay
      actions++;
    }

    // 2. Remove very low-confidence patterns (noise)
    const removed = db.prepare(
      "DELETE FROM patterns WHERE confidence < 0.1 AND total_uses < 3 AND created_at < datetime('now', '-7 days')"
    ).run();
    actions += removed.changes;

    // 3. Cleanup old outcomes (keep last 1000)
    const outcomeCount = db.prepare('SELECT COUNT(*) as c FROM outcomes').get().c;
    if (outcomeCount > 1000) {
      db.prepare('DELETE FROM outcomes WHERE id NOT IN (SELECT id FROM outcomes ORDER BY id DESC LIMIT 1000)').run();
      actions++;
    }

    // 4. Update strategy success rates
    this._updateStrategyStats();

    this._logLearning('consolidation', `${actions} actions, ${stalePatterns.length} decayed, ${removed.changes} removed`,
      actions * 0.01);

    return {
      duration: Date.now() - startTime,
      staleDecayed: stalePatterns.length,
      removed: removed.changes,
      totalPatterns: db.prepare('SELECT COUNT(*) as c FROM patterns').get().c,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // ROUTE — Get routing suggestion based on learned patterns
  // ═══════════════════════════════════════════════════════════

  getRoutingSuggestion(message, intent) {
    const retrieved = this.retrieve(message, intent);
    if (retrieved.patterns.length === 0) {
      return { hasLearning: false, suggestion: null };
    }

    const topPattern = retrieved.patterns[0];
    const judgment = this.judge(topPattern, message, intent);

    if (!judgment.applicable) {
      return { hasLearning: false, suggestion: null };
    }

    return {
      hasLearning: true,
      suggestion: {
        skills: JSON.parse(topPattern.skills_used || '[]'),
        tools: JSON.parse(topPattern.tools_used || '[]'),
        agents: JSON.parse(topPattern.agents_used || '[]'),
        strategy: topPattern.strategy,
        confidence: judgment.score,
        avgResponseTime: topPattern.avg_response_time_ms,
        successRate: topPattern.total_uses > 0
          ? (topPattern.success_count / topPattern.total_uses * 100).toFixed(0) + '%'
          : 'unknown',
        basedOnUses: topPattern.total_uses,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════
  // BUILD CONTEXT — Add learning context to system prompt
  // ═══════════════════════════════════════════════════════════

  buildLearningContext(message, intent) {
    const suggestion = this.getRoutingSuggestion(message, intent);
    if (!suggestion.hasLearning) return '';

    const s = suggestion.suggestion;
    const parts = ['\n--- LEARNED PATTERNS ---'];
    parts.push(`Based on ${s.basedOnUses} similar past tasks (${s.successRate} success rate):`);

    if (s.skills.length > 0) {
      parts.push(`- Best skills for this type of task: ${s.skills.join(', ')}`);
    }
    if (s.strategy) {
      parts.push(`- Recommended strategy: ${s.strategy}`);
    }
    parts.push(`- Expected response time: ~${Math.round(s.avgResponseTime / 1000)}s`);
    parts.push('--- END LEARNED PATTERNS ---\n');

    return parts.join('\n');
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────

  _calculateConfidence(successCount, failCount, quality) {
    const total = successCount + failCount;
    if (total === 0) return 0.5;

    const successRate = successCount / total;
    // Wilson score lower bound (simplified) for small sample confidence
    const z = 1.96; // 95% confidence
    const n = total;
    const p = successRate;
    const wilsonLower = (p + z*z/(2*n) - z * Math.sqrt((p*(1-p) + z*z/(4*n))/n)) / (1 + z*z/n);

    // Blend with quality
    return Math.max(0, Math.min(1, wilsonLower * 0.6 + quality * 0.4));
  }

  _enrichPattern(pattern) {
    return {
      ...pattern,
      skills_used: pattern.skills_used,
      tools_used: pattern.tools_used,
      agents_used: pattern.agents_used,
      tags: pattern.tags,
    };
  }

  _logLearning(eventType, details, impact = 0) {
    try {
      db.prepare('INSERT INTO learning_events (event_type, details, impact, timestamp) VALUES (?, ?, ?, ?)')
        .run(eventType, details, impact, new Date().toISOString());
    } catch (e) { /* ignore */ }
  }

  _seedStrategies() {
    const count = db.prepare('SELECT COUNT(*) as c FROM strategies').get().c;
    if (count > 0) return;

    const strategies = [
      ['direct_lookup', 'Single tool call to look up data', '["booking","calendar","data_ops"]'],
      ['multi_step', 'Multiple sequential tool calls', '["finance","audit","data_analysis"]'],
      ['search_then_read', 'Search for file then read contents', '["file_search","document_intelligence"]'],
      ['cross_reference', 'Read from multiple sources and combine', '["data_analysis","audit","advice"]'],
      ['create_and_confirm', 'Create/update data then confirm', '["booking","maintenance","finance"]'],
      ['analyze_and_advise', 'Analyze data then provide recommendation', '["advice","data_analysis"]'],
    ];

    const stmt = db.prepare('INSERT INTO strategies (name, description, applicable_intents, created_at) VALUES (?, ?, ?, ?)');
    for (const [name, desc, intents] of strategies) {
      stmt.run(name, desc, intents, new Date().toISOString());
    }
    console.log('[ReasoningBank] Seeded strategies');
  }

  _updateStrategyStats() {
    // Update strategy stats based on recent outcomes
    const strategies = db.prepare('SELECT * FROM strategies').all();
    for (const s of strategies) {
      const intents = JSON.parse(s.applicable_intents || '[]');
      if (intents.length === 0) continue;

      const placeholders = intents.map(() => '?').join(',');
      const stats = db.prepare(`SELECT
        AVG(CASE WHEN o.success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
        COUNT(*) as total,
        AVG(o.tokens_used) as avg_tokens
        FROM outcomes o
        JOIN patterns p ON o.pattern_id = p.id
        WHERE p.intent IN (${placeholders})
        AND o.timestamp > datetime('now', '-30 days')`)
        .get(...intents);

      if (stats && stats.total > 0) {
        db.prepare('UPDATE strategies SET success_rate = ?, total_uses = ?, avg_tokens = ? WHERE id = ?')
          .run(stats.success_rate || 0.5, stats.total, stats.avg_tokens || 0, s.id);
      }
    }
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats() {
    const patterns = db.prepare('SELECT COUNT(*) as c FROM patterns').get().c;
    const outcomes = db.prepare('SELECT COUNT(*) as c FROM outcomes').get().c;
    const avgConfidence = db.prepare('SELECT AVG(confidence) as avg FROM patterns WHERE total_uses > 0').get().avg || 0;
    const topPatterns = db.prepare(
      'SELECT intent, confidence, total_uses, success_count, fail_count FROM patterns ORDER BY total_uses DESC LIMIT 5'
    ).all();
    const recentLearning = db.prepare(
      'SELECT event_type, details, timestamp FROM learning_events ORDER BY id DESC LIMIT 5'
    ).all();

    return {
      totalPatterns: patterns,
      totalOutcomes: outcomes,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      topPatterns,
      recentLearning,
    };
  }
}

// ─── SINGLETON EXPORT ────────────────────────────────────────────────────────
const reasoningBank = new ReasoningBank();

module.exports = reasoningBank;
module.exports.ReasoningBank = ReasoningBank;
module.exports.fingerprint = fingerprint;
module.exports.similarity = similarity;
