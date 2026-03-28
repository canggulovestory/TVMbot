// memory-manager.js — Unified Memory System for TVMbot
// Inspired by crewAI's unified memory (relevance scoring, compaction, scoped recall)
// and AutoGPT's execution context (state tracking, audit trail)
//
// Architecture:
//   SHORT-TERM: In-memory conversation buffer per session (last N messages)
//   LONG-TERM:  SQLite-persisted memories with importance scoring + recency decay
//   ENTITY:     Extracted entities (guests, villas, dates, amounts) per conversation
//   COMPACTION:  Auto-summarize and flush when context exceeds token threshold
//
// Compatible with existing memory.js — this extends, not replaces.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'memory-manager.db');
const db = new Database(DB_PATH);

// ─── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    scope TEXT DEFAULT '/',
    categories TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    importance REAL DEFAULT 0.5,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_accessed TEXT DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS conversation_state (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    intent TEXT,
    active_task TEXT,
    entities TEXT DEFAULT '{}',
    last_actions TEXT DEFAULT '[]',
    message_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    last_compaction TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS execution_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    user_id TEXT,
    request TEXT,
    tools_called TEXT DEFAULT '[]',
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    tokens_cached INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    status TEXT DEFAULT 'completed',
    error TEXT,
    plan TEXT,
    result_summary TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS compaction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    messages_before INTEGER,
    messages_after INTEGER,
    tokens_before INTEGER,
    tokens_after INTEGER,
    summary TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope);
  CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_records(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_records(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_exec_session ON execution_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_exec_created ON execution_log(created_at DESC);
`);

// ─── Config (adapted from crewAI MemoryConfig) ────────────────────────────────
const CONFIG = {
  // Composite score weights (sum to ~1.0)
  recencyWeight: 0.3,
  semanticWeight: 0.0,   // No vector embeddings — use keyword matching instead
  importanceWeight: 0.7,
  recencyHalfLifeDays: 30,

  // Compaction thresholds (inspired by openclaw's 15K token flush)
  compactionTokenThreshold: 12000,  // Trigger compaction at ~12K tokens
  compactionTargetTokens: 3000,     // After compaction, keep ~3K tokens of summary
  maxShortTermMessages: 20,         // Max messages in short-term buffer

  // Memory limits
  maxRecallResults: 10,
  defaultImportance: 0.5,

  // Entity extraction patterns
  entityPatterns: {
    villa: /\b(villa\s+)?(ann|diane|kala|louna|nissa|lyma|lian|lysa|alysaa|lourinka|ocean\s*drive|industrial|uluwatu)\b/gi,
    guest: /(?:guest|tamu|mr\.?|mrs\.?|ms\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
    date: /\b(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?)\b/gi,
    amount: /\b(?:Rp|IDR|USD|\$|€)\s*[\d,.]+(?:\s*(?:juta|jt|rb|ribu|k|m|million))?\b/gi,
    phone: /(?:\+62|08)\d{8,12}/g,
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  }
};

// ─── Short-Term Memory (in-memory per session) ────────────────────────────────
const shortTermMemory = new Map(); // sessionId -> { messages: [], entities: {}, tokenCount: 0 }

function getShortTerm(sessionId) {
  if (!shortTermMemory.has(sessionId)) {
    shortTermMemory.set(sessionId, {
      messages: [],
      entities: { villas: [], guests: [], dates: [], amounts: [], phones: [], emails: [] },
      tokenCount: 0,
      messageCount: 0
    });
  }
  return shortTermMemory.get(sessionId);
}

function addToShortTerm(sessionId, role, content, tokenCount = 0) {
  const st = getShortTerm(sessionId);
  st.messages.push({
    role,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    timestamp: new Date().toISOString(),
    tokens: tokenCount
  });
  st.tokenCount += tokenCount;
  st.messageCount++;

  // Extract entities from user messages
  if (role === 'user' && typeof content === 'string') {
    extractEntities(content, st.entities);
  }

  // Trim if too many messages (keep most recent)
  while (st.messages.length > CONFIG.maxShortTermMessages) {
    const removed = st.messages.shift();
    st.tokenCount -= (removed.tokens || 0);
  }

  return st;
}

// ─── Entity Extraction (inspired by crewAI's memory analysis) ─────────────────
function extractEntities(text, entities) {
  const cleanText = text.replace(/\[WhatsApp.*?\]\s*/gi, '');

  // Extract villas
  let match;
  const villaRegex = new RegExp(CONFIG.entityPatterns.villa.source, 'gi');
  while ((match = villaRegex.exec(cleanText)) !== null) {
    const villa = match[0].replace(/^villa\s+/i, '').toUpperCase().trim();
    if (!entities.villas.includes(villa)) entities.villas.push(villa);
  }

  // Extract dates
  const dateRegex = new RegExp(CONFIG.entityPatterns.date.source, 'gi');
  while ((match = dateRegex.exec(cleanText)) !== null) {
    if (!entities.dates.includes(match[0])) entities.dates.push(match[0]);
  }

  // Extract amounts
  const amountRegex = new RegExp(CONFIG.entityPatterns.amount.source, 'gi');
  while ((match = amountRegex.exec(cleanText)) !== null) {
    if (!entities.amounts.includes(match[0])) entities.amounts.push(match[0]);
  }

  // Extract emails
  const emailRegex = new RegExp(CONFIG.entityPatterns.email.source, 'gi');
  while ((match = emailRegex.exec(cleanText)) !== null) {
    if (!entities.emails.includes(match[0])) entities.emails.push(match[0]);
  }

  // Extract phones
  const phoneRegex = new RegExp(CONFIG.entityPatterns.phone.source, 'gi');
  while ((match = phoneRegex.exec(cleanText)) !== null) {
    if (!entities.phones.includes(match[0])) entities.phones.push(match[0]);
  }

  return entities;
}

// ─── Relevance Scoring (adapted from crewAI compute_composite_score) ──────────
function computeRelevanceScore(record, queryKeywords = []) {
  const now = new Date();
  const createdAt = new Date(record.created_at);
  const ageDays = Math.max((now - createdAt) / 86400000, 0);

  // Recency decay: score halves every recencyHalfLifeDays
  const recencyDecay = Math.pow(0.5, ageDays / CONFIG.recencyHalfLifeDays);

  // Keyword match score (simplified semantic matching without embeddings)
  let keywordScore = 0;
  if (queryKeywords.length > 0) {
    const contentLower = record.content.toLowerCase();
    const matches = queryKeywords.filter(kw => contentLower.includes(kw.toLowerCase()));
    keywordScore = matches.length / queryKeywords.length;
  }

  // Composite score
  const composite =
    CONFIG.recencyWeight * recencyDecay +
    CONFIG.semanticWeight * keywordScore +
    CONFIG.importanceWeight * record.importance;

  const reasons = ['importance'];
  if (recencyDecay > 0.5) reasons.push('recency');
  if (keywordScore > 0.3) reasons.push('keyword_match');

  return { score: composite, reasons };
}

// ─── Long-Term Memory Operations ──────────────────────────────────────────────

function remember(content, options = {}) {
  const {
    scope = '/',
    categories = [],
    metadata = {},
    importance = CONFIG.defaultImportance,
    source = null
  } = options;

  const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    db.prepare(`
      INSERT INTO memory_records (id, content, scope, categories, metadata, importance, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      content,
      scope,
      JSON.stringify(categories),
      JSON.stringify(metadata),
      Math.min(Math.max(importance, 0), 1),
      source
    );
    console.log(`[MemoryManager] Saved: "${content.slice(0, 60)}..." [importance=${importance}, scope=${scope}]`);
    return id;
  } catch (err) {
    console.error('[MemoryManager] Save error:', err.message);
    return null;
  }
}

function recall(query, options = {}) {
  const {
    scope = null,
    categories = null,
    limit = CONFIG.maxRecallResults,
    source = null
  } = options;

  try {
    let sql = 'SELECT * FROM memory_records WHERE 1=1';
    const params = [];

    if (scope) {
      sql += ' AND scope LIKE ?';
      params.push(scope + '%');
    }
    if (source) {
      sql += ' AND (source = ? OR source IS NULL)';
      params.push(source);
    }

    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(limit * 3); // Oversample for post-scoring (crewAI pattern)

    const records = db.prepare(sql).all(...params);

    // Extract keywords from query for scoring
    const queryKeywords = query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Score and rank
    const scored = records.map(r => {
      const { score, reasons } = computeRelevanceScore(r, queryKeywords);
      return { record: r, score, reasons };
    });

    // Sort by composite score
    scored.sort((a, b) => b.score - a.score);

    // Take top results
    const results = scored.slice(0, limit);

    // Update last_accessed for recalled records
    const updateStmt = db.prepare('UPDATE memory_records SET last_accessed = datetime("now"), access_count = access_count + 1 WHERE id = ?');
    for (const r of results) {
      updateStmt.run(r.record.id);
    }

    return results;
  } catch (err) {
    if (!err.message.includes('no such table')) console.error('[MemoryManager] Recall error:', err.message);
    return [];
  }
}

function forget(options = {}) {
  const { scope = null, olderThanDays = null, recordIds = null } = options;

  let sql = 'DELETE FROM memory_records WHERE 1=1';
  const params = [];

  if (scope) {
    sql += ' AND scope LIKE ?';
    params.push(scope + '%');
  }
  if (olderThanDays) {
    sql += ' AND created_at < datetime("now", ?)';
    params.push(`-${olderThanDays} days`);
  }
  if (recordIds && recordIds.length > 0) {
    sql += ` AND id IN (${recordIds.map(() => '?').join(',')})`;
    params.push(...recordIds);
  }

  const result = db.prepare(sql).run(...params);
  console.log(`[MemoryManager] Forgot ${result.changes} records`);
  return result.changes;
}

// ─── Conversation State Management ────────────────────────────────────────────

function getConversationState(sessionId) {
  const row = db.prepare('SELECT * FROM conversation_state WHERE session_id = ?').get(sessionId);
  if (row) {
    return {
      ...row,
      entities: JSON.parse(row.entities || '{}'),
      last_actions: JSON.parse(row.last_actions || '[]')
    };
  }
  return null;
}

function updateConversationState(sessionId, updates) {
  const existing = getConversationState(sessionId);

  if (existing) {
    const fields = [];
    const params = [];

    if (updates.intent !== undefined) { fields.push('intent = ?'); params.push(updates.intent); }
    if (updates.active_task !== undefined) { fields.push('active_task = ?'); params.push(updates.active_task); }
    if (updates.entities !== undefined) { fields.push('entities = ?'); params.push(JSON.stringify(updates.entities)); }
    if (updates.last_actions !== undefined) { fields.push('last_actions = ?'); params.push(JSON.stringify(updates.last_actions)); }
    if (updates.message_count !== undefined) { fields.push('message_count = ?'); params.push(updates.message_count); }
    if (updates.total_tokens !== undefined) { fields.push('total_tokens = ?'); params.push(updates.total_tokens); }
    if (updates.last_compaction !== undefined) { fields.push('last_compaction = ?'); params.push(updates.last_compaction); }

    fields.push('updated_at = datetime("now")');

    if (fields.length > 1) {
      db.prepare(`UPDATE conversation_state SET ${fields.join(', ')} WHERE session_id = ?`)
        .run(...params, sessionId);
    }
  } else {
    db.prepare(`
      INSERT INTO conversation_state (session_id, user_id, intent, active_task, entities, last_actions, message_count, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      updates.user_id || null,
      updates.intent || null,
      updates.active_task || null,
      JSON.stringify(updates.entities || {}),
      JSON.stringify(updates.last_actions || []),
      updates.message_count || 0,
      updates.total_tokens || 0
    );
  }
}

// ─── Compaction (inspired by openclaw's 15K token flush + crewAI consolidation) ─

function needsCompaction(sessionId) {
  const st = getShortTerm(sessionId);
  return st.tokenCount >= CONFIG.compactionTokenThreshold;
}

function compactConversation(sessionId, claudeClient = null) {
  const st = getShortTerm(sessionId);

  if (st.messages.length < 4) return null; // Not enough to compact

  const tokensBefore = st.tokenCount;
  const messagesBefore = st.messages.length;

  // Build summary from conversation
  // If no Claude client, do rule-based compaction
  let summary;

  // Keep only the last 4 messages as-is
  const keepMessages = st.messages.slice(-4);
  const compactMessages = st.messages.slice(0, -4);

  // Rule-based summary (no API call needed)
  const userMessages = compactMessages
    .filter(m => m.role === 'user')
    .map(m => m.content.slice(0, 200));
  const assistantSummaries = compactMessages
    .filter(m => m.role === 'assistant')
    .map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return content.slice(0, 150);
    });

  summary = `[Conversation Summary]\n`;
  summary += `Topics discussed: ${userMessages.join('; ').slice(0, 500)}\n`;
  if (st.entities.villas.length) summary += `Villas mentioned: ${st.entities.villas.join(', ')}\n`;
  if (st.entities.guests.length) summary += `Guests mentioned: ${st.entities.guests.join(', ')}\n`;
  if (st.entities.dates.length) summary += `Dates mentioned: ${st.entities.dates.join(', ')}\n`;
  if (st.entities.amounts.length) summary += `Amounts mentioned: ${st.entities.amounts.join(', ')}\n`;
  summary += `Key responses: ${assistantSummaries.join('; ').slice(0, 500)}`;

  // Replace short-term buffer with summary + recent messages
  st.messages = [
    { role: 'system', content: summary, timestamp: new Date().toISOString(), tokens: Math.ceil(summary.length / 4) },
    ...keepMessages
  ];

  // Recalculate token count
  st.tokenCount = st.messages.reduce((sum, m) => sum + (m.tokens || Math.ceil((typeof m.content === 'string' ? m.content.length : 100) / 4)), 0);

  // Save compaction to long-term memory
  remember(summary, {
    scope: `/sessions/${sessionId}`,
    categories: ['compaction', 'conversation_summary'],
    importance: 0.6,
    source: sessionId
  });

  // Log compaction
  db.prepare(`
    INSERT INTO compaction_history (session_id, messages_before, messages_after, tokens_before, tokens_after, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, messagesBefore, st.messages.length, tokensBefore, st.tokenCount, summary.slice(0, 2000));

  // Update conversation state
  updateConversationState(sessionId, {
    last_compaction: new Date().toISOString(),
    total_tokens: st.tokenCount,
    message_count: st.messageCount
  });

  console.log(`[MemoryManager] Compacted session ${sessionId}: ${messagesBefore} msgs → ${st.messages.length} msgs, ${tokensBefore} → ${st.tokenCount} tokens`);

  return {
    messagesBefore,
    messagesAfter: st.messages.length,
    tokensBefore,
    tokensAfter: st.tokenCount,
    summary: summary.slice(0, 200)
  };
}

// ─── Execution Logger (adapted from AutoGPT ExecutionContext + audit) ──────────

function logExecution(data) {
  try {
    db.prepare(`
      INSERT INTO execution_log (session_id, user_id, request, tools_called, tokens_in, tokens_out, tokens_cached, duration_ms, status, error, plan, result_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.sessionId || null,
      data.userId || null,
      (data.request || '').slice(0, 1000),
      JSON.stringify(data.toolsCalled || []),
      data.tokensIn || 0,
      data.tokensOut || 0,
      data.tokensCached || 0,
      data.durationMs || 0,
      data.status || 'completed',
      data.error || null,
      data.plan ? JSON.stringify(data.plan).slice(0, 2000) : null,
      (data.resultSummary || '').slice(0, 1000)
    );
  } catch (err) {
    console.error('[MemoryManager] Log execution error:', err.message);
  }
}

function getExecutionHistory(sessionId, limit = 10) {
  return db.prepare(`
    SELECT * FROM execution_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, limit);
}

function getExecutionStats(dateRange = 'today') {
  // Compute cutoff date in JS and pass as plain YYYY-MM-DD string
  const now = new Date();
  let cutoffDate;
  switch (dateRange) {
    case 'week': {
      const d = new Date(now); d.setDate(d.getDate() - 7);
      cutoffDate = d.toISOString().split('T')[0];
      break;
    }
    case 'month': {
      const d = new Date(now); d.setDate(d.getDate() - 30);
      cutoffDate = d.toISOString().split('T')[0];
      break;
    }
    default:
      cutoffDate = now.toISOString().split('T')[0];
  }

  return db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(tokens_in) as total_tokens_in,
      SUM(tokens_out) as total_tokens_out,
      SUM(tokens_cached) as total_tokens_cached,
      AVG(duration_ms) as avg_duration_ms,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      COUNT(DISTINCT session_id) as unique_sessions
    FROM execution_log
    WHERE date(created_at) >= ?
  `).get(cutoffDate);
}

// ─── Intent Classification (lightweight, no API call) ─────────────────────────

function classifyIntent(message) {
  const msg = message.replace(/\[WhatsApp.*?\]\s*/gi, '').toLowerCase();

  const intents = [
    { intent: 'booking_check', patterns: [/available|availability|free|occupied|book|check-in|check-out|tamu/] },
    { intent: 'booking_create', patterns: [/book|reserve|create.*booking|new.*booking|pesan/] },
    { intent: 'booking_modify', patterns: [/reschedule|extend|change.*date|move.*booking/] },
    { intent: 'booking_cancel', patterns: [/cancel.*booking|cancel.*reservation/] },
    { intent: 'maintenance_report', patterns: [/broken|rusak|bocor|leak|fix|repair|not working|mati/] },
    { intent: 'maintenance_check', patterns: [/pending.*task|maintenance.*status|what.*need.*fix/] },
    { intent: 'finance_payment', patterns: [/log.*payment|record.*payment|bayar|received.*payment/] },
    { intent: 'finance_expense', patterns: [/log.*expense|record.*expense|spent|biaya/] },
    { intent: 'finance_report', patterns: [/revenue|income|expense.*report|financial|how much|berapa/] },
    { intent: 'finance_outstanding', patterns: [/outstanding|unpaid|overdue|belum.*bayar/] },
    { intent: 'calendar_check', patterns: [/schedule|calendar|event|jadwal|what.*today|this week/] },
    { intent: 'email_read', patterns: [/check.*email|read.*email|inbox|unread/] },
    { intent: 'email_send', patterns: [/send.*email|email.*to|kirim.*email/] },
    { intent: 'general_question', patterns: [/what is|who is|how do|explain|tell me/] },
    { intent: 'greeting', patterns: [/^(hi|hello|hey|good morning|selamat|thanks|ok)\b/] },
    { intent: 'help', patterns: [/help|what can you|how to use/] },
  ];

  for (const { intent, patterns } of intents) {
    if (patterns.some(p => p.test(msg))) return intent;
  }

  return 'unknown';
}

// ─── Build Context for System Prompt ──────────────────────────────────────────

function buildMemoryContext(sessionId, userMessage) {
  const parts = [];

  // 1. Conversation state
  const state = getConversationState(sessionId);
  if (state && state.intent) {
    parts.push(`Current conversation intent: ${state.intent}`);
    if (state.active_task) parts.push(`Active task: ${state.active_task}`);
  }

  // 2. Entity context from short-term
  const st = getShortTerm(sessionId);
  if (st.entities.villas.length || st.entities.guests.length || st.entities.dates.length) {
    let entityCtx = 'Context from this conversation:';
    if (st.entities.villas.length) entityCtx += ` Villas: ${st.entities.villas.join(', ')}.`;
    if (st.entities.guests.length) entityCtx += ` Guests: ${st.entities.guests.join(', ')}.`;
    if (st.entities.dates.length) entityCtx += ` Dates: ${st.entities.dates.join(', ')}.`;
    if (st.entities.amounts.length) entityCtx += ` Amounts: ${st.entities.amounts.join(', ')}.`;
    parts.push(entityCtx);
  }

  // 3. Recent execution history (last 3 actions)
  const recentExecs = getExecutionHistory(sessionId, 3);
  if (recentExecs.length > 0) {
    const actions = recentExecs.map(e => {
      const tools = JSON.parse(e.tools_called || '[]');
      return tools.length > 0 ? tools.join(', ') : 'direct response';
    });
    parts.push(`Recent actions in this session: ${actions.join(' → ')}`);
  }

  // 4. Relevant long-term memories
  const recalled = recall(userMessage, { limit: 5, source: sessionId });
  if (recalled.length > 0) {
    const memories = recalled
      .filter(r => r.score > 0.3)
      .map(r => `- ${r.record.content.slice(0, 200)}`)
      .slice(0, 3);
    if (memories.length > 0) {
      parts.push(`Relevant memories:\n${memories.join('\n')}`);
    }
  }

  // 5. Proactive monitor issues (cross-system awareness)
  try {
    const monitor = global.__tvmbot_monitor;
    if (monitor && monitor.lastScanResults && monitor.lastScanResults.length > 0) {
      const summary = monitor.getIssuesSummary();
      if (summary) parts.push(summary);
    }
  } catch(e) { /* monitor not loaded yet */ }

  return parts.length > 0 ? '\n\nSESSION CONTEXT:\n' + parts.join('\n') : '';
}

// ─── Cleanup old data ─────────────────────────────────────────────────────────

function cleanup() {
  // Clean up execution logs older than 30 days
  const execResult = db.prepare("DELETE FROM execution_log WHERE created_at < datetime('now', '-30 days')").run();

  // Clean up low-importance memories older than 90 days
  const memResult = db.prepare("DELETE FROM memory_records WHERE importance < 0.3 AND created_at < datetime('now', '-90 days')").run();

  // Clean up stale short-term memory (sessions older than 3 hours)
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  for (const [sessionId, st] of shortTermMemory) {
    const lastMsg = st.messages[st.messages.length - 1];
    if (lastMsg && new Date(lastMsg.timestamp).getTime() < threeHoursAgo) {
      shortTermMemory.delete(sessionId);
    }
  }

  if (execResult.changes || memResult.changes) {
    console.log(`[MemoryManager] Cleanup: ${execResult.changes} exec logs, ${memResult.changes} old memories removed`);
  }
}

// Run cleanup every hour
setInterval(cleanup, 60 * 60 * 1000);

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  // Short-term
  getShortTerm,
  addToShortTerm,
  extractEntities,

  // Long-term
  remember,
  recall,
  forget,

  // Conversation state
  getConversationState,
  updateConversationState,
  classifyIntent,

  // Compaction
  needsCompaction,
  compactConversation,

  // Execution logging
  logExecution,
  getExecutionHistory,
  getExecutionStats,

  // Context building
  buildMemoryContext,

  // Relevance scoring
  computeRelevanceScore,

  // Config
  CONFIG,

  // Cleanup
  cleanup
};
