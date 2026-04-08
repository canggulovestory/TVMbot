/**
 * Escalation Manager — Auto-Escalate to Human When AI Confidence is Low
 * Inspired by ruflo's human handoff and escalation patterns.
 *
 * Determines when TVMbot should hand off to a human operator:
 *   - Low routing confidence
 *   - Repeated misunderstandings
 *   - Emotional/angry customer
 *   - High-stakes decisions
 *   - VIP guest interactions
 *   - Compliance-sensitive topics
 *
 * Features:
 *   - Multi-signal escalation scoring
 *   - Escalation tiers (L1: any staff, L2: manager, L3: owner Afni)
 *   - Cooldown to prevent escalation spam
 *   - Auto-detection of frustration patterns
 *   - Handoff message generation (bilingual EN/ID)
 *   - Escalation history tracking
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'escalation.db');

class EscalationManager {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Escalation tiers
    this.tiers = {
      L1: { name: 'Staff', target: 'staff', threshold: 0.6 },
      L2: { name: 'Manager', target: 'manager', threshold: 0.75 },
      L3: { name: 'Owner (Afni)', target: 'owner', threshold: 0.9 },
    };

    // Escalation signals with weights
    this.signals = {
      lowConfidence:    { weight: 0.25, description: 'Routing confidence below threshold' },
      repeatedQuery:    { weight: 0.20, description: 'User repeating same question (misunderstanding)' },
      frustration:      { weight: 0.30, description: 'User showing frustration/anger' },
      highStakes:       { weight: 0.20, description: 'High-stakes business decision' },
      vipGuest:         { weight: 0.15, description: 'VIP guest interaction' },
      compliance:       { weight: 0.25, description: 'Legal/compliance sensitive topic' },
      explicitRequest:  { weight: 1.00, description: 'User explicitly asks for human' },
      toolFailure:      { weight: 0.15, description: 'Multiple tool failures in session' },
      longConversation: { weight: 0.10, description: 'Conversation exceeding normal length' },
    };

    // Frustration detection patterns
    this.frustrationPatterns = [
      /(?:this is (?:not|isn't) (?:working|helpful|right))/i,
      /(?:what(?:'s| is) wrong with (?:you|this))/i,
      /(?:i(?:'ve| have) already (?:told|said|asked) you)/i,
      /(?:useless|stupid|dumb|terrible|worst|awful|horrible)/i,
      /(?:talk to (?:a |an )?(?:human|person|real person|someone|manager|staff|owner))/i,
      /(?:can(?:'t| not) (?:you )?understand)/i,
      /(?:for the (?:last|third|fourth) time)/i,
      /(?:!!!|wtf|omg|smh|ffs)/i,
      /(?:gak (bisa|ngerti)|bodoh|tolol|parah|goblok)/i, // Bahasa frustration
      /(?:bicara (?:sama|dengan) (?:orang|manusia|manager|staff))/i, // ID: talk to human
      /(?:mau (komplain|complain|lapor))/i, // ID: want to complain
    ];

    // VIP indicators
    this.vipPatterns = [
      /(?:vip|important guest|special guest|returning guest|loyal customer)/i,
      /(?:celebrity|influencer|ambassador)/i,
      /(?:corporate booking|group booking|wedding)/i,
      /(?:tamu penting|tamu spesial|tamu VIP)/i,
    ];

    // Compliance-sensitive topics
    this.compliancePatterns = [
      /(?:legal|lawyer|attorney|court|lawsuit|sue|suing)/i,
      /(?:tax|pajak|NPWP|SPT)/i,
      /(?:insurance|claim|liability)/i,
      /(?:discrimination|harassment|complaint to authorities)/i,
      /(?:refund|chargeback|dispute)/i,
      /(?:hukum|pengacara|gugatan|pajak)/i,
    ];

    // Track session states in memory
    this.sessionStates = new Map();
    this.cooldownMs = 30 * 60 * 1000; // 30 min cooldown between escalations

    console.log(`[Escalation] Initialized with ${Object.keys(this.signals).length} signals, 3 tiers`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS escalations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        tier TEXT NOT NULL,
        score REAL NOT NULL,
        signals TEXT DEFAULT '[]',
        message TEXT,
        status TEXT DEFAULT 'pending',
        handled_by TEXT,
        handled_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS escalation_sessions (
        session_id TEXT PRIMARY KEY,
        repeated_queries INTEGER DEFAULT 0,
        tool_failures INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        frustration_hits INTEGER DEFAULT 0,
        last_escalation TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
      CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_id);
    `);
  }

  /**
   * Evaluate whether a message should trigger escalation
   * Returns: { shouldEscalate, tier, score, signals[], message }
   */
  evaluate(message, context = {}) {
    const {
      sessionId = 'default',
      sender = 'unknown',
      routingConfidence = 1.0,
      isRepeat = false,
      toolFailures = 0,
      messageCount = 0,
      isVIP = false,
    } = context;

    // Get/create session state
    let session = this._getSession(sessionId);

    // Update session counters
    session.message_count = (session.message_count || 0) + 1;
    if (toolFailures > 0) session.tool_failures = (session.tool_failures || 0) + toolFailures;

    const triggeredSignals = [];
    let totalScore = 0;

    // 1. Low confidence check
    if (routingConfidence < 0.4) {
      triggeredSignals.push({ signal: 'lowConfidence', score: this.signals.lowConfidence.weight, detail: `confidence=${routingConfidence.toFixed(2)}` });
      totalScore += this.signals.lowConfidence.weight;
    }

    // 2. Repeated query detection
    if (isRepeat || this._isRepeatQuery(sessionId, message)) {
      session.repeated_queries = (session.repeated_queries || 0) + 1;
      if (session.repeated_queries >= 2) {
        triggeredSignals.push({ signal: 'repeatedQuery', score: this.signals.repeatedQuery.weight, detail: `repeats=${session.repeated_queries}` });
        totalScore += this.signals.repeatedQuery.weight;
      }
    }

    // 3. Frustration detection
    const frustrationHit = this.frustrationPatterns.some(p => p.test(message));
    if (frustrationHit) {
      session.frustration_hits = (session.frustration_hits || 0) + 1;
      const escalatedWeight = this.signals.frustration.weight * Math.min(session.frustration_hits, 3);
      triggeredSignals.push({ signal: 'frustration', score: escalatedWeight, detail: `hits=${session.frustration_hits}` });
      totalScore += escalatedWeight;
    }

    // 4. Explicit human request
    const explicitHuman = /(?:talk to|speak to|connect me|transfer|let me talk to|mau bicara dengan)\s*(?:a\s+)?(?:human|person|real person|someone|manager|staff|owner|orang|manusia)/i.test(message);
    if (explicitHuman) {
      triggeredSignals.push({ signal: 'explicitRequest', score: this.signals.explicitRequest.weight, detail: 'user requested human' });
      totalScore += this.signals.explicitRequest.weight;
    }

    // 5. VIP detection
    if (isVIP || this.vipPatterns.some(p => p.test(message))) {
      triggeredSignals.push({ signal: 'vipGuest', score: this.signals.vipGuest.weight, detail: 'VIP guest detected' });
      totalScore += this.signals.vipGuest.weight;
    }

    // 6. Compliance sensitivity
    if (this.compliancePatterns.some(p => p.test(message))) {
      triggeredSignals.push({ signal: 'compliance', score: this.signals.compliance.weight, detail: 'compliance topic detected' });
      totalScore += this.signals.compliance.weight;
    }

    // 7. Tool failures
    if ((session.tool_failures || 0) >= 3) {
      triggeredSignals.push({ signal: 'toolFailure', score: this.signals.toolFailure.weight, detail: `failures=${session.tool_failures}` });
      totalScore += this.signals.toolFailure.weight;
    }

    // 8. Long conversation
    if (session.message_count > 20) {
      triggeredSignals.push({ signal: 'longConversation', score: this.signals.longConversation.weight, detail: `messages=${session.message_count}` });
      totalScore += this.signals.longConversation.weight;
    }

    // Clamp score to [0, 1]
    totalScore = Math.min(1.0, totalScore);

    // Determine tier
    let tier = null;
    if (totalScore >= this.tiers.L3.threshold) tier = 'L3';
    else if (totalScore >= this.tiers.L2.threshold) tier = 'L2';
    else if (totalScore >= this.tiers.L1.threshold) tier = 'L1';

    // Check cooldown
    const shouldEscalate = tier !== null && !this._isInCooldown(sessionId);

    // Save session state
    this._saveSession(sessionId, session);

    if (shouldEscalate) {
      const escalationMessage = this._buildEscalationMessage(tier, triggeredSignals, sender);
      this._recordEscalation(sessionId, sender, tier, totalScore, triggeredSignals, escalationMessage);

      return {
        shouldEscalate: true,
        tier,
        tierName: this.tiers[tier].name,
        score: totalScore,
        signals: triggeredSignals,
        message: escalationMessage,
        target: this.tiers[tier].target,
      };
    }

    return {
      shouldEscalate: false,
      tier,
      score: totalScore,
      signals: triggeredSignals,
    };
  }

  _isRepeatQuery(sessionId, message) {
    // Simple: check if similar message was sent in last 5 messages
    // Uses word overlap > 60%
    const state = this.sessionStates.get(sessionId) || { recentMessages: [] };
    const words = new Set(message.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    for (const prev of (state.recentMessages || []).slice(-5)) {
      const prevWords = new Set(prev.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const overlap = [...words].filter(w => prevWords.has(w)).length;
      const maxSize = Math.max(words.size, prevWords.size);
      if (maxSize > 0 && overlap / maxSize > 0.6) return true;
    }

    // Track message
    if (!state.recentMessages) state.recentMessages = [];
    state.recentMessages.push(message);
    if (state.recentMessages.length > 10) state.recentMessages.shift();
    this.sessionStates.set(sessionId, state);

    return false;
  }

  _isInCooldown(sessionId) {
    const session = this.db.prepare('SELECT last_escalation FROM escalation_sessions WHERE session_id = ?').get(sessionId);
    if (!session || !session.last_escalation) return false;

    const elapsed = Date.now() - new Date(session.last_escalation).getTime();
    return elapsed < this.cooldownMs;
  }

  _buildEscalationMessage(tier, signals, sender) {
    const tierInfo = this.tiers[tier];
    const signalList = signals.map(s => s.detail).join(', ');

    // Bilingual message
    const messages = {
      L1: {
        en: `I'd like to connect you with our team for better assistance. A staff member will reach out shortly.`,
        id: `Saya akan menghubungkan Anda dengan tim kami untuk bantuan lebih baik. Staf kami akan segera menghubungi Anda.`,
      },
      L2: {
        en: `I'm connecting you with our manager to ensure you get the best possible help. They'll be with you shortly.`,
        id: `Saya menghubungkan Anda dengan manager kami untuk memastikan Anda mendapat bantuan terbaik. Manager akan segera menghubungi Anda.`,
      },
      L3: {
        en: `I'm escalating this to our owner, Afni, to give you personal attention. She'll be in touch soon.`,
        id: `Saya akan meneruskan ini ke pemilik kami, Afni, untuk perhatian personal. Beliau akan segera menghubungi Anda.`,
      },
    };

    const msg = messages[tier] || messages.L1;

    return `${msg.en}\n\n${msg.id}\n\n_[Internal: Escalation ${tier} — ${signalList}]_`;
  }

  _recordEscalation(sessionId, sender, tier, score, signals, message) {
    this.db.prepare(`
      INSERT INTO escalations (session_id, sender, tier, score, signals, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, sender, tier, score, JSON.stringify(signals), message);

    this.db.prepare(`
      INSERT OR REPLACE INTO escalation_sessions (session_id, last_escalation, updated_at)
      VALUES (?, datetime('now'), datetime('now'))
    `).run(sessionId);
  }

  _getSession(sessionId) {
    return this.db.prepare('SELECT * FROM escalation_sessions WHERE session_id = ?').get(sessionId) || {
      session_id: sessionId, repeated_queries: 0, tool_failures: 0, message_count: 0, frustration_hits: 0,
    };
  }

  _saveSession(sessionId, session) {
    this.db.prepare(`
      INSERT OR REPLACE INTO escalation_sessions (session_id, repeated_queries, tool_failures, message_count, frustration_hits, last_escalation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(sessionId, session.repeated_queries || 0, session.tool_failures || 0, session.message_count || 0, session.frustration_hits || 0, session.last_escalation || null);
  }

  /**
   * Mark escalation as handled
   */
  handleEscalation(escalationId, handledBy) {
    this.db.prepare(`
      UPDATE escalations SET status = 'handled', handled_by = ?, handled_at = datetime('now')
      WHERE id = ?
    `).run(handledBy, escalationId);
  }

  /**
   * Get pending escalations
   */
  getPending() {
    return this.db.prepare(`
      SELECT * FROM escalations WHERE status = 'pending'
      ORDER BY score DESC, created_at DESC
    `).all();
  }

  /**
   * Get escalation context for system prompt
   */
  getEscalationContext(sessionId) {
    const session = this._getSession(sessionId);
    const parts = [];

    if (session.frustration_hits > 0) {
      parts.push(`User has shown frustration ${session.frustration_hits} time(s) — be extra empathetic and helpful.`);
    }
    if (session.repeated_queries > 1) {
      parts.push(`User has repeated their question ${session.repeated_queries} times — they may feel unheard. Try a different approach.`);
    }
    if (session.tool_failures > 2) {
      parts.push(`There have been ${session.tool_failures} tool failures this session — apologize for technical issues.`);
    }

    if (parts.length === 0) return '';
    return '\n\n--- Session Health ---\n' + parts.join('\n') + '\n';
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM escalations').get().c;
    const pending = this.db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'pending'").get().c;
    const byTier = this.db.prepare(`
      SELECT tier, COUNT(*) as c FROM escalations GROUP BY tier
    `).all();

    return {
      total, pending,
      byTier: Object.fromEntries(byTier.map(r => [r.tier, r.c])),
    };
  }
}

module.exports = new EscalationManager();
