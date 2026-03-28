// TVMbot Session Manager
// Inspired by Ruflo's "Session Persist/Restore/Export" pattern
// Manages WhatsApp conversation sessions with persistence

var Database = require('better-sqlite3');
var path = require('path');

var DATA_DIR = path.join(__dirname, 'data');
var SESSION_TIMEOUT = 3 * 60 * 60 * 1000; // 3 hours in milliseconds

var SessionManager = function() {
  this.db = null;
  this.activeSessions = {}; // In-memory cache of active sessions
};

SessionManager.prototype.init = function() {
  try {
    var dbPath = path.join(DATA_DIR, 'sessions.db');
    this.db = new Database(dbPath);

    // Create sessions table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        entities TEXT,
        intent_history TEXT,
        tools_used TEXT,
        token_count INTEGER DEFAULT 0,
        language TEXT DEFAULT 'en',
        satisfaction_score INTEGER,
        archived INTEGER DEFAULT 0
      )
    `);

    // Create session_messages table for conversation history
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_type TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      )
    `);

    this.db.pragma('journal_mode = WAL');
    this._loadActiveSessions();
    console.log('[Sessions] Initialized with ' + Object.keys(this.activeSessions).length + ' active sessions');
    return true;
  } catch (err) {
    console.error('[Sessions] Init failed:', err.message);
    return false;
  }
};

SessionManager.prototype._loadActiveSessions = function() {
  try {
    var stmt = this.db.prepare(`
      SELECT session_id, user_id, start_time, last_activity, message_count,
             entities, intent_history, tools_used, token_count, language, satisfaction_score
      FROM sessions
      WHERE archived = 0
    `);

    var rows = stmt.all();
    this.activeSessions = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      this.activeSessions[row.session_id] = {
        sessionId: row.session_id,
        userId: row.user_id,
        startTime: new Date(row.start_time),
        lastActivity: new Date(row.last_activity),
        messageCount: row.message_count,
        entities: row.entities ? JSON.parse(row.entities) : {},
        intentHistory: row.intent_history ? JSON.parse(row.intent_history) : [],
        toolsUsed: row.tools_used ? JSON.parse(row.tools_used) : [],
        tokenCount: row.token_count,
        language: row.language || 'en',
        satisfactionScore: row.satisfaction_score
      };
    }
  } catch (err) {
    console.error('[Sessions] Failed to load active sessions:', err.message);
  }
};

SessionManager.prototype.getOrCreate = function(sessionId, userId) {
  try {
    // Check if session exists in memory
    if (this.activeSessions[sessionId]) {
      return this.activeSessions[sessionId];
    }

    // Try to restore from database
    var stmt = this.db.prepare(`
      SELECT session_id, user_id, start_time, last_activity, message_count,
             entities, intent_history, tools_used, token_count, language, satisfaction_score
      FROM sessions
      WHERE session_id = ? AND archived = 0
    `);

    var row = stmt.get(sessionId);
    if (row) {
      var session = {
        sessionId: row.session_id,
        userId: row.user_id,
        startTime: new Date(row.start_time),
        lastActivity: new Date(row.last_activity),
        messageCount: row.message_count,
        entities: row.entities ? JSON.parse(row.entities) : {},
        intentHistory: row.intent_history ? JSON.parse(row.intent_history) : [],
        toolsUsed: row.tools_used ? JSON.parse(row.tools_used) : [],
        tokenCount: row.token_count,
        language: row.language || 'en',
        satisfactionScore: row.satisfaction_score
      };
      this.activeSessions[sessionId] = session;
      return session;
    }

    // Create new session
    var newSession = {
      sessionId: sessionId,
      userId: userId,
      startTime: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
      entities: {},
      intentHistory: [],
      toolsUsed: [],
      tokenCount: 0,
      language: 'en',
      satisfactionScore: null
    };

    this.activeSessions[sessionId] = newSession;
    this.persist(sessionId);

    console.log('[Sessions] Created new session:', sessionId);
    return newSession;
  } catch (err) {
    console.error('[Sessions] Error in getOrCreate:', err.message);
    return null;
  }
};

SessionManager.prototype.update = function(sessionId, data) {
  try {
    var session = this.activeSessions[sessionId];
    if (!session) {
      console.error('[Sessions] Session not found:', sessionId);
      return false;
    }

    // Update session fields
    if (data.messageCount !== undefined) {
      session.messageCount = data.messageCount;
    }
    if (data.language !== undefined) {
      session.language = data.language;
    }
    if (data.tokenCount !== undefined) {
      session.tokenCount = data.tokenCount;
    }
    if (data.satisfactionScore !== undefined) {
      session.satisfactionScore = data.satisfactionScore;
    }

    session.lastActivity = new Date();

    this.persist(sessionId);
    return true;
  } catch (err) {
    console.error('[Sessions] Error updating session:', err.message);
    return false;
  }
};

SessionManager.prototype.persist = function(sessionId) {
  try {
    var session = this.activeSessions[sessionId];
    if (!session) {
      console.error('[Sessions] Cannot persist: session not found:', sessionId);
      return false;
    }

    var entitiesJson = JSON.stringify(session.entities);
    var intentHistoryJson = JSON.stringify(session.intentHistory);
    var toolsUsedJson = JSON.stringify(session.toolsUsed);

    var stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
      (session_id, user_id, start_time, last_activity, message_count, entities, intent_history, tools_used, token_count, language, satisfaction_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.sessionId,
      session.userId,
      session.startTime.toISOString(),
      session.lastActivity.toISOString(),
      session.messageCount,
      entitiesJson,
      intentHistoryJson,
      toolsUsedJson,
      session.tokenCount,
      session.language,
      session.satisfactionScore
    );

    return true;
  } catch (err) {
    console.error('[Sessions] Error persisting session:', err.message);
    return false;
  }
};

SessionManager.prototype.restore = function(sessionId) {
  try {
    var stmt = this.db.prepare(`
      SELECT session_id, user_id, start_time, last_activity, message_count,
             entities, intent_history, tools_used, token_count, language, satisfaction_score
      FROM sessions
      WHERE session_id = ?
    `);

    var row = stmt.get(sessionId);
    if (!row) {
      console.log('[Sessions] Session not found in database:', sessionId);
      return null;
    }

    var session = {
      sessionId: row.session_id,
      userId: row.user_id,
      startTime: new Date(row.start_time),
      lastActivity: new Date(row.last_activity),
      messageCount: row.message_count,
      entities: row.entities ? JSON.parse(row.entities) : {},
      intentHistory: row.intent_history ? JSON.parse(row.intent_history) : [],
      toolsUsed: row.tools_used ? JSON.parse(row.tools_used) : [],
      tokenCount: row.token_count,
      language: row.language || 'en',
      satisfactionScore: row.satisfaction_score
    };

    return session;
  } catch (err) {
    console.error('[Sessions] Error restoring session:', err.message);
    return null;
  }
};

SessionManager.prototype.export = function(sessionId, format) {
  try {
    var session = this.activeSessions[sessionId];
    if (!session) {
      session = this.restore(sessionId);
    }

    if (!session) {
      console.error('[Sessions] Cannot export: session not found:', sessionId);
      return null;
    }

    var duration = Date.now() - session.startTime.getTime();
    var durationMinutes = Math.round(duration / 60000);

    if (format === 'json') {
      return {
        sessionId: session.sessionId,
        userId: session.userId,
        startTime: session.startTime.toISOString(),
        lastActivity: session.lastActivity.toISOString(),
        durationMinutes: durationMinutes,
        messageCount: session.messageCount,
        entities: session.entities,
        intentHistory: session.intentHistory,
        toolsUsed: session.toolsUsed,
        tokenCount: session.tokenCount,
        language: session.language,
        satisfactionScore: session.satisfactionScore
      };
    } else if (format === 'summary' || !format) {
      var summary = '';
      summary += 'Session: ' + session.sessionId + '\n';
      summary += 'User: ' + session.userId + '\n';
      summary += 'Duration: ' + durationMinutes + ' minutes\n';
      summary += 'Messages: ' + session.messageCount + '\n';
      summary += 'Language: ' + session.language + '\n';

      if (Object.keys(session.entities).length > 0) {
        summary += 'Entities mentioned: ' + Object.keys(session.entities).join(', ') + '\n';
      }

      if (session.toolsUsed.length > 0) {
        summary += 'Tools used: ' + session.toolsUsed.join(', ') + '\n';
      }

      if (session.intentHistory.length > 0) {
        summary += 'Intents: ' + session.intentHistory.join(', ') + '\n';
      }

      if (session.satisfactionScore !== null && session.satisfactionScore !== undefined) {
        summary += 'Satisfaction: ' + session.satisfactionScore + '/5\n';
      }

      return summary;
    } else {
      console.error('[Sessions] Unknown export format:', format);
      return null;
    }
  } catch (err) {
    console.error('[Sessions] Error exporting session:', err.message);
    return null;
  }
};

SessionManager.prototype.getActiveSessions = function() {
  try {
    var now = Date.now();
    var activeSessions = [];

    for (var sessionId in this.activeSessions) {
      var session = this.activeSessions[sessionId];
      var timeSinceActivity = now - session.lastActivity.getTime();

      if (timeSinceActivity < SESSION_TIMEOUT) {
        activeSessions.push(session);
      }
    }

    return activeSessions;
  } catch (err) {
    console.error('[Sessions] Error getting active sessions:', err.message);
    return [];
  }
};

SessionManager.prototype.cleanup = function(maxAgeHours) {
  try {
    if (maxAgeHours === undefined) {
      maxAgeHours = 24;
    }

    var maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    var now = Date.now();
    var archivedCount = 0;

    for (var sessionId in this.activeSessions) {
      var session = this.activeSessions[sessionId];
      var age = now - session.startTime.getTime();

      if (age > maxAgeMs) {
        // Archive the session
        try {
          var stmt = this.db.prepare('UPDATE sessions SET archived = 1 WHERE session_id = ?');
          stmt.run(sessionId);
          delete this.activeSessions[sessionId];
          archivedCount++;
        } catch (err) {
          console.error('[Sessions] Error archiving session:', err.message);
        }
      }
    }

    console.log('[Sessions] Archived ' + archivedCount + ' old sessions');
    return archivedCount;
  } catch (err) {
    console.error('[Sessions] Error during cleanup:', err.message);
    return 0;
  }
};

SessionManager.prototype.getSessionContext = function(sessionId) {
  try {
    var session = this.activeSessions[sessionId];
    if (!session) {
      session = this.restore(sessionId);
    }

    if (!session) {
      return '';
    }

    var context = 'Session context:\n';
    context += 'User: ' + session.userId + '\n';
    context += 'Language: ' + session.language + '\n';
    context += 'Messages in session: ' + session.messageCount + '\n';

    if (Object.keys(session.entities).length > 0) {
      context += 'Extracted entities: ' + JSON.stringify(session.entities) + '\n';
    }

    if (session.intentHistory.length > 0) {
      context += 'Recent intents: ' + session.intentHistory.slice(-3).join(', ') + '\n';
    }

    if (session.toolsUsed.length > 0) {
      context += 'Tools used: ' + session.toolsUsed.join(', ') + '\n';
    }

    return context;
  } catch (err) {
    console.error('[Sessions] Error getting session context:', err.message);
    return '';
  }
};

SessionManager.prototype.trackEntity = function(sessionId, type, value) {
  try {
    var session = this.activeSessions[sessionId];
    if (!session) {
      console.error('[Sessions] Session not found:', sessionId);
      return false;
    }

    if (!session.entities[type]) {
      session.entities[type] = [];
    }

    if (session.entities[type].indexOf(value) === -1) {
      session.entities[type].push(value);
    }

    this.persist(sessionId);
    return true;
  } catch (err) {
    console.error('[Sessions] Error tracking entity:', err.message);
    return false;
  }
};

SessionManager.prototype.trackTool = function(sessionId, toolName) {
  try {
    var session = this.activeSessions[sessionId];
    if (!session) {
      console.error('[Sessions] Session not found:', sessionId);
      return false;
    }

    if (session.toolsUsed.indexOf(toolName) === -1) {
      session.toolsUsed.push(toolName);
    }

    this.persist(sessionId);
    return true;
  } catch (err) {
    console.error('[Sessions] Error tracking tool:', err.message);
    return false;
  }
};

SessionManager.prototype.trackIntent = function(sessionId, intent) {
  try {
    var session = this.activeSessions[sessionId];
    if (!session) {
      console.error('[Sessions] Session not found:', sessionId);
      return false;
    }

    session.intentHistory.push(intent);

    // Keep only last 20 intents to avoid unbounded growth
    if (session.intentHistory.length > 20) {
      session.intentHistory = session.intentHistory.slice(-20);
    }

    this.persist(sessionId);
    return true;
  } catch (err) {
    console.error('[Sessions] Error tracking intent:', err.message);
    return false;
  }
};

SessionManager.prototype.close = function() {
  try {
    if (this.db) {
      this.db.close();
      console.log('[Sessions] Database closed');
    }
    return true;
  } catch (err) {
    console.error('[Sessions] Error closing database:', err.message);
    return false;
  }
};

// Singleton pattern
var instance = null;

var getSessionManager = function() {
  if (!instance) {
    instance = new SessionManager();
    instance.init();
  }
  return instance;
};

module.exports = getSessionManager;
module.exports.SessionManager = SessionManager;
module.exports.getSessionManager = getSessionManager;
