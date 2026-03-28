/**
 * Gossip Protocol — Inter-Agent Knowledge Sharing
 * Inspired by ruflo's distributed agent communication layer.
 *
 * Agents share discoveries, learned patterns, and insights with each other
 * using epidemic-style gossip propagation. When one agent learns something useful,
 * it broadcasts to relevant peers, building collective intelligence.
 *
 * Features:
 *   - Topic-based pub/sub channels per business division
 *   - Relevance scoring — agents only receive gossip matching their domain
 *   - Decay + dedup — old/duplicate gossip dies naturally
 *   - Priority propagation — critical discoveries spread faster
 *   - Cross-division insights — serendipitous knowledge sharing
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'gossip.db');

class GossipProtocol {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Topic channels — each maps to interested agent roles
    this.channels = {
      'villa-ops':      ['villa-ops', 'booking-agent', 'guest-relations', 'quality-auditor'],
      'agency':         ['agency-manager', 'marketing-manager', 'research-agent'],
      'furniture':      ['furniture-manager', 'interior-designer'],
      'renovation':     ['renovation-manager', 'interior-designer'],
      'interior':       ['interior-designer', 'renovation-manager', 'furniture-manager'],
      'finance':        ['finance-director', 'data-analyst', 'strategic-advisor'],
      'hr':             ['hr-admin', 'quality-auditor'],
      'marketing':      ['marketing-manager', 'research-agent', 'agency-manager'],
      'intelligence':   ['strategic-advisor', 'data-analyst', 'memory-keeper', 'knowledge-linker'],
      'memory':         ['memory-keeper', 'knowledge-linker', 'learning-optimizer'],
      'security':       ['quality-auditor', 'hr-admin'],
      'cross-division': ['strategic-advisor', 'finance-director', 'quality-auditor'],
    };

    // Gossip types with TTL (hours) and propagation priority
    this.gossipTypes = {
      'discovery':       { ttl: 168, priority: 3, description: 'New pattern or insight discovered' },
      'warning':         { ttl: 72,  priority: 5, description: 'Risk or issue detected' },
      'opportunity':     { ttl: 48,  priority: 4, description: 'Business opportunity identified' },
      'learning':        { ttl: 336, priority: 2, description: 'Learned outcome from past action' },
      'price-change':    { ttl: 24,  priority: 4, description: 'Market price change detected' },
      'guest-insight':   { ttl: 168, priority: 3, description: 'Guest preference or behavior pattern' },
      'process-update':  { ttl: 720, priority: 2, description: 'Business process change' },
      'market-intel':    { ttl: 48,  priority: 4, description: 'Competitor or market intelligence' },
      'tool-failure':    { ttl: 24,  priority: 5, description: 'Tool or integration failure report' },
      'performance-tip': { ttl: 168, priority: 2, description: 'Performance optimization suggestion' },
    };

    // In-memory gossip queue for fast access
    this._recentGossip = [];
    this._maxRecent = 100;

    console.log(`[Gossip] Initialized with ${Object.keys(this.channels).length} channels, ${Object.keys(this.gossipTypes).length} gossip types`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gossip (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gossip_id TEXT UNIQUE,
        source_agent TEXT NOT NULL,
        channel TEXT NOT NULL,
        gossip_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        priority INTEGER DEFAULT 3,
        ttl_hours INTEGER DEFAULT 168,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        read_count INTEGER DEFAULT 0,
        usefulness_score REAL DEFAULT 0.5
      );

      CREATE TABLE IF NOT EXISTS gossip_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gossip_id TEXT NOT NULL,
        reader_agent TEXT NOT NULL,
        read_at TEXT DEFAULT (datetime('now')),
        found_useful INTEGER DEFAULT 0,
        UNIQUE(gossip_id, reader_agent)
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        agent TEXT NOT NULL,
        channel TEXT NOT NULL,
        subscribed_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (agent, channel)
      );

      CREATE INDEX IF NOT EXISTS idx_gossip_channel ON gossip(channel);
      CREATE INDEX IF NOT EXISTS idx_gossip_type ON gossip(gossip_type);
      CREATE INDEX IF NOT EXISTS idx_gossip_expires ON gossip(expires_at);
      CREATE INDEX IF NOT EXISTS idx_gossip_source ON gossip(source_agent);
    `);
  }

  /**
   * Broadcast gossip from an agent to a channel
   */
  broadcast(sourceAgent, channel, gossipType, subject, body, metadata = {}) {
    const typeConfig = this.gossipTypes[gossipType] || { ttl: 48, priority: 3 };
    const gossipId = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Check for duplicate (same source + similar subject in last hour)
    const recent = this.db.prepare(`
      SELECT id FROM gossip
      WHERE source_agent = ? AND channel = ? AND subject = ?
      AND created_at > datetime('now', '-1 hour')
    `).get(sourceAgent, channel, subject);

    if (recent) {
      return { duplicate: true, gossipId: null };
    }

    this.db.prepare(`
      INSERT INTO gossip (gossip_id, source_agent, channel, gossip_type, subject, body, metadata, priority, ttl_hours, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
    `).run(
      gossipId, sourceAgent, channel, gossipType,
      subject, body, JSON.stringify(metadata),
      typeConfig.priority, typeConfig.ttl, typeConfig.ttl
    );

    // Add to recent queue
    this._recentGossip.unshift({
      gossipId, sourceAgent, channel, gossipType, subject, body, metadata,
      priority: typeConfig.priority, createdAt: new Date().toISOString()
    });
    if (this._recentGossip.length > this._maxRecent) {
      this._recentGossip.pop();
    }

    // Auto-broadcast to cross-division if priority >= 4
    if (typeConfig.priority >= 4 && channel !== 'cross-division') {
      this.db.prepare(`
        INSERT OR IGNORE INTO gossip (gossip_id, source_agent, channel, gossip_type, subject, body, metadata, priority, ttl_hours, expires_at)
        VALUES (?, ?, 'cross-division', ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
      `).run(
        gossipId + '_xdiv', sourceAgent, gossipType,
        `[Cross-Div] ${subject}`, body, JSON.stringify({ ...metadata, originalChannel: channel }),
        typeConfig.priority, typeConfig.ttl, typeConfig.ttl
      );
    }

    return { duplicate: false, gossipId, channel, priority: typeConfig.priority };
  }

  /**
   * Agent reads gossip from its subscribed channels
   */
  readGossip(agentName, options = {}) {
    const { limit = 10, unreadOnly = true, minPriority = 1, channels: filterChannels } = options;

    // Get agent's channels
    let agentChannels = filterChannels || [];
    if (agentChannels.length === 0) {
      for (const [channel, agents] of Object.entries(this.channels)) {
        if (agents.includes(agentName)) {
          agentChannels.push(channel);
        }
      }
    }

    if (agentChannels.length === 0) return [];

    const placeholders = agentChannels.map(() => '?').join(',');

    let query;
    if (unreadOnly) {
      query = this.db.prepare(`
        SELECT g.* FROM gossip g
        LEFT JOIN gossip_reads gr ON g.gossip_id = gr.gossip_id AND gr.reader_agent = ?
        WHERE g.channel IN (${placeholders})
        AND g.expires_at > datetime('now')
        AND g.priority >= ?
        AND gr.id IS NULL
        AND g.source_agent != ?
        ORDER BY g.priority DESC, g.created_at DESC
        LIMIT ?
      `);
    } else {
      query = this.db.prepare(`
        SELECT g.* FROM gossip g
        WHERE g.channel IN (${placeholders})
        AND g.expires_at > datetime('now')
        AND g.priority >= ?
        AND g.source_agent != ?
        ORDER BY g.priority DESC, g.created_at DESC
        LIMIT ?
      `);
    }

    const params = unreadOnly
      ? [agentName, ...agentChannels, minPriority, agentName, limit]
      : [...agentChannels, minPriority, agentName, limit];

    const rows = query.all(...params);

    // Mark as read
    const markRead = this.db.prepare(`
      INSERT OR IGNORE INTO gossip_reads (gossip_id, reader_agent) VALUES (?, ?)
    `);
    const updateCount = this.db.prepare(`
      UPDATE gossip SET read_count = read_count + 1 WHERE gossip_id = ?
    `);

    for (const row of rows) {
      markRead.run(row.gossip_id, agentName);
      updateCount.run(row.gossip_id);
    }

    return rows.map(r => ({
      gossipId: r.gossip_id,
      source: r.source_agent,
      channel: r.channel,
      type: r.gossip_type,
      subject: r.subject,
      body: r.body,
      metadata: JSON.parse(r.metadata || '{}'),
      priority: r.priority,
      createdAt: r.created_at,
    }));
  }

  /**
   * Mark gossip as useful/not useful (feedback for future relevance)
   */
  markUsefulness(gossipId, agentName, useful) {
    this.db.prepare(`
      UPDATE gossip_reads SET found_useful = ? WHERE gossip_id = ? AND reader_agent = ?
    `).run(useful ? 1 : 0, gossipId, agentName);

    // Update aggregate usefulness score
    const stats = this.db.prepare(`
      SELECT COUNT(*) as total, SUM(found_useful) as useful_count
      FROM gossip_reads WHERE gossip_id = ?
    `).get(gossipId);

    if (stats.total > 0) {
      const score = stats.useful_count / stats.total;
      this.db.prepare(`UPDATE gossip SET usefulness_score = ? WHERE gossip_id = ?`).run(score, gossipId);
    }
  }

  /**
   * Get gossip context for system prompt injection
   * Provides relevant recent gossip for the current agent/intent
   */
  getContextForAgent(agentName, intent) {
    const gossip = this.readGossip(agentName, { limit: 5, unreadOnly: true, minPriority: 3 });

    if (gossip.length === 0) return '';

    let ctx = '\n\n--- Agent Intel (Gossip Protocol) ---\n';
    ctx += 'Recent relevant intel from other agents:\n';
    for (const g of gossip) {
      ctx += `• [${g.type}] from ${g.source}: ${g.subject} — ${g.body.substring(0, 150)}\n`;
    }
    return ctx;
  }

  /**
   * Auto-generate gossip from system events
   */
  autoGossipFromEvent(eventType, data) {
    const generators = {
      'booking_created': () => this.broadcast('booking-agent', 'villa-ops', 'discovery',
        `New booking: ${data.villa || 'unknown villa'}`,
        `Booking created for ${data.dates || 'unknown dates'}. Guest: ${data.guestName || 'unknown'}.`,
        data),

      'price_found': () => this.broadcast('research-agent', 'marketing', 'price-change',
        `Price data: ${data.source || 'web'}`,
        `Found pricing: ${data.description || JSON.stringify(data).substring(0, 200)}`,
        data),

      'maintenance_alert': () => this.broadcast('villa-ops', 'villa-ops', 'warning',
        `Maintenance needed: ${data.villa || 'unknown'}`,
        `${data.issue || 'Issue reported'}. Priority: ${data.priority || 'normal'}.`,
        data),

      'expense_large': () => this.broadcast('finance-director', 'finance', 'warning',
        `Large expense flagged: ${data.amount || 'unknown'}`,
        `Expense of ${data.amount} for ${data.description || 'unknown purpose'}. Requires review.`,
        data),

      'guest_feedback': () => this.broadcast('guest-relations', 'villa-ops', 'guest-insight',
        `Guest feedback: ${data.sentiment || 'neutral'}`,
        `${data.feedback || 'Feedback received'} for ${data.villa || 'unknown villa'}.`,
        data),

      'tool_error': () => this.broadcast('quality-auditor', 'security', 'tool-failure',
        `Tool failure: ${data.tool || 'unknown'}`,
        `Error: ${data.error || 'unknown error'}. Affected: ${data.affected || 'unknown'}.`,
        data),

      'market_intel': () => this.broadcast('research-agent', 'marketing', 'market-intel',
        `Market update: ${data.topic || 'general'}`,
        `${data.summary || JSON.stringify(data).substring(0, 200)}`,
        data),

      'learning_outcome': () => this.broadcast('learning-optimizer', 'memory', 'learning',
        `Pattern learned: ${data.pattern || 'unknown'}`,
        `Outcome: ${data.outcome || 'unknown'}. Confidence: ${data.confidence || 'unknown'}.`,
        data),
    };

    const generator = generators[eventType];
    if (generator) return generator();
    return null;
  }

  /**
   * Cleanup expired gossip
   */
  cleanup() {
    const deleted = this.db.prepare(`
      DELETE FROM gossip WHERE expires_at < datetime('now')
    `).run();

    // Clean orphaned reads
    this.db.prepare(`
      DELETE FROM gossip_reads WHERE gossip_id NOT IN (SELECT gossip_id FROM gossip)
    `).run();

    return { deletedGossip: deleted.changes };
  }

  /**
   * Get statistics
   */
  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM gossip').get().c;
    const active = this.db.prepare("SELECT COUNT(*) as c FROM gossip WHERE expires_at > datetime('now')").get().c;
    const byChannel = this.db.prepare(`
      SELECT channel, COUNT(*) as c FROM gossip
      WHERE expires_at > datetime('now')
      GROUP BY channel ORDER BY c DESC
    `).all();
    const byType = this.db.prepare(`
      SELECT gossip_type, COUNT(*) as c FROM gossip
      WHERE expires_at > datetime('now')
      GROUP BY gossip_type ORDER BY c DESC
    `).all();
    const avgUsefulness = this.db.prepare(`
      SELECT AVG(usefulness_score) as avg FROM gossip WHERE read_count > 0
    `).get();

    return {
      total, active,
      byChannel: Object.fromEntries(byChannel.map(r => [r.channel, r.c])),
      byType: Object.fromEntries(byType.map(r => [r.gossip_type, r.c])),
      avgUsefulness: avgUsefulness.avg || 0,
    };
  }
}

module.exports = new GossipProtocol();
