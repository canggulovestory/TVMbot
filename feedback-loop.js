/**
 * Feedback Loop — Satisfaction Tracking & Self-Improvement
 * Inspired by ruflo's continuous learning and quality optimization.
 *
 * Tracks implicit and explicit user satisfaction signals to improve
 * TVMbot's responses over time.
 *
 * Features:
 *   - Implicit satisfaction signals (response time, follow-ups, conversation flow)
 *   - Explicit feedback collection (when user says thanks, complains, etc.)
 *   - Per-intent satisfaction scoring
 *   - Per-agent performance tracking
 *   - Auto-tuning suggestions (which intents need improvement)
 *   - Weekly quality digest generation
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'feedback.db');

class FeedbackLoop {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Satisfaction signal patterns
    this.positivePatterns = [
      { pattern: /(?:thank(?:s| you)|terima\s*kasih|makasih|mantap|bagus|good|great|perfect|nice|awesome|excellent)/i, weight: 0.8, signal: 'gratitude' },
      { pattern: /(?:that(?:'s| is) (?:exactly|perfect|great|correct|right)|benar|betul|tepat)/i, weight: 0.9, signal: 'confirmation' },
      { pattern: /(?:👍|😊|🙏|❤️|✅|💯|🎉)/u, weight: 0.7, signal: 'positive_emoji' },
      { pattern: /(?:done|ok|got it|understood|okay|oke|siap|baik)/i, weight: 0.5, signal: 'acknowledgment' },
    ];

    this.negativePatterns = [
      { pattern: /(?:wrong|incorrect|that(?:'s| is) not|salah|bukan|no(?:,| that)|keliru)/i, weight: -0.8, signal: 'correction' },
      { pattern: /(?:doesn(?:'t| not) (?:work|help)|not useful|useless|gak (bisa|berguna))/i, weight: -0.9, signal: 'dissatisfaction' },
      { pattern: /(?:👎|😡|😤|😒|💢)/u, weight: -0.7, signal: 'negative_emoji' },
      { pattern: /(?:again|repeat|ulang|lagi|I (?:already|just) (?:said|told|asked))/i, weight: -0.6, signal: 'repeat_request' },
      { pattern: /(?:confused|confusing|don't understand|bingung|gak ngerti)/i, weight: -0.5, signal: 'confusion' },
    ];

    // Implicit signals
    this.implicitSignals = {
      'quick_followup':     { weight: -0.3, description: 'User sent another message within 10s (may mean first response was insufficient)' },
      'long_pause':         { weight: 0.2, description: 'User paused > 2min before next message (processing response)' },
      'topic_change':       { weight: 0.4, description: 'User changed topic (satisfied with previous answer)' },
      'same_topic':         { weight: -0.2, description: 'User continues same topic (may need more help)' },
      'session_end':        { weight: 0.3, description: 'User ended conversation (task completed)' },
      'short_response':     { weight: 0.1, description: 'User gave short response (acknowledged)' },
      'long_response':      { weight: -0.1, description: 'User gave long response (explaining more = we missed something)' },
    };

    console.log(`[FeedbackLoop] Initialized with ${this.positivePatterns.length} positive + ${this.negativePatterns.length} negative patterns`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        sender TEXT,
        signal_type TEXT NOT NULL,
        signal_name TEXT NOT NULL,
        weight REAL DEFAULT 0,
        intent TEXT,
        agent TEXT,
        query_snippet TEXT,
        response_snippet TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS satisfaction_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dimension TEXT NOT NULL,
        dimension_value TEXT NOT NULL,
        period TEXT NOT NULL,
        score REAL DEFAULT 0.5,
        sample_count INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(dimension, dimension_value, period)
      );

      CREATE TABLE IF NOT EXISTS improvement_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dimension TEXT NOT NULL,
        dimension_value TEXT NOT NULL,
        suggestion TEXT NOT NULL,
        priority REAL DEFAULT 0.5,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_intent ON feedback_events(intent);
      CREATE INDEX IF NOT EXISTS idx_satisfaction_dim ON satisfaction_scores(dimension, dimension_value);
    `);
  }

  /**
   * Analyze a user message for satisfaction signals
   */
  analyzeMessage(message, context = {}) {
    const { sessionId, sender, intent, agent, previousResponse } = context;
    const signals = [];

    // Check explicit positive patterns
    for (const { pattern, weight, signal } of this.positivePatterns) {
      if (pattern.test(message)) {
        signals.push({ type: 'explicit', name: signal, weight });
      }
    }

    // Check explicit negative patterns
    for (const { pattern, weight, signal } of this.negativePatterns) {
      if (pattern.test(message)) {
        signals.push({ type: 'explicit', name: signal, weight });
      }
    }

    // Check implicit signals
    if (context.timeSinceLastMessage !== undefined) {
      if (context.timeSinceLastMessage < 10000) {
        signals.push({ type: 'implicit', name: 'quick_followup', weight: this.implicitSignals.quick_followup.weight });
      } else if (context.timeSinceLastMessage > 120000) {
        signals.push({ type: 'implicit', name: 'long_pause', weight: this.implicitSignals.long_pause.weight });
      }
    }

    if (message.length < 20) {
      signals.push({ type: 'implicit', name: 'short_response', weight: this.implicitSignals.short_response.weight });
    } else if (message.length > 200) {
      signals.push({ type: 'implicit', name: 'long_response', weight: this.implicitSignals.long_response.weight });
    }

    // Record signals
    for (const signal of signals) {
      this._recordSignal(sessionId, sender, signal, intent, agent, message, previousResponse);
    }

    // Calculate net satisfaction for this interaction
    const netSatisfaction = signals.reduce((sum, s) => sum + s.weight, 0);

    // Update rolling satisfaction scores
    if (intent) this._updateScore('intent', intent, netSatisfaction);
    if (agent) this._updateScore('agent', agent, netSatisfaction);
    this._updateScore('overall', 'tvmbot', netSatisfaction);

    return {
      signals,
      netSatisfaction,
      sentiment: netSatisfaction > 0.2 ? 'positive' : netSatisfaction < -0.2 ? 'negative' : 'neutral',
    };
  }

  _recordSignal(sessionId, sender, signal, intent, agent, query, response) {
    this.db.prepare(`
      INSERT INTO feedback_events (session_id, sender, signal_type, signal_name, weight, intent, agent, query_snippet, response_snippet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, sender, signal.type, signal.name, signal.weight,
      intent, agent,
      (query || '').substring(0, 200),
      (response || '').substring(0, 200)
    );
  }

  _updateScore(dimension, value, netSatisfaction) {
    const period = new Date().toISOString().substring(0, 7); // YYYY-MM

    const existing = this.db.prepare(`
      SELECT score, sample_count FROM satisfaction_scores
      WHERE dimension = ? AND dimension_value = ? AND period = ?
    `).get(dimension, value, period);

    if (existing) {
      // Exponential moving average
      const alpha = 0.1;
      const normalizedSignal = (netSatisfaction + 1) / 2; // Map [-1,1] to [0,1]
      const newScore = existing.score * (1 - alpha) + normalizedSignal * alpha;

      this.db.prepare(`
        UPDATE satisfaction_scores SET score = ?, sample_count = sample_count + 1, updated_at = datetime('now')
        WHERE dimension = ? AND dimension_value = ? AND period = ?
      `).run(newScore, dimension, value, period);
    } else {
      const normalizedSignal = (netSatisfaction + 1) / 2;
      this.db.prepare(`
        INSERT INTO satisfaction_scores (dimension, dimension_value, period, score, sample_count)
        VALUES (?, ?, ?, ?, 1)
      `).run(dimension, value, period, normalizedSignal);
    }
  }

  /**
   * Get satisfaction scores for a dimension
   */
  getScores(dimension, period = null) {
    const currentPeriod = period || new Date().toISOString().substring(0, 7);

    return this.db.prepare(`
      SELECT * FROM satisfaction_scores
      WHERE dimension = ? AND period = ?
      ORDER BY score ASC
    `).all(dimension, currentPeriod);
  }

  /**
   * Generate improvement suggestions based on low scores
   */
  generateSuggestions() {
    const currentPeriod = new Date().toISOString().substring(0, 7);
    const lowScorers = this.db.prepare(`
      SELECT * FROM satisfaction_scores
      WHERE period = ? AND score < 0.4 AND sample_count >= 5
      ORDER BY score ASC
    `).all(currentPeriod);

    const suggestions = [];
    for (const scorer of lowScorers) {
      // Analyze why it's low
      const negativeSignals = this.db.prepare(`
        SELECT signal_name, COUNT(*) as count FROM feedback_events
        WHERE ${scorer.dimension === 'intent' ? 'intent' : 'agent'} = ?
        AND weight < 0
        AND timestamp > datetime('now', '-30 days')
        GROUP BY signal_name ORDER BY count DESC LIMIT 3
      `).all(scorer.dimension_value);

      const topIssues = negativeSignals.map(s => s.signal_name).join(', ');
      const suggestion = `${scorer.dimension} "${scorer.dimension_value}" has low satisfaction (${(scorer.score * 100).toFixed(0)}%). Top issues: ${topIssues || 'unknown'}. Consider improving response quality for this area.`;

      this.db.prepare(`
        INSERT INTO improvement_suggestions (dimension, dimension_value, suggestion, priority)
        VALUES (?, ?, ?, ?)
      `).run(scorer.dimension, scorer.dimension_value, suggestion, 1 - scorer.score);

      suggestions.push(suggestion);
    }

    return suggestions;
  }

  /**
   * Get quality digest for system prompt
   */
  getQualityContext() {
    const currentPeriod = new Date().toISOString().substring(0, 7);
    const overall = this.db.prepare(`
      SELECT score, sample_count FROM satisfaction_scores
      WHERE dimension = 'overall' AND dimension_value = 'tvmbot' AND period = ?
    `).get(currentPeriod);

    if (!overall || overall.sample_count < 3) return '';

    const lowIntents = this.db.prepare(`
      SELECT dimension_value, score FROM satisfaction_scores
      WHERE dimension = 'intent' AND period = ? AND score < 0.4 AND sample_count >= 3
      ORDER BY score ASC LIMIT 3
    `).all(currentPeriod);

    let ctx = `\n\n--- Quality Metrics ---\nOverall satisfaction: ${(overall.score * 100).toFixed(0)}% (${overall.sample_count} interactions)\n`;
    if (lowIntents.length > 0) {
      ctx += `Areas needing improvement: ${lowIntents.map(i => `${i.dimension_value} (${(i.score * 100).toFixed(0)}%)`).join(', ')}\n`;
    }
    return ctx;
  }

  /**
   * Cleanup old data
   */
  cleanup(daysOld = 90) {
    const events = this.db.prepare(`
      DELETE FROM feedback_events WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    return { deletedEvents: events.changes };
  }

  getStats() {
    const totalEvents = this.db.prepare('SELECT COUNT(*) as c FROM feedback_events').get().c;
    const currentPeriod = new Date().toISOString().substring(0, 7);
    const overall = this.db.prepare(`
      SELECT score FROM satisfaction_scores
      WHERE dimension = 'overall' AND dimension_value = 'tvmbot' AND period = ?
    `).get(currentPeriod);

    return {
      totalEvents,
      overallSatisfaction: overall ? `${(overall.score * 100).toFixed(0)}%` : 'N/A',
      signalTypes: this.positivePatterns.length + this.negativePatterns.length + Object.keys(this.implicitSignals).length,
    };
  }
}

module.exports = new FeedbackLoop();
