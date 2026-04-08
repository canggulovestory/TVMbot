/**
 * Response Cache — Intelligent Caching for Repeated Queries
 * Inspired by ruflo's response deduplication and caching layer.
 *
 * Caches Claude API responses to avoid redundant (expensive) calls.
 * Uses semantic fingerprinting to match similar queries.
 *
 * Features:
 *   - Exact match cache (hash-based)
 *   - Semantic similarity cache (fuzzy matching)
 *   - TTL per cache category (static data = long, dynamic = short)
 *   - Cost tracking (estimated API savings)
 *   - Cache invalidation hooks
 *   - Stale-while-revalidate pattern
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'response-cache.db');

class ResponseCache {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Cache categories with TTL
    this.categories = {
      'static':     { ttlMs: 7 * 24 * 60 * 60 * 1000, description: 'Static info (villa details, company info)' },
      'semi-static': { ttlMs: 24 * 60 * 60 * 1000, description: 'Slowly changing (pricing, policies)' },
      'dynamic':    { ttlMs: 15 * 60 * 1000, description: 'Frequently changing (availability, bookings)' },
      'volatile':   { ttlMs: 5 * 60 * 1000, description: 'Rapidly changing (messages, status)' },
      'faq':        { ttlMs: 3 * 24 * 60 * 60 * 1000, description: 'FAQ responses' },
      'greeting':   { ttlMs: 30 * 24 * 60 * 60 * 1000, description: 'Greeting/intro responses' },
    };

    // Patterns to determine cache category
    this.categoryPatterns = {
      'greeting':   [/^(?:hi|hello|hey|halo|hai|selamat)/i, /^(?:who are you|what can you do|apa bisa)/i],
      'faq':        [/(?:how (?:do|can) (?:I|we)|where (?:is|are)|what (?:is|are) the)/i, /(?:bagaimana|dimana|apa itu)/i],
      'static':     [/(?:villa (?:details|info|address|location)|company|about TVM)/i],
      'semi-static': [/(?:price|pricing|rate|tarif|harga|policy|aturan)/i],
      'dynamic':    [/(?:available|availability|booking|schedule|jadwal|today|tomorrow)/i],
      'volatile':   [/(?:status|current|now|latest|terbaru|sekarang)/i],
    };

    // In-memory LRU for hot queries
    this._lru = new Map();
    this._lruMax = 200;

    // Cost tracking
    this._costPerCall = 0.003; // Estimated USD per Claude API call

    console.log(`[ResponseCache] Initialized with ${Object.keys(this.categories).length} cache categories, LRU size ${this._lruMax}`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT UNIQUE,
        query_hash TEXT NOT NULL,
        query_text TEXT NOT NULL,
        query_fingerprint TEXT,
        category TEXT DEFAULT 'dynamic',
        response TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        hit_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        last_hit_at TEXT
      );

      CREATE TABLE IF NOT EXISTS cache_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        category TEXT,
        saved_cost REAL DEFAULT 0,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cache_invalidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL,
        reason TEXT,
        invalidated_count INTEGER DEFAULT 0,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cache_key ON cache_entries(cache_key);
      CREATE INDEX IF NOT EXISTS idx_cache_hash ON cache_entries(query_hash);
      CREATE INDEX IF NOT EXISTS idx_cache_fingerprint ON cache_entries(query_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
    `);
  }

  /**
   * Look up cache for a query
   * Returns cached response or null
   */
  get(query, context = {}) {
    const hash = this._hash(query);
    const fingerprint = this._fingerprint(query);

    // 1. Check LRU (fastest)
    const lruKey = hash;
    if (this._lru.has(lruKey)) {
      const entry = this._lru.get(lruKey);
      if (Date.now() < entry.expiresAt) {
        this._recordHit(entry.cacheKey, 'lru');
        return { cached: true, response: entry.response, source: 'lru', category: entry.category };
      }
      this._lru.delete(lruKey);
    }

    // 2. Check exact match (DB)
    const exact = this.db.prepare(`
      SELECT * FROM cache_entries WHERE query_hash = ? AND expires_at > datetime('now') LIMIT 1
    `).get(hash);

    if (exact) {
      this._recordHit(exact.cache_key, 'exact');
      this._addToLru(hash, exact);
      return { cached: true, response: exact.response, source: 'exact', category: exact.category };
    }

    // 3. Check semantic match (fingerprint similarity)
    const similar = this.db.prepare(`
      SELECT * FROM cache_entries WHERE query_fingerprint = ? AND expires_at > datetime('now') LIMIT 1
    `).get(fingerprint);

    if (similar) {
      this._recordHit(similar.cache_key, 'semantic');
      this._addToLru(hash, similar);
      return { cached: true, response: similar.response, source: 'semantic', category: similar.category };
    }

    return null;
  }

  /**
   * Store a response in cache
   */
  set(query, response, options = {}) {
    const { category: explicitCategory, metadata = {} } = options;

    const hash = this._hash(query);
    const fingerprint = this._fingerprint(query);
    const category = explicitCategory || this._detectCategory(query);
    const ttl = this.categories[category]?.ttlMs || this.categories['dynamic'].ttlMs;
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    const cacheKey = `c_${hash.substring(0, 12)}`;

    this.db.prepare(`
      INSERT OR REPLACE INTO cache_entries (cache_key, query_hash, query_text, query_fingerprint, category, response, metadata, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cacheKey, hash, query.substring(0, 500), fingerprint, category, response, JSON.stringify(metadata), expiresAt);

    // Add to LRU
    this._addToLru(hash, { cache_key: cacheKey, response, category, expires_at: expiresAt });

    return { cacheKey, category, ttlMs: ttl };
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  invalidate(pattern, reason = '') {
    const entries = this.db.prepare(`
      SELECT cache_key FROM cache_entries WHERE query_text LIKE ? OR category = ?
    `).all(`%${pattern}%`, pattern);

    if (entries.length > 0) {
      this.db.prepare(`
        DELETE FROM cache_entries WHERE query_text LIKE ? OR category = ?
      `).run(`%${pattern}%`, pattern);
    }

    // Clear LRU entries
    for (const [key, entry] of this._lru.entries()) {
      if (entry.category === pattern) this._lru.delete(key);
    }

    this.db.prepare(`
      INSERT INTO cache_invalidations (pattern, reason, invalidated_count) VALUES (?, ?, ?)
    `).run(pattern, reason, entries.length);

    return { invalidated: entries.length };
  }

  /**
   * Invalidate all cache (nuclear option)
   */
  flush() {
    const count = this.db.prepare('SELECT COUNT(*) as c FROM cache_entries').get().c;
    this.db.prepare('DELETE FROM cache_entries').run();
    this._lru.clear();
    return { flushed: count };
  }

  _hash(text) {
    return crypto.createHash('md5').update(text.toLowerCase().trim()).digest('hex');
  }

  _fingerprint(text) {
    // Normalize → remove stop words → sort → hash
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'it', 'this', 'that', 'and', 'or', 'but', 'not', 'can', 'do',
      'yang', 'di', 'ke', 'dari', 'ini', 'itu', 'dan', 'atau', 'untuk', 'dengan', 'ada']);

    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .sort();

    return crypto.createHash('md5').update(words.join(' ')).digest('hex');
  }

  _detectCategory(query) {
    for (const [category, patterns] of Object.entries(this.categoryPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(query)) return category;
      }
    }
    return 'dynamic';
  }

  _addToLru(hash, entry) {
    if (this._lru.size >= this._lruMax) {
      const firstKey = this._lru.keys().next().value;
      this._lru.delete(firstKey);
    }
    this._lru.set(hash, {
      cacheKey: entry.cache_key,
      response: entry.response,
      category: entry.category,
      expiresAt: new Date(entry.expires_at).getTime(),
    });
  }

  _recordHit(cacheKey, source) {
    this.db.prepare(`
      UPDATE cache_entries SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE cache_key = ?
    `).run(cacheKey);

    this.db.prepare(`
      INSERT INTO cache_stats (event_type, category, saved_cost) VALUES (?, ?, ?)
    `).run('hit:' + source, '', this._costPerCall);
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM cache_entries').get().c;
    const active = this.db.prepare("SELECT COUNT(*) as c FROM cache_entries WHERE expires_at > datetime('now')").get().c;
    const totalHits = this.db.prepare('SELECT SUM(hit_count) as s FROM cache_entries').get().s || 0;
    const savedCost = this.db.prepare('SELECT SUM(saved_cost) as s FROM cache_stats').get().s || 0;
    const byCategory = this.db.prepare(`
      SELECT category, COUNT(*) as c, SUM(hit_count) as hits FROM cache_entries GROUP BY category
    `).all();
    const lruSize = this._lru.size;

    return {
      total, active, totalHits, savedCost: `$${savedCost.toFixed(2)}`,
      lruSize,
      byCategory: Object.fromEntries(byCategory.map(r => [r.category, { entries: r.c, hits: r.hits }])),
    };
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const deleted = this.db.prepare("DELETE FROM cache_entries WHERE expires_at < datetime('now')").run();
    const oldStats = this.db.prepare("DELETE FROM cache_stats WHERE timestamp < datetime('now', '-30 days')").run();
    return { deletedEntries: deleted.changes, deletedStats: oldStats.changes };
  }
}

module.exports = new ResponseCache();
