'use strict';
/**
 * SQLiteStore — express-session store backed by better-sqlite3
 * Survives PM2 restarts. Sessions persist in /root/claude-chatbot/data/sessions.db
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

module.exports = function(session) {
  const Store = session.Store;

  class SQLiteStore extends Store {
    constructor(options = {}) {
      super(options);
      const dir = options.dir || path.join(__dirname, 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const dbPath = options.db || path.join(dir, 'sessions.db');
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 3000');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expired INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
      `);
      this._get = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
      this._set = this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
      this._destroy = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
      this._cleanup = this.db.prepare('DELETE FROM sessions WHERE expired <= ?');
      this._all = this.db.prepare('SELECT sid, sess FROM sessions WHERE expired > ?');
      this._length = this.db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE expired > ?');

      // Cleanup expired sessions every 15 minutes
      this._cleanupInterval = setInterval(() => {
        try { this._cleanup.run(Date.now()); } catch(e) {}
      }, 15 * 60 * 1000);
      // Initial cleanup
      try { this._cleanup.run(Date.now()); } catch(e) {}
      console.log('[SessionStore] SQLite store ready:', dbPath);
    }

    get(sid, cb) {
      try {
        const row = this._get.get(sid, Date.now());
        if (!row) return cb(null, null);
        cb(null, JSON.parse(row.sess));
      } catch(e) { cb(e); }
    }

    set(sid, sess, cb) {
      try {
        const maxAge = (sess.cookie && sess.cookie.maxAge) ? sess.cookie.maxAge : 86400000;
        const expired = Date.now() + maxAge;
        this._set.run(sid, JSON.stringify(sess), expired);
        if (cb) cb(null);
      } catch(e) { if (cb) cb(e); }
    }

    destroy(sid, cb) {
      try {
        this._destroy.run(sid);
        if (cb) cb(null);
      } catch(e) { if (cb) cb(e); }
    }

    all(cb) {
      try {
        const rows = this._all.all(Date.now());
        const sessions = {};
        for (const r of rows) sessions[r.sid] = JSON.parse(r.sess);
        cb(null, sessions);
      } catch(e) { cb(e); }
    }

    length(cb) {
      try {
        const row = this._length.get(Date.now());
        cb(null, row ? row.cnt : 0);
      } catch(e) { cb(e); }
    }

    clear(cb) {
      try {
        this.db.exec('DELETE FROM sessions');
        if (cb) cb(null);
      } catch(e) { if (cb) cb(e); }
    }

    touch(sid, sess, cb) {
      // Update expiry without changing session data
      this.set(sid, sess, cb);
    }

    close() {
      clearInterval(this._cleanupInterval);
      this.db.close();
    }
  }

  return SQLiteStore;
};
