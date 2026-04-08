/**
 * ai-defence.js — AI Defence Security Layer for TVMbot
 * Inspired by ruflo's AIDefence threat detection system
 *
 * Protects TVMbot from:
 *   1. Prompt injection attacks (jailbreak attempts)
 *   2. Data exfiltration attempts (trying to extract API keys, system prompts)
 *   3. Abuse patterns (spam, harassment, excessive requests)
 *   4. Malicious tool manipulation (trying to trick the bot into destructive actions)
 *   5. Social engineering (impersonation, authority claims)
 *
 * Threat Levels: SAFE → SUSPICIOUS → BLOCKED
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── DATABASE ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'ai-defence.db');
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
  CREATE TABLE IF NOT EXISTS threat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    sender TEXT,
    message_preview TEXT,
    threat_type TEXT,
    threat_level TEXT,
    score REAL,
    action_taken TEXT,
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    sender TEXT PRIMARY KEY,
    message_count INTEGER DEFAULT 0,
    window_start TEXT,
    blocked_until TEXT,
    total_blocks INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sender_trust (
    sender TEXT PRIMARY KEY,
    trust_score REAL DEFAULT 0.5,
    total_messages INTEGER DEFAULT 0,
    threat_count INTEGER DEFAULT 0,
    last_message TEXT,
    first_seen TEXT
  );
`);

// ─── THREAT PATTERNS ─────────────────────────────────────────────────────────

const THREAT_PATTERNS = {
  // ─── PROMPT INJECTION ──────────────────────────
  prompt_injection: {
    level: 'HIGH',
    patterns: [
      /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
      /disregard\s+(all\s+)?(previous|your)\s+(instructions?|programming|rules?)/i,
      /forget\s+(everything|all)\s+(you('ve)?|that)\s+(been|were)\s+told/i,
      /you\s+are\s+now\s+(a|an)\s+/i,
      /new\s+instructions?:\s/i,
      /system\s*:\s/i,
      /\[SYSTEM\]/i,
      /\<\s*system\s*\>/i,
      /pretend\s+(you('re)?|to\s+be)\s+(a|an|not)\s/i,
      /act\s+as\s+(if\s+)?(you('re)?|a)\s/i,
      /override\s+(your\s+)?(safety|rules?|instructions?|restrictions?)/i,
      /jailbreak/i,
      /DAN\s+mode/i,
      /developer\s+mode/i,
      /do\s+anything\s+now/i,
      /bypass\s+(your\s+)?(filters?|safety|restrictions?)/i,
    ],
  },

  // ─── DATA EXFILTRATION ─────────────────────────
  data_exfiltration: {
    level: 'HIGH',
    patterns: [
      /what('s|\s+is)\s+your\s+(system\s+)?prompt/i,
      /show\s+me\s+your\s+(system\s+)?prompt/i,
      /reveal\s+your\s+(instructions?|prompt|programming)/i,
      /what\s+(are\s+)?your\s+instructions/i,
      /print\s+your\s+(system\s+)?(prompt|instructions)/i,
      /api[\s_-]?key/i,
      /anthropic[\s_-]?key/i,
      /secret[\s_-]?key/i,
      /access[\s_-]?token/i,
      /\.env\s+file/i,
      /show\s+me\s+(the\s+)?(password|credentials?|tokens?|keys?|secrets?)/i,
      /what('s|\s+is)\s+(the\s+)?(server\s+)?(password|root\s+password)/i,
      /ssh\s+(password|credentials?|access)/i,
    ],
  },

  // ─── DESTRUCTIVE ACTIONS ───────────────────────
  destructive_actions: {
    level: 'HIGH',
    patterns: [
      /delete\s+(all|every)\s+(data|files?|records?|entries?|bookings?|everything)/i,
      /drop\s+(table|database)/i,
      /rm\s+-rf/i,
      /format\s+(the\s+)?(disk|drive|server)/i,
      /wipe\s+(all|the|everything)/i,
      /clear\s+(all|every)\s+(data|records?|bookings?)/i,
      /remove\s+all\s+(villas?|guests?|bookings?|maintenance|records?)/i,
      /reset\s+(everything|all\s+data|the\s+system)/i,
    ],
  },

  // ─── SOCIAL ENGINEERING ────────────────────────
  social_engineering: {
    level: 'MEDIUM',
    patterns: [
      /i('m|\s+am)\s+(the\s+)?(owner|admin|administrator|developer|CEO|boss)/i,
      /afni\s+(told|said|asked|wants)\s+(me|you)\s+to/i,
      /this\s+is\s+(an?\s+)?(emergency|urgent)\s+(override|command)/i,
      /i\s+have\s+(admin|root|special)\s+(access|permission|authority)/i,
      /authorization\s+code/i,
      /emergency\s+protocol/i,
      /maintenance\s+mode\s+(enable|activate)/i,
    ],
  },

  // ─── ABUSE PATTERNS ────────────────────────────
  abuse: {
    level: 'MEDIUM',
    patterns: [
      /\b(fuck|shit|bitch|asshole|bastard|damn)\b/i,
      /you('re)?\s+(stupid|dumb|useless|idiot|worthless|garbage|trash)/i,
      /kill\s+(yourself|your\s*self)/i,
      /die\s+(bot|robot|machine)/i,
    ],
  },

  // ─── SUSPICIOUS PATTERNS ───────────────────────
  suspicious: {
    level: 'LOW',
    patterns: [
      /base64/i,
      /eval\(/i,
      /exec\(/i,
      /\<script/i,
      /javascript:/i,
      /data:text\/html/i,
      /\{\{.*\}\}/,  // Template injection
      /\$\{.*\}/,    // Template literal injection
    ],
  },
};

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
const RATE_LIMITS = {
  windowMs: 60 * 1000,        // 1 minute window
  maxMessages: 20,              // Max 20 messages per minute
  blockDurationMs: 5 * 60 * 1000, // Block for 5 minutes
  maxBlocksBeforeBan: 5,       // After 5 blocks, extended ban
  banDurationMs: 60 * 60 * 1000,  // Ban for 1 hour
};

// ─── AI DEFENCE CLASS ───────────────────────────────────────────────────────

class AIDefence {
  constructor() {
    console.log(`[AIDefence] Initialized with ${Object.keys(THREAT_PATTERNS).length} threat categories`);
  }

  /**
   * Main screening function — call before processing any message
   * @returns {{ safe: boolean, level: string, threats: Array, action: string }}
   */
  screen(message, sender = 'unknown') {
    const results = {
      safe: true,
      level: 'SAFE',
      threats: [],
      action: 'allow',
      trustScore: 0.5,
    };

    // 1. Rate limit check
    const rateResult = this._checkRateLimit(sender);
    if (!rateResult.allowed) {
      results.safe = false;
      results.level = 'BLOCKED';
      results.action = 'rate_limited';
      results.threats.push({
        type: 'rate_limit',
        level: 'HIGH',
        detail: `Rate limit exceeded: ${rateResult.count} messages in window`,
      });
      this._logThreat(sender, message, 'rate_limit', 'BLOCKED', 1.0, 'rate_limited');
      return results;
    }

    // 2. Pattern matching
    let maxScore = 0;
    for (const [category, def] of Object.entries(THREAT_PATTERNS)) {
      for (const pattern of def.patterns) {
        if (pattern.test(message)) {
          const score = def.level === 'HIGH' ? 0.9 : def.level === 'MEDIUM' ? 0.6 : 0.3;
          maxScore = Math.max(maxScore, score);

          results.threats.push({
            type: category,
            level: def.level,
            pattern: pattern.toString().slice(0, 60),
            detail: `Matched ${category} pattern`,
          });
        }
      }
    }

    // 3. Determine action based on threats
    if (maxScore >= 0.9) {
      results.safe = false;
      results.level = 'BLOCKED';
      results.action = 'block';
    } else if (maxScore >= 0.6) {
      results.safe = true; // Allow but flag
      results.level = 'SUSPICIOUS';
      results.action = 'warn';
    } else if (maxScore > 0) {
      results.safe = true;
      results.level = 'SUSPICIOUS';
      results.action = 'monitor';
    }

    // 4. Trust score adjustment
    results.trustScore = this._updateTrust(sender, results.threats.length > 0);

    // 5. Log if threats found
    if (results.threats.length > 0) {
      this._logThreat(
        sender,
        message.substring(0, 200),
        results.threats[0].type,
        results.level,
        maxScore,
        results.action,
        JSON.stringify(results.threats)
      );
    }

    return results;
  }

  /**
   * Screen the AI's response before sending to user
   * Prevents accidental leaking of sensitive info
   */
  screenResponse(response) {
    let cleaned = response;
    const issues = [];

    // Redact API keys if accidentally included
    cleaned = cleaned.replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED_API_KEY]');
    if (cleaned !== response) issues.push('api_key_leaked');

    // Redact server passwords
    cleaned = cleaned.replace(/TheVillaManagers\d+#?/g, '[REDACTED_PASSWORD]');
    if (cleaned !== response) issues.push('password_leaked');

    // Redact IP addresses with ports
    cleaned = cleaned.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+\b/g, '[REDACTED_SERVER]');

    // Redact SSH/root paths
    cleaned = cleaned.replace(/\/root\/claude-chatbot\//g, '[server_path]/');

    // Redact OAuth tokens
    cleaned = cleaned.replace(/ya29\.[a-zA-Z0-9_-]{50,}/g, '[REDACTED_TOKEN]');
    cleaned = cleaned.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "[REDACTED]"');
    cleaned = cleaned.replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token": "[REDACTED]"');

    if (issues.length > 0) {
      this._logThreat('system', 'Response screening', 'response_leak', 'SUSPICIOUS', 0.8,
        'redacted', JSON.stringify(issues));
    }

    return { response: cleaned, issues };
  }

  /**
   * Get a safe rejection message based on threat type
   */
  getBlockMessage(threatType) {
    const messages = {
      prompt_injection: "I can't process that request. I'm TVMbot, and I follow my configured instructions to help manage TVM operations.",
      data_exfiltration: "I can't share system configuration details. How can I help you with TVM operations instead?",
      destructive_actions: "I can't perform bulk deletion or destructive operations. Please specify exactly what you'd like to update.",
      social_engineering: "I verify requests through my normal process. Please describe what you need help with.",
      abuse: "I'm here to help with TVM operations. What can I assist you with?",
      rate_limit: "You're sending messages too quickly. Please wait a moment and try again.",
      suspicious: "That request contains content I can't process. Please rephrase your question.",
    };
    return messages[threatType] || "I can't process that request. How can I help you with TVM operations?";
  }

  // ─── RATE LIMITING ──────────────────────────────────────────────────────

  _checkRateLimit(sender) {
    const now = Date.now();
    const nowISO = new Date().toISOString();

    const existing = db.prepare('SELECT * FROM rate_limits WHERE sender = ?').get(sender);

    if (existing) {
      // Check if blocked
      if (existing.blocked_until) {
        const blockedUntil = new Date(existing.blocked_until).getTime();
        if (now < blockedUntil) {
          return { allowed: false, count: existing.message_count, blockedUntil: existing.blocked_until };
        }
        // Block expired, reset
        db.prepare('UPDATE rate_limits SET blocked_until = NULL, message_count = 1, window_start = ? WHERE sender = ?')
          .run(nowISO, sender);
        return { allowed: true, count: 1 };
      }

      // Check window
      const windowStart = new Date(existing.window_start).getTime();
      if (now - windowStart > RATE_LIMITS.windowMs) {
        // New window
        db.prepare('UPDATE rate_limits SET message_count = 1, window_start = ? WHERE sender = ?')
          .run(nowISO, sender);
        return { allowed: true, count: 1 };
      }

      // Same window, increment
      const newCount = existing.message_count + 1;
      if (newCount > RATE_LIMITS.maxMessages) {
        // Block
        const blockDuration = existing.total_blocks >= RATE_LIMITS.maxBlocksBeforeBan
          ? RATE_LIMITS.banDurationMs
          : RATE_LIMITS.blockDurationMs;
        const blockedUntil = new Date(now + blockDuration).toISOString();

        db.prepare('UPDATE rate_limits SET message_count = ?, blocked_until = ?, total_blocks = total_blocks + 1 WHERE sender = ?')
          .run(newCount, blockedUntil, sender);
        return { allowed: false, count: newCount, blockedUntil };
      }

      db.prepare('UPDATE rate_limits SET message_count = ? WHERE sender = ?')
        .run(newCount, sender);
      return { allowed: true, count: newCount };
    }

    // New sender
    db.prepare('INSERT INTO rate_limits (sender, message_count, window_start) VALUES (?, 1, ?)')
      .run(sender, nowISO);
    return { allowed: true, count: 1 };
  }

  // ─── TRUST SCORING ──────────────────────────────────────────────────────

  _updateTrust(sender, hasThreat) {
    const existing = db.prepare('SELECT * FROM sender_trust WHERE sender = ?').get(sender);

    if (existing) {
      const newTotal = existing.total_messages + 1;
      const newThreats = existing.threat_count + (hasThreat ? 1 : 0);
      // Trust decays with threats, grows with clean messages
      let newTrust = existing.trust_score;
      if (hasThreat) {
        newTrust = Math.max(0.1, newTrust - 0.1);
      } else {
        newTrust = Math.min(1.0, newTrust + 0.01); // Slow trust building
      }

      db.prepare('UPDATE sender_trust SET trust_score = ?, total_messages = ?, threat_count = ?, last_message = ? WHERE sender = ?')
        .run(newTrust, newTotal, newThreats, new Date().toISOString(), sender);
      return newTrust;
    }

    // New sender starts at 0.5
    const initialTrust = hasThreat ? 0.3 : 0.5;
    db.prepare('INSERT INTO sender_trust (sender, trust_score, total_messages, threat_count, last_message, first_seen) VALUES (?, ?, 1, ?, ?, ?)')
      .run(sender, initialTrust, hasThreat ? 1 : 0, new Date().toISOString(), new Date().toISOString());
    return initialTrust;
  }

  // ─── LOGGING ────────────────────────────────────────────────────────────

  _logThreat(sender, message, threatType, threatLevel, score, action, details = '') {
    try {
      db.prepare(`INSERT INTO threat_log (timestamp, sender, message_preview, threat_type, threat_level, score, action_taken, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(new Date().toISOString(), sender, message.substring(0, 200), threatType, threatLevel, score, action, details);
    } catch (e) { /* ignore */ }
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats() {
    const totalThreats = db.prepare('SELECT COUNT(*) as c FROM threat_log').get().c;
    const blocked = db.prepare("SELECT COUNT(*) as c FROM threat_log WHERE threat_level = 'BLOCKED'").get().c;
    const byType = db.prepare('SELECT threat_type, COUNT(*) as count FROM threat_log GROUP BY threat_type ORDER BY count DESC').all();
    const recentThreats = db.prepare('SELECT * FROM threat_log ORDER BY id DESC LIMIT 5').all();
    const lowTrustSenders = db.prepare('SELECT sender, trust_score, threat_count FROM sender_trust WHERE trust_score < 0.3 ORDER BY trust_score ASC LIMIT 5').all();

    return {
      totalThreats,
      blocked,
      byType,
      recentThreats,
      lowTrustSenders,
    };
  }

  getTrustScore(sender) {
    const row = db.prepare('SELECT trust_score FROM sender_trust WHERE sender = ?').get(sender);
    return row ? row.trust_score : 0.5;
  }
}

// ─── SINGLETON EXPORT ────────────────────────────────────────────────────────
const defence = new AIDefence();

module.exports = defence;
module.exports.AIDefence = AIDefence;
module.exports.THREAT_PATTERNS = THREAT_PATTERNS;
