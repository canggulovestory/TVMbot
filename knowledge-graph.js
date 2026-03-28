// knowledge-graph.js — Entity Relationship Engine for TVMbot
// Inspired by Obsidian's bidirectional linking + NotebookLM's knowledge indexing
//
// Creates a persistent knowledge graph where every entity (villa, guest, staff,
// document, issue) is a node, and relationships between them are edges.
//
// Architecture:
//   ENTITIES (nodes): villa, guest, staff, document, issue, booking, payment
//   RELATIONS (edges): entity_a → relation_type → entity_b
//   NOTES: free-form knowledge attached to entities
//
// This enables queries like:
//   "What do we know about Villa Lian?" → returns all linked entities
//   "Which guests stayed at Villa Ann?" → traverses guest→booking→villa
//   "What maintenance issues does Diane have?" → traverses villa→issue

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'knowledge-graph.db');
const db = new Database(DB_PATH);

// ─── Schema ────────────────────────────────────────────────────────────────────
const _now = () => new Date().toISOString();

db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    strength REAL DEFAULT 1.0,
    created_at TEXT,
    FOREIGN KEY (source_id) REFERENCES entities(id),
    FOREIGN KEY (target_id) REFERENCES entities(id)
  );

  CREATE TABLE IF NOT EXISTS knowledge_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    tags TEXT DEFAULT '[]',
    created_at TEXT,
    FOREIGN KEY (entity_id) REFERENCES entities(id)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(type);
  CREATE INDEX IF NOT EXISTS idx_entity_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_rel_source ON relations(source_id);
  CREATE INDEX IF NOT EXISTS idx_rel_target ON relations(target_id);
  CREATE INDEX IF NOT EXISTS idx_rel_type ON relations(relation);
  CREATE INDEX IF NOT EXISTS idx_note_entity ON knowledge_notes(entity_id);
`);

// ─── Entity Types ──────────────────────────────────────────────────────────────
const ENTITY_TYPES = {
  VILLA: 'villa',
  GUEST: 'guest',
  STAFF: 'staff',
  DOCUMENT: 'document',
  ISSUE: 'issue',
  BOOKING: 'booking',
  PAYMENT: 'payment',
  SUPPLIER: 'supplier',
};

// ─── Relation Types ────────────────────────────────────────────────────────────
const RELATION_TYPES = {
  STAYED_AT: 'stayed_at',           // guest → villa
  BOOKED: 'booked',                 // guest → booking
  BOOKING_AT: 'booking_at',         // booking → villa
  HAS_ISSUE: 'has_issue',           // villa → issue
  ASSIGNED_TO: 'assigned_to',       // issue → staff
  PAID_FOR: 'paid_for',             // payment → booking
  PAID_BY: 'paid_by',              // payment → guest
  CONTRACTED: 'contracted',         // document → villa
  SIGNED_BY: 'signed_by',          // document → guest
  SUPPLIED_BY: 'supplied_by',       // issue → supplier
  WORKS_AT: 'works_at',            // staff → villa
  RELATED_TO: 'related_to',        // generic link
};

// ─── Entity CRUD ───────────────────────────────────────────────────────────────

function makeEntityId(type, name) {
  return `${type}:${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

function upsertEntity(type, name, metadata = {}, aliases = []) {
  const id = makeEntityId(type, name);
  const existing = db.prepare('SELECT id, metadata, aliases FROM entities WHERE id = ?').get(id);

  if (existing) {
    // Merge metadata and aliases
    const oldMeta = JSON.parse(existing.metadata || '{}');
    const oldAliases = JSON.parse(existing.aliases || '[]');
    const mergedMeta = { ...oldMeta, ...metadata };
    const mergedAliases = [...new Set([...oldAliases, ...aliases])];

    db.prepare('UPDATE entities SET metadata = ?, aliases = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(mergedMeta), JSON.stringify(mergedAliases), _now(), id);
  } else {
    db.prepare('INSERT INTO entities (id, type, name, aliases, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, type, name, JSON.stringify(aliases), JSON.stringify(metadata), _now(), _now());
  }

  return id;
}

function getEntity(id) {
  const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (entity) {
    entity.metadata = JSON.parse(entity.metadata || '{}');
    entity.aliases = JSON.parse(entity.aliases || '[]');
  }
  return entity;
}

function findEntity(nameOrAlias) {
  const search = nameOrAlias.toLowerCase();
  // Direct name match
  let entity = db.prepare('SELECT * FROM entities WHERE LOWER(name) = ?').get(search);
  if (!entity) {
    // Alias match
    entity = db.prepare("SELECT * FROM entities WHERE aliases LIKE ?").get(`%${search}%`);
  }
  if (!entity) {
    // Fuzzy ID match
    entity = db.prepare("SELECT * FROM entities WHERE id LIKE ?").get(`%${search.replace(/[^a-z0-9]/g, '_')}%`);
  }
  if (entity) {
    entity.metadata = JSON.parse(entity.metadata || '{}');
    entity.aliases = JSON.parse(entity.aliases || '[]');
  }
  return entity;
}

function findEntitiesByType(type) {
  const entities = db.prepare('SELECT * FROM entities WHERE type = ? ORDER BY updated_at DESC').all(type);
  return entities.map(e => ({
    ...e,
    metadata: JSON.parse(e.metadata || '{}'),
    aliases: JSON.parse(e.aliases || '[]'),
  }));
}

// ─── Relation CRUD ─────────────────────────────────────────────────────────────

function addRelation(sourceId, targetId, relation, metadata = {}, strength = 1.0) {
  // Check if relation already exists
  const existing = db.prepare(
    'SELECT id, strength FROM relations WHERE source_id = ? AND target_id = ? AND relation = ?'
  ).get(sourceId, targetId, relation);

  if (existing) {
    // Strengthen existing relation
    db.prepare('UPDATE relations SET strength = ?, metadata = ? WHERE id = ?')
      .run(Math.min(existing.strength + 0.1, 5.0), JSON.stringify(metadata), existing.id);
    return existing.id;
  }

  const result = db.prepare(
    'INSERT INTO relations (source_id, target_id, relation, metadata, strength, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sourceId, targetId, relation, JSON.stringify(metadata), strength, _now());
  return result.lastInsertRowid;
}

function getRelations(entityId, direction = 'both') {
  const results = [];

  if (direction === 'outgoing' || direction === 'both') {
    const outgoing = db.prepare(`
      SELECT r.*, e.name as target_name, e.type as target_type
      FROM relations r JOIN entities e ON r.target_id = e.id
      WHERE r.source_id = ? ORDER BY r.strength DESC
    `).all(entityId);
    results.push(...outgoing.map(r => ({ ...r, direction: 'outgoing', metadata: JSON.parse(r.metadata || '{}') })));
  }

  if (direction === 'incoming' || direction === 'both') {
    const incoming = db.prepare(`
      SELECT r.*, e.name as source_name, e.type as source_type
      FROM relations r JOIN entities e ON r.source_id = e.id
      WHERE r.target_id = ? ORDER BY r.strength DESC
    `).all(entityId);
    results.push(...incoming.map(r => ({ ...r, direction: 'incoming', metadata: JSON.parse(r.metadata || '{}') })));
  }

  return results;
}

// ─── Knowledge Notes ───────────────────────────────────────────────────────────

function addNote(entityId, content, source = null, tags = []) {
  const result = db.prepare(
    'INSERT INTO knowledge_notes (entity_id, content, source, tags, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(entityId, content, source, JSON.stringify(tags), _now());
  return result.lastInsertRowid;
}

function getNotes(entityId, limit = 10) {
  return db.prepare(
    'SELECT * FROM knowledge_notes WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(entityId, limit).map(n => ({ ...n, tags: JSON.parse(n.tags || '[]') }));
}

// ─── Knowledge Query (the "What do we know about X?" function) ────────────────

function queryEntity(nameOrType) {
  // Try to find as entity first
  let entity = findEntity(nameOrType);

  if (!entity) {
    // Maybe it's a type
    const entities = findEntitiesByType(nameOrType);
    if (entities.length > 0) {
      return {
        type: 'type_list',
        entityType: nameOrType,
        count: entities.length,
        entities: entities.map(e => ({
          id: e.id,
          name: e.name,
          relCount: db.prepare('SELECT COUNT(*) as c FROM relations WHERE source_id = ? OR target_id = ?').get(e.id, e.id).c,
        }))
      };
    }
    return null;
  }

  // Get all relations
  const relations = getRelations(entity.id);

  // Get notes
  const notes = getNotes(entity.id);

  // Group relations by type
  const grouped = {};
  for (const rel of relations) {
    const key = rel.relation;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(rel);
  }

  return {
    type: 'entity_detail',
    entity,
    relations: grouped,
    notes,
    totalRelations: relations.length,
  };
}

// ─── Auto-Linking Engine ───────────────────────────────────────────────────────
// Automatically extract entities from text and create/update links

const VILLA_NAMES = ['ANN', 'DIANE', 'KALA', 'LOUNA', 'NISSA', 'LYMA', 'LIAN', 'LYSA'];

function autoLink(text, context = {}) {
  const links = [];
  const upperText = text.toUpperCase();

  // 1. Detect villas
  for (const villa of VILLA_NAMES) {
    if (upperText.includes(villa)) {
      const villaId = upsertEntity(ENTITY_TYPES.VILLA, villa);
      links.push({ entityId: villaId, type: ENTITY_TYPES.VILLA, name: villa });
    }
  }

  // 2. Detect guest names (Mr/Mrs/Ms followed by name)
  const guestPattern = /(?:mr\.?|mrs\.?|ms\.?|guest|tamu)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi;
  let match;
  while ((match = guestPattern.exec(text)) !== null) {
    const guestName = match[1].trim();
    if (guestName.length > 2) {
      const guestId = upsertEntity(ENTITY_TYPES.GUEST, guestName);
      links.push({ entityId: guestId, type: ENTITY_TYPES.GUEST, name: guestName });
    }
  }

  // 3. Detect maintenance issues
  const issuePatterns = /(?:broken|rusak|bocor|leak|fix|repair|not working|mati|crack|damage)/gi;
  if (issuePatterns.test(text)) {
    const villaLinks = links.filter(l => l.type === ENTITY_TYPES.VILLA);
    for (const villa of villaLinks) {
      // Extract issue description
      const issueSummary = text.slice(0, 100).replace(/\[.*?\]/g, '').trim();
      const issueId = upsertEntity(ENTITY_TYPES.ISSUE, issueSummary, {
        villa: villa.name,
        reported: new Date().toISOString(),
        source: context.source || 'whatsapp',
      });
      addRelation(villa.entityId, issueId, RELATION_TYPES.HAS_ISSUE);
      links.push({ entityId: issueId, type: ENTITY_TYPES.ISSUE, name: issueSummary });
    }
  }

  // 4. Detect booking context
  if (/book|check.?in|check.?out|arrival|departure|pesan/i.test(text)) {
    const villaLinks = links.filter(l => l.type === ENTITY_TYPES.VILLA);
    const guestLinks = links.filter(l => l.type === ENTITY_TYPES.GUEST);

    for (const guest of guestLinks) {
      for (const villa of villaLinks) {
        addRelation(guest.entityId, villa.entityId, RELATION_TYPES.STAYED_AT, {
          context: text.slice(0, 200),
          date: new Date().toISOString(),
        });
      }
    }
  }

  // 5. Detect document references
  if (/contract|agreement|document|report|invoice|surat|kontrak/i.test(text)) {
    const villaLinks = links.filter(l => l.type === ENTITY_TYPES.VILLA);
    const docName = text.match(/(?:contract|agreement|document|report)\s+(?:for\s+)?(.+?)(?:\.|$)/i);
    if (docName) {
      const docId = upsertEntity(ENTITY_TYPES.DOCUMENT, docName[1].trim().slice(0, 80), {
        mentioned: new Date().toISOString(),
      });
      for (const villa of villaLinks) {
        addRelation(docId, villa.entityId, RELATION_TYPES.CONTRACTED);
      }
      links.push({ entityId: docId, type: ENTITY_TYPES.DOCUMENT, name: docName[1].trim() });
    }
  }

  // 6. Detect payments/amounts
  const amountPattern = /(?:Rp|IDR|USD|\$)\s*[\d,.]+/gi;
  if (amountPattern.test(text) && /pay|bayar|transfer|received/i.test(text)) {
    const guestLinks = links.filter(l => l.type === ENTITY_TYPES.GUEST);
    const villaLinks = links.filter(l => l.type === ENTITY_TYPES.VILLA);

    if (guestLinks.length > 0 || villaLinks.length > 0) {
      const paymentId = upsertEntity(ENTITY_TYPES.PAYMENT, `Payment ${new Date().toISOString().slice(0, 10)}`, {
        context: text.slice(0, 200),
      });
      for (const guest of guestLinks) {
        addRelation(paymentId, guest.entityId, RELATION_TYPES.PAID_BY);
      }
      for (const villa of villaLinks) {
        addRelation(paymentId, villa.entityId, RELATION_TYPES.RELATED_TO);
      }
    }
  }

  return links;
}

// ─── Build Context for System Prompt ──────────────────────────────────────────
// When a message mentions an entity, pull its knowledge graph context

function buildKnowledgeContext(message) {
  const parts = [];
  const upperMsg = message.toUpperCase().replace(/\[.*?\]/g, '');

  // Check for villa mentions
  for (const villa of VILLA_NAMES) {
    if (upperMsg.includes(villa)) {
      const result = queryEntity(villa);
      if (result && result.type === 'entity_detail') {
        let ctx = `Knowledge about ${villa}:`;
        const rels = result.relations;

        if (rels[RELATION_TYPES.HAS_ISSUE]) {
          const recentIssues = rels[RELATION_TYPES.HAS_ISSUE].slice(0, 3);
          ctx += ` Issues: ${recentIssues.map(r => r.target_name || r.source_name).join(', ')}.`;
        }
        if (rels[RELATION_TYPES.STAYED_AT]) {
          const guests = rels[RELATION_TYPES.STAYED_AT].slice(0, 3);
          ctx += ` Recent guests: ${guests.map(r => r.source_name || r.target_name).join(', ')}.`;
        }
        if (rels[RELATION_TYPES.CONTRACTED]) {
          const docs = rels[RELATION_TYPES.CONTRACTED].slice(0, 2);
          ctx += ` Documents: ${docs.map(r => r.source_name || r.target_name).join(', ')}.`;
        }

        const notes = result.notes.slice(0, 2);
        if (notes.length > 0) {
          ctx += ` Notes: ${notes.map(n => n.content.slice(0, 80)).join('; ')}.`;
        }

        parts.push(ctx);
      }
    }
  }

  // Check for guest mentions
  const guestPattern = /(?:mr\.?|mrs\.?|ms\.?|guest|tamu)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi;
  let match;
  while ((match = guestPattern.exec(message)) !== null) {
    const guestName = match[1].trim();
    const result = queryEntity(guestName);
    if (result && result.type === 'entity_detail') {
      let ctx = `Knowledge about ${guestName}:`;
      const rels = result.relations;
      if (rels[RELATION_TYPES.STAYED_AT]) {
        ctx += ` Stayed at: ${rels[RELATION_TYPES.STAYED_AT].map(r => r.target_name).join(', ')}.`;
      }
      if (rels[RELATION_TYPES.PAID_BY]) {
        ctx += ` Payments: ${rels[RELATION_TYPES.PAID_BY].length} recorded.`;
      }
      parts.push(ctx);
    }
  }

  return parts.length > 0 ? '\nKNOWLEDGE GRAPH:\n' + parts.join('\n') : '';
}

// ─── Stats ─────────────────────────────────────────────────────────────────────

function getStats() {
  const entities = db.prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type').all();
  const relations = db.prepare('SELECT COUNT(*) as count FROM relations').get();
  const notes = db.prepare('SELECT COUNT(*) as count FROM knowledge_notes').get();

  return {
    entities: entities.reduce((acc, e) => { acc[e.type] = e.count; return acc; }, {}),
    totalEntities: entities.reduce((sum, e) => sum + e.count, 0),
    totalRelations: relations.count,
    totalNotes: notes.count,
  };
}

// ─── Seed Initial Villas ───────────────────────────────────────────────────────
// Ensure all villas exist as entities
for (const villa of VILLA_NAMES) {
  upsertEntity(ENTITY_TYPES.VILLA, villa, { type: 'managed_villa' });
}

// ─── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  // Entity operations
  upsertEntity,
  getEntity,
  findEntity,
  findEntitiesByType,
  makeEntityId,

  // Relation operations
  addRelation,
  getRelations,

  // Knowledge notes
  addNote,
  getNotes,

  // Query
  queryEntity,

  // Auto-linking
  autoLink,

  // Context building
  buildKnowledgeContext,

  // Stats
  getStats,

  // Constants
  ENTITY_TYPES,
  RELATION_TYPES,
  VILLA_NAMES,
};
