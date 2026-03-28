/**
 * vector-memory.js — Enhanced Vector Memory for TVMbot
 * Inspired by ruflo's AgentDB + HNSW vector search
 *
 * Upgrades TVMbot's memory from keyword-based to SEMANTIC search:
 *   - TF-IDF vectorization (no external API needed, $0 cost)
 *   - Cosine similarity for finding relevant memories
 *   - Namespace isolation per business division
 *   - Automatic importance scoring
 *   - Temporal decay for relevance
 *   - Cross-division memory linking
 *
 * This sits ON TOP of the existing memory-manager.js, not replacing it.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── DATABASE ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'vector-memory.db');
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
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL DEFAULT 'general',
    content TEXT NOT NULL,
    vector TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    source TEXT,
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    access_count INTEGER DEFAULT 0,
    last_accessed TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vocabulary (
    term TEXT PRIMARY KEY,
    idf REAL DEFAULT 0,
    doc_count INTEGER DEFAULT 0,
    total_docs INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS memory_links (
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    link_type TEXT DEFAULT 'related',
    strength REAL DEFAULT 1.0,
    PRIMARY KEY (source_id, target_id),
    FOREIGN KEY (source_id) REFERENCES memories(id),
    FOREIGN KEY (target_id) REFERENCES memories(id)
  );

  CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
`);

// ─── STOP WORDS ──────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'at', 'by', 'with', 'from', 'up', 'about', 'into', 'through',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its',
  'they', 'them', 'their', 'what', 'which', 'who', 'when', 'where',
  'why', 'how', 'please', 'thanks', 'thank',
  // Bahasa Indonesia
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada',
  'ini', 'itu', 'ada', 'tidak', 'sudah', 'akan', 'bisa', 'juga',
  'saya', 'kami', 'kita', 'anda', 'mereka', 'nya', 'lah',
]);

// ─── TF-IDF VECTORIZER ──────────────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function termFrequency(tokens) {
  const tf = {};
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  // Normalize
  const max = Math.max(...Object.values(tf), 1);
  for (const key of Object.keys(tf)) {
    tf[key] /= max;
  }
  return tf;
}

function vectorize(text) {
  const tokens = tokenize(text);
  const tf = termFrequency(tokens);
  const vector = {};

  for (const [term, freq] of Object.entries(tf)) {
    const idfRow = db.prepare('SELECT idf FROM vocabulary WHERE term = ?').get(term);
    const idf = idfRow ? idfRow.idf : Math.log(100); // Default high IDF for rare terms
    vector[term] = freq * idf;
  }

  return vector;
}

function cosineSimilarity(v1, v2) {
  const terms = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (const term of terms) {
    const a = v1[term] || 0;
    const b = v2[term] || 0;
    dotProduct += a * b;
    norm1 += a * a;
    norm2 += b * b;
  }

  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
  return denominator > 0 ? dotProduct / denominator : 0;
}

// ─── IMPORTANCE SCORER ───────────────────────────────────────────────────────

function scoreImportance(text, source = '') {
  let score = 0.5; // Default

  // Higher importance for business-critical content
  const highImportance = [
    /payment|paid|transfer|invoice|outstanding|profit|loss|revenue/i,
    /contract|agreement|signed|expired|terminate/i,
    /booking|reservation|confirmed|cancelled/i,
    /emergency|urgent|critical|broken|leak|damage/i,
    /decision|approved|rejected|policy|rule/i,
    /hired|fired|salary|payroll/i,
    /deadline|due\s+date|overdue/i,
  ];

  const mediumImportance = [
    /scheduled|meeting|appointment|reminder/i,
    /guest|check-in|check-out|arrival/i,
    /maintenance|repair|fix|replace/i,
    /delivery|order|shipment|inventory/i,
    /project|renovation|construction|progress/i,
  ];

  for (const pattern of highImportance) {
    if (pattern.test(text)) { score += 0.15; break; }
  }
  for (const pattern of mediumImportance) {
    if (pattern.test(text)) { score += 0.08; break; }
  }

  // Boost for longer, more detailed content
  if (text.length > 200) score += 0.05;
  if (text.length > 500) score += 0.05;

  // Boost if from specific sources
  if (source === 'user_explicit') score += 0.1;
  if (source === 'tool_result') score += 0.08;

  return Math.min(1.0, score);
}

// ─── NAMESPACES ──────────────────────────────────────────────────────────────
const NAMESPACES = {
  'villa': 'Villa management operations, bookings, maintenance, guests',
  'agency': 'Property agency deals, listings, clients, commissions',
  'furniture': 'Furniture business inventory, orders, deliveries, suppliers',
  'renovation': 'Renovation projects, contractors, timelines, budgets',
  'interior': 'Interior design concepts, materials, styling',
  'finance': 'Cross-division financial data, payments, reports',
  'hr': 'Staff management, payroll, assignments',
  'general': 'General business knowledge and cross-division data',
};

// ─── VECTOR MEMORY CLASS ────────────────────────────────────────────────────

class VectorMemory {
  constructor() {
    this._rebuildVocabulary();
    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
    console.log(`[VectorMemory] Initialized with ${count} memories, ${Object.keys(NAMESPACES).length} namespaces`);
  }

  /**
   * Store a new memory with vector embedding
   */
  store(content, opts = {}) {
    const {
      namespace = 'general',
      source = '',
      tags = [],
      metadata = {},
      expiresIn = null, // milliseconds
    } = opts;

    const vector = vectorize(content);
    const importance = scoreImportance(content, source);
    const now = new Date().toISOString();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn).toISOString() : null;

    const result = db.prepare(`INSERT INTO memories
      (namespace, content, vector, importance, source, tags, metadata, created_at, expires_at, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        namespace, content, JSON.stringify(vector), importance,
        source, JSON.stringify(tags), JSON.stringify(metadata),
        now, expiresAt, now
      );

    // Update vocabulary
    this._updateVocabulary(content);

    return { id: result.lastInsertRowid, importance, namespace };
  }

  /**
   * Semantic search — find memories most similar to a query
   */
  search(query, opts = {}) {
    const {
      namespace = null,     // null = search all namespaces
      limit = 5,
      minSimilarity = 0.1,
      includeExpired = false,
    } = opts;

    const queryVector = vectorize(query);
    if (Object.keys(queryVector).length === 0) return [];

    // Get candidate memories
    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params = [];

    if (namespace) {
      sql += ' AND namespace = ?';
      params.push(namespace);
    }
    if (!includeExpired) {
      sql += " AND (expires_at IS NULL OR expires_at > datetime('now'))";
    }
    sql += ' ORDER BY importance DESC LIMIT 200'; // Pre-filter top 200 by importance
    params.push();

    const candidates = db.prepare(sql).all(...params);

    // Score by cosine similarity + importance + recency
    const now = Date.now();
    const scored = candidates.map(mem => {
      const memVector = JSON.parse(mem.vector);
      const sim = cosineSimilarity(queryVector, memVector);

      // Temporal decay: memories lose relevance over time
      const ageMs = now - new Date(mem.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyDecay = Math.exp(-ageDays / 90); // Half-life ~62 days

      // Composite score: 50% similarity + 30% importance + 20% recency
      const compositeScore = sim * 0.5 + mem.importance * 0.3 + recencyDecay * 0.2;

      return {
        id: mem.id,
        content: mem.content,
        namespace: mem.namespace,
        similarity: Math.round(sim * 1000) / 1000,
        importance: mem.importance,
        compositeScore: Math.round(compositeScore * 1000) / 1000,
        source: mem.source,
        tags: JSON.parse(mem.tags || '[]'),
        createdAt: mem.created_at,
        ageDays: Math.round(ageDays),
      };
    })
    .filter(m => m.similarity >= minSimilarity)
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, limit);

    // Update access counts
    for (const m of scored) {
      db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?')
        .run(new Date().toISOString(), m.id);
    }

    return scored;
  }

  /**
   * Build context string for system prompt from relevant memories
   */
  buildContext(query, opts = {}) {
    const { namespace = null, limit = 3 } = opts;
    const results = this.search(query, { namespace, limit, minSimilarity: 0.15 });

    if (results.length === 0) return '';

    const parts = ['\n--- RELEVANT MEMORIES ---'];
    for (const mem of results) {
      const nsLabel = mem.namespace !== 'general' ? ` [${mem.namespace.toUpperCase()}]` : '';
      parts.push(`${nsLabel} (${mem.ageDays}d ago, relevance: ${Math.round(mem.compositeScore * 100)}%): ${mem.content.substring(0, 300)}`);
    }
    parts.push('--- END MEMORIES ---\n');

    return parts.join('\n');
  }

  /**
   * Link two memories together
   */
  link(sourceId, targetId, linkType = 'related', strength = 1.0) {
    db.prepare('INSERT OR REPLACE INTO memory_links (source_id, target_id, link_type, strength) VALUES (?, ?, ?, ?)')
      .run(sourceId, targetId, linkType, strength);
  }

  /**
   * Get linked memories
   */
  getLinked(memoryId, limit = 5) {
    return db.prepare(`SELECT m.*, ml.link_type, ml.strength
      FROM memory_links ml
      JOIN memories m ON m.id = ml.target_id
      WHERE ml.source_id = ?
      ORDER BY ml.strength DESC LIMIT ?`)
      .all(memoryId, limit);
  }

  /**
   * Cleanup: remove expired and low-value memories
   */
  cleanup() {
    const now = new Date().toISOString();

    // Remove expired
    const expired = db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);

    // Remove very old, low-importance, rarely-accessed memories
    const stale = db.prepare(`DELETE FROM memories
      WHERE importance < 0.3
      AND access_count < 2
      AND created_at < datetime('now', '-90 days')`).run();

    // Rebuild vocabulary after cleanup
    if (expired.changes + stale.changes > 0) {
      this._rebuildVocabulary();
    }

    return { expired: expired.changes, stale: stale.changes };
  }

  // ─── VOCABULARY MANAGEMENT ──────────────────────────────────────────────

  _updateVocabulary(text) {
    const tokens = new Set(tokenize(text));
    const totalDocs = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;

    for (const term of tokens) {
      const existing = db.prepare('SELECT doc_count FROM vocabulary WHERE term = ?').get(term);
      if (existing) {
        const newCount = existing.doc_count + 1;
        const idf = Math.log((totalDocs + 1) / (newCount + 1)) + 1;
        db.prepare('UPDATE vocabulary SET doc_count = ?, idf = ?, total_docs = ? WHERE term = ?')
          .run(newCount, idf, totalDocs, term);
      } else {
        const idf = Math.log((totalDocs + 1) / 2) + 1;
        db.prepare('INSERT INTO vocabulary (term, idf, doc_count, total_docs) VALUES (?, ?, 1, ?)')
          .run(term, idf, totalDocs);
      }
    }
  }

  _rebuildVocabulary() {
    const totalDocs = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
    if (totalDocs === 0) return;

    // Get all memory content
    const memories = db.prepare('SELECT content FROM memories').all();
    const docFreq = {};

    for (const mem of memories) {
      const tokens = new Set(tokenize(mem.content));
      for (const token of tokens) {
        docFreq[token] = (docFreq[token] || 0) + 1;
      }
    }

    // Rebuild vocabulary table
    db.prepare('DELETE FROM vocabulary').run();
    const stmt = db.prepare('INSERT INTO vocabulary (term, idf, doc_count, total_docs) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction((terms) => {
      for (const [term, count] of terms) {
        const idf = Math.log((totalDocs + 1) / (count + 1)) + 1;
        stmt.run(term, idf, count, totalDocs);
      }
    });
    insertMany(Object.entries(docFreq));
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
    const byNamespace = db.prepare('SELECT namespace, COUNT(*) as count FROM memories GROUP BY namespace ORDER BY count DESC').all();
    const vocabSize = db.prepare('SELECT COUNT(*) as c FROM vocabulary').get().c;
    const avgImportance = db.prepare('SELECT AVG(importance) as avg FROM memories').get().avg || 0;
    const links = db.prepare('SELECT COUNT(*) as c FROM memory_links').get().c;

    return {
      totalMemories: total,
      byNamespace,
      vocabularySize: vocabSize,
      avgImportance: Math.round(avgImportance * 100) / 100,
      totalLinks: links,
      namespaces: Object.keys(NAMESPACES),
    };
  }
}

// ─── SINGLETON EXPORT ────────────────────────────────────────────────────────
const vectorMemory = new VectorMemory();

module.exports = vectorMemory;
module.exports.VectorMemory = VectorMemory;
module.exports.NAMESPACES = NAMESPACES;
module.exports.cosineSimilarity = cosineSimilarity;
module.exports.vectorize = vectorize;
module.exports.tokenize = tokenize;
