/**
 * Context Window Manager — Smart Context Compression & Prioritization
 * Inspired by ruflo's context management for long-running agent conversations.
 *
 * Claude's context window is limited. This module ensures the most relevant
 * information is included while staying within token budgets.
 *
 * Features:
 *   - Priority-based context assembly
 *   - Conversation summarization (compress old messages)
 *   - Entity extraction + persistence across summaries
 *   - Dynamic budget allocation based on query complexity
 *   - Context section scoring (recency, relevance, importance)
 *   - Token estimation without external libraries
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'context-manager.db');

class ContextWindowManager {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Token budget allocation (approximate — Claude Sonnet context window)
    this.maxTokens = 180000;  // Effective usable tokens
    this.budgets = {
      systemPrompt:    0.15,  // 15% for base system prompt
      policies:        0.05,  // 5% for policy rules
      memory:          0.10,  // 10% for vector memory context
      gossip:          0.03,  // 3% for agent gossip
      conversationNew: 0.35,  // 35% for recent conversation
      conversationOld: 0.10,  // 10% for summarized old conversation
      tools:           0.10,  // 10% for tool definitions
      sheetData:       0.08,  // 8% for referenced sheet data
      misc:            0.04,  // 4% for misc (approvals, health, etc.)
    };

    // Conversation compression settings
    this.compressionThreshold = 15;  // Summarize when > 15 messages
    this.keepRecentMessages = 8;     // Always keep last 8 messages uncompressed
    this.maxSummaryLength = 500;     // Characters per summary block

    // Entity persistence — important entities survive compression
    this.persistentEntityTypes = [
      'villa_name', 'guest_name', 'booking_ref', 'amount', 'date',
      'phone_number', 'email', 'staff_name', 'vendor_name', 'task_id',
    ];

    console.log(`[ContextManager] Initialized with ${this.maxTokens} token budget across ${Object.keys(this.budgets).length} sections`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        message_range TEXT,
        entities TEXT DEFAULT '[]',
        token_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS persistent_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_value TEXT NOT NULL,
        first_seen TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now')),
        mention_count INTEGER DEFAULT 1,
        context TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS context_usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        section TEXT NOT NULL,
        token_estimate INTEGER,
        was_trimmed INTEGER DEFAULT 0,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_session ON conversation_summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_entities_session ON persistent_entities(session_id);
    `);
  }

  /**
   * Estimate token count (rough: ~4 chars per token for English, ~3 for mixed EN/ID)
   */
  estimateTokens(text) {
    if (!text) return 0;
    // Rough estimation: split on whitespace + punctuation
    const words = text.split(/\s+/).length;
    const chars = text.length;
    // Use a blend: ~1.3 tokens per word, or ~4 chars per token
    return Math.ceil(Math.max(words * 1.3, chars / 4));
  }

  /**
   * Build optimized context for a Claude API call
   * Takes all available context sections and fits them within budget
   */
  buildContext(sections) {
    const result = {};
    const usage = {};

    // Calculate token budgets
    for (const [section, ratio] of Object.entries(this.budgets)) {
      usage[section] = {
        budget: Math.floor(this.maxTokens * ratio),
        used: 0,
        trimmed: false,
      };
    }

    // Process each section by priority
    const prioritized = [
      { key: 'systemPrompt', section: 'systemPrompt', content: sections.systemPrompt || '' },
      { key: 'conversationNew', section: 'conversationNew', content: sections.recentMessages || '' },
      { key: 'tools', section: 'tools', content: sections.tools || '' },
      { key: 'policies', section: 'policies', content: sections.policies || '' },
      { key: 'memory', section: 'memory', content: sections.memoryContext || '' },
      { key: 'sheetData', section: 'sheetData', content: sections.sheetData || '' },
      { key: 'conversationOld', section: 'conversationOld', content: sections.conversationSummary || '' },
      { key: 'gossip', section: 'gossip', content: sections.gossip || '' },
      { key: 'misc', section: 'misc', content: sections.misc || '' },
    ];

    let totalUsed = 0;

    for (const item of prioritized) {
      const budget = usage[item.section];
      if (!budget) continue;

      const tokens = this.estimateTokens(item.content);

      if (tokens <= budget.budget) {
        result[item.key] = item.content;
        budget.used = tokens;
      } else {
        // Trim to fit budget
        result[item.key] = this._trimToTokens(item.content, budget.budget);
        budget.used = budget.budget;
        budget.trimmed = true;
      }

      totalUsed += budget.used;
    }

    // Redistribute unused budget to high-demand sections
    const unusedBudget = this.maxTokens - totalUsed;
    if (unusedBudget > 1000) {
      // Give extra budget to conversation and memory
      const extras = ['conversationNew', 'memory', 'sheetData'];
      for (const key of extras) {
        if (usage[key] && usage[key].trimmed) {
          const originalContent = prioritized.find(p => p.key === key)?.content || '';
          const extraTokens = Math.min(unusedBudget / extras.length, this.estimateTokens(originalContent) - usage[key].used);
          if (extraTokens > 0) {
            result[key] = this._trimToTokens(originalContent, usage[key].budget + extraTokens);
            usage[key].used += extraTokens;
          }
        }
      }
    }

    return { context: result, usage, totalTokens: totalUsed };
  }

  /**
   * Compress conversation history
   * Keeps recent messages, summarizes older ones
   */
  compressConversation(sessionId, messages) {
    if (!messages || messages.length <= this.compressionThreshold) {
      return {
        recentMessages: messages || [],
        summary: '',
        entities: [],
        compressed: false,
      };
    }

    const recent = messages.slice(-this.keepRecentMessages);
    const old = messages.slice(0, -this.keepRecentMessages);

    // Extract entities from old messages before summarizing
    const entities = this._extractEntities(old);

    // Build summary of old messages
    const summary = this._summarizeMessages(old);

    // Persist entities
    for (const entity of entities) {
      this._persistEntity(sessionId, entity);
    }

    // Store summary
    this.db.prepare(`
      INSERT INTO conversation_summaries (session_id, summary, message_range, entities, token_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId, summary,
      `messages ${1}-${old.length}`,
      JSON.stringify(entities),
      this.estimateTokens(summary)
    );

    return {
      recentMessages: recent,
      summary,
      entities,
      compressed: true,
      compressedCount: old.length,
    };
  }

  /**
   * Simple message summarization (without calling Claude — pattern-based)
   */
  _summarizeMessages(messages) {
    if (!messages.length) return '';

    const topics = new Set();
    const actions = [];
    const keyFacts = [];

    for (const msg of messages) {
      const text = typeof msg === 'string' ? msg : (msg.content || msg.text || '');

      // Extract topics
      const topicPatterns = [
        /(?:about|regarding|concerning)\s+(.+?)(?:\.|,|$)/i,
        /(?:villa|booking|guest|payment|maintenance|expense|staff)/gi,
      ];
      for (const pattern of topicPatterns) {
        const matches = text.match(pattern);
        if (matches) {
          for (const m of matches) topics.add(m.toLowerCase().trim());
        }
      }

      // Extract actions taken
      const actionPatterns = [
        /(?:I've|I have|we've|done|completed|created|sent|updated|confirmed|booked|checked|found)\s+(.+?)(?:\.|!|$)/i,
      ];
      for (const pattern of actionPatterns) {
        const match = text.match(pattern);
        if (match) actions.push(match[0].substring(0, 100));
      }

      // Extract amounts/dates as key facts
      const amounts = text.match(/(?:IDR|Rp|USD|\$)\s*[\d,.]+/g);
      if (amounts) keyFacts.push(...amounts.map(a => `Amount: ${a}`));

      const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g);
      if (dates) keyFacts.push(...dates.map(d => `Date: ${d}`));
    }

    let summary = `[Conversation summary — ${messages.length} messages compressed]\n`;
    if (topics.size > 0) summary += `Topics discussed: ${[...topics].slice(0, 8).join(', ')}\n`;
    if (actions.length > 0) summary += `Actions taken: ${actions.slice(0, 5).join('; ')}\n`;
    if (keyFacts.length > 0) summary += `Key data: ${[...new Set(keyFacts)].slice(0, 5).join('; ')}\n`;

    return summary.substring(0, this.maxSummaryLength);
  }

  /**
   * Extract important entities from messages
   */
  _extractEntities(messages) {
    const entities = [];
    const patterns = {
      'villa_name':   /(?:villa|Vila)\s+([A-Z][a-zA-Z\s]+)/g,
      'guest_name':   /(?:guest|tamu|Mr\.|Mrs\.|Ms\.)\s+([A-Z][a-zA-Z\s]+)/g,
      'amount':       /(?:IDR|Rp|USD|\$)\s*([\d,.]+)/g,
      'date':         /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g,
      'phone_number': /(?:\+?62|08)\d{8,12}/g,
      'email':        /[\w.-]+@[\w.-]+\.\w+/g,
    };

    for (const msg of messages) {
      const text = typeof msg === 'string' ? msg : (msg.content || msg.text || '');
      for (const [type, pattern] of Object.entries(patterns)) {
        let match;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(text)) !== null) {
          entities.push({
            type,
            value: match[1] || match[0],
            context: text.substring(Math.max(0, match.index - 30), match.index + match[0].length + 30),
          });
        }
      }
    }

    // Deduplicate
    const seen = new Set();
    return entities.filter(e => {
      const key = `${e.type}:${e.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _persistEntity(sessionId, entity) {
    const existing = this.db.prepare(`
      SELECT id, mention_count FROM persistent_entities
      WHERE session_id = ? AND entity_type = ? AND entity_value = ?
    `).get(sessionId, entity.type, entity.value);

    if (existing) {
      this.db.prepare(`
        UPDATE persistent_entities SET mention_count = mention_count + 1, last_seen = datetime('now'), context = ?
        WHERE id = ?
      `).run(entity.context || '', existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO persistent_entities (session_id, entity_type, entity_value, context)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, entity.type, entity.value, entity.context || '');
    }
  }

  /**
   * Get persistent entities for a session (survive compression)
   */
  getEntities(sessionId) {
    return this.db.prepare(`
      SELECT * FROM persistent_entities WHERE session_id = ? ORDER BY mention_count DESC LIMIT 20
    `).all(sessionId);
  }

  /**
   * Get entity context string for system prompt
   */
  getEntityContext(sessionId) {
    const entities = this.getEntities(sessionId);
    if (entities.length === 0) return '';

    let ctx = '\n\n--- Known Entities (this conversation) ---\n';
    const byType = {};
    for (const e of entities) {
      if (!byType[e.entity_type]) byType[e.entity_type] = [];
      byType[e.entity_type].push(e.entity_value);
    }
    for (const [type, values] of Object.entries(byType)) {
      ctx += `${type}: ${values.join(', ')}\n`;
    }
    return ctx;
  }

  /**
   * Trim text to approximately fit token budget
   */
  _trimToTokens(text, maxTokens) {
    const estimated = this.estimateTokens(text);
    if (estimated <= maxTokens) return text;

    // Trim from the beginning (keep recent content)
    const ratio = maxTokens / estimated;
    const keepChars = Math.floor(text.length * ratio);
    const trimmed = text.slice(-keepChars);

    // Find first complete sentence/line
    const firstBreak = trimmed.indexOf('\n');
    if (firstBreak > 0 && firstBreak < 200) {
      return '[...trimmed...]\n' + trimmed.slice(firstBreak + 1);
    }
    return '[...trimmed...] ' + trimmed;
  }

  /**
   * Get conversation summaries for a session
   */
  getSummaries(sessionId) {
    return this.db.prepare(`
      SELECT * FROM conversation_summaries WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId);
  }

  /**
   * Cleanup old summaries and entities
   */
  cleanup(daysOld = 30) {
    const summaries = this.db.prepare(`
      DELETE FROM conversation_summaries WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    const entities = this.db.prepare(`
      DELETE FROM persistent_entities WHERE last_seen < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    const logs = this.db.prepare(`
      DELETE FROM context_usage_log WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(7);

    return { deletedSummaries: summaries.changes, deletedEntities: entities.changes, deletedLogs: logs.changes };
  }

  getStats() {
    const summaries = this.db.prepare('SELECT COUNT(*) as c FROM conversation_summaries').get().c;
    const entities = this.db.prepare('SELECT COUNT(*) as c FROM persistent_entities').get().c;
    return {
      summaries,
      persistentEntities: entities,
      maxTokens: this.maxTokens,
      budgetSections: Object.keys(this.budgets).length,
    };
  }
}

module.exports = new ContextWindowManager();
