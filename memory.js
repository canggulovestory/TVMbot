// memory.js — Long-Term Business Memory Layer for TVMbot PEMS Architecture
// Stores: villa details, owner preferences, guest history, contracts, decisions, facts

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'memory.db');
const db = new Database(DB_PATH);

// ─── Schema Setup ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS business_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    source TEXT DEFAULT 'system',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS owner_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS villas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT,
    bedrooms INTEGER,
    max_guests INTEGER,
    base_price REAL,
    cleaning_fee REAL,
    amenities TEXT,
    drive_folder_id TEXT,
    sheets_id TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT,
    nationality TEXT,
    passport_file_id TEXT,
    booking_count INTEGER DEFAULT 0,
    total_revenue REAL DEFAULT 0,
    notes TEXT,
    last_stay TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_name TEXT NOT NULL,
    guest_email TEXT,
    villa_name TEXT NOT NULL,
    check_in TEXT NOT NULL,
    check_out TEXT NOT NULL,
    price REAL,
    status TEXT DEFAULT 'pending',
    contract_doc_id TEXT,
    calendar_event_id TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    user_message TEXT,
    plan_used TEXT,
    tools_called TEXT,
    outcome TEXT,
    supervisor_notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contract_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    template TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Business Facts ────────────────────────────────────────────────────────────
function setFact(category, key, value, source = 'system') {
  const stmt = db.prepare(`
    INSERT INTO business_facts (category, key, value, source, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at
  `);
  stmt.run(category, key, String(value), source);
}

function getFact(key) {
  const row = db.prepare('SELECT value FROM business_facts WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getFactsByCategory(category) {
  return db.prepare('SELECT key, value, source, updated_at FROM business_facts WHERE category = ?').all(category);
}

function getAllFacts() {
  return db.prepare('SELECT * FROM business_facts ORDER BY category, key').all();
}

// ─── Owner Profile ─────────────────────────────────────────────────────────────
function setOwnerField(field, value) {
  const stmt = db.prepare(`
    INSERT INTO owner_profile (field, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(field) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `);
  stmt.run(field, String(value));
}

function getOwnerProfile() {
  const rows = db.prepare('SELECT field, value FROM owner_profile').all();
  const profile = {};
  for (const row of rows) profile[row.field] = row.value;
  return profile;
}

function saveOwnerProfileBulk(profileObj) {
  const stmt = db.prepare(`
    INSERT INTO owner_profile (field, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(field) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `);
  const insertMany = db.transaction((obj) => {
    for (const [field, value] of Object.entries(obj)) {
      if (value !== undefined && value !== null) stmt.run(field, String(value));
    }
  });
  insertMany(profileObj);
}

// ─── Villas ────────────────────────────────────────────────────────────────────
function upsertVilla(data) {
  const stmt = db.prepare(`
    INSERT INTO villas (name, location, bedrooms, max_guests, base_price, cleaning_fee, amenities, drive_folder_id, sheets_id, notes, updated_at)
    VALUES (@name, @location, @bedrooms, @max_guests, @base_price, @cleaning_fee, @amenities, @drive_folder_id, @sheets_id, @notes, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      location=excluded.location, bedrooms=excluded.bedrooms, max_guests=excluded.max_guests,
      base_price=excluded.base_price, cleaning_fee=excluded.cleaning_fee,
      amenities=excluded.amenities, drive_folder_id=excluded.drive_folder_id,
      sheets_id=excluded.sheets_id, notes=excluded.notes, updated_at=excluded.updated_at
  `);
  stmt.run(data);
}

function getVilla(name) {
  return db.prepare('SELECT * FROM villas WHERE name = ?').get(name);
}

function getAllVillas() {
  return db.prepare('SELECT * FROM villas ORDER BY name').all();
}

// ─── Guests ────────────────────────────────────────────────────────────────────
function upsertGuest(data) {
  const stmt = db.prepare(`
    INSERT INTO guests (name, email, phone, nationality, passport_file_id, notes, updated_at)
    VALUES (@name, @email, @phone, @nationality, @passport_file_id, @notes, datetime('now'))
    ON CONFLICT(email) DO UPDATE SET
      name=excluded.name, phone=excluded.phone, nationality=excluded.nationality,
      passport_file_id=excluded.passport_file_id, notes=excluded.notes, updated_at=excluded.updated_at
  `);
  stmt.run(data);
}

function getGuest(email) {
  return db.prepare('SELECT * FROM guests WHERE email = ?').get(email);
}

function searchGuests(query) {
  return db.prepare(`SELECT * FROM guests WHERE name LIKE ? OR email LIKE ? ORDER BY last_stay DESC LIMIT 10`)
    .all(`%${query}%`, `%${query}%`);
}

function updateGuestStats(email, revenue) {
  db.prepare(`
    UPDATE guests SET booking_count = booking_count + 1, total_revenue = total_revenue + ?, last_stay = datetime('now'), updated_at = datetime('now')
    WHERE email = ?
  `).run(revenue || 0, email);
}

// ─── Bookings ──────────────────────────────────────────────────────────────────
function saveBooking(data) {
  const stmt = db.prepare(`
    INSERT INTO bookings (guest_name, guest_email, villa_name, check_in, check_out, price, status, contract_doc_id, calendar_event_id, notes)
    VALUES (@guest_name, @guest_email, @villa_name, @check_in, @check_out, @price, @status, @contract_doc_id, @calendar_event_id, @notes)
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid;
}

function updateBookingStatus(id, status, extra = {}) {
  db.prepare(`
    UPDATE bookings SET status = ?, contract_doc_id = COALESCE(?, contract_doc_id),
    calendar_event_id = COALESCE(?, calendar_event_id), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, extra.contract_doc_id || null, extra.calendar_event_id || null, id);
}

function getBookings(filter = {}) {
  if (filter.villa) return db.prepare('SELECT * FROM bookings WHERE villa_name = ? ORDER BY check_in DESC').all(filter.villa);
  if (filter.guest_email) return db.prepare('SELECT * FROM bookings WHERE guest_email = ? ORDER BY check_in DESC').all(filter.guest_email);
  if (filter.status) return db.prepare('SELECT * FROM bookings WHERE status = ? ORDER BY check_in DESC').all(filter.status);
  return db.prepare('SELECT * FROM bookings ORDER BY check_in DESC LIMIT 20').all();
}

function getUpcomingBookings(days = 30) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE check_in >= date('now') AND check_in <= date('now', '+${days} days')
    ORDER BY check_in ASC
  `).all();
}

// ─── Agent Decisions / History ─────────────────────────────────────────────────
function logDecision(data) {
  db.prepare(`
    INSERT INTO decisions (session_id, user_message, plan_used, tools_called, outcome, supervisor_notes)
    VALUES (@session_id, @user_message, @plan_used, @tools_called, @outcome, @supervisor_notes)
  `).run(data);
}

function getRecentDecisions(limit = 10) {
  return db.prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ─── Agent Notes ───────────────────────────────────────────────────────────────
function saveNote(title, body, tags = '') {
  const stmt = db.prepare(`
    INSERT INTO agent_notes (title, body, tags)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  stmt.run(title, body, tags);
}

function searchNotes(query) {
  return db.prepare(`SELECT * FROM agent_notes WHERE title LIKE ? OR body LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 10`)
    .all(`%${query}%`, `%${query}%`, `%${query}%`);
}

function getAllNotes() {
  return db.prepare('SELECT * FROM agent_notes ORDER BY updated_at DESC').all();
}

// ─── Context Builder (for injecting into LLM prompts) ──────────────────────────
function buildContextSummary() {
  const profile = getOwnerProfile();
  const villas = getAllVillas();
  const upcomingBookings = getUpcomingBookings(14);
  const recentDecisions = getRecentDecisions(5);
  const facts = getAllFacts();

  let context = `=== TVMbot Business Memory Context ===\n\n`;

  if (Object.keys(profile).length > 0) {
    context += `OWNER PROFILE:\n`;
    for (const [k, v] of Object.entries(profile)) context += `  ${k}: ${v}\n`;
    context += '\n';
  }

  if (villas.length > 0) {
    context += `VILLAS MANAGED (${villas.length}):\n`;
    for (const v of villas) {
      context += `  • ${v.name} — ${v.location || 'location TBD'} | ${v.bedrooms || '?'} BR | $${v.base_price || '?'}/night\n`;
    }
    context += '\n';
  }

  if (upcomingBookings.length > 0) {
    context += `UPCOMING BOOKINGS (next 14 days):\n`;
    for (const b of upcomingBookings) {
      context += `  • ${b.guest_name} @ ${b.villa_name}: ${b.check_in} → ${b.check_out} [${b.status}]\n`;
    }
    context += '\n';
  }

  if (facts.length > 0) {
    const byCategory = {};
    for (const f of facts) {
      if (!byCategory[f.category]) byCategory[f.category] = [];
      byCategory[f.category].push(`${f.key}: ${f.value}`);
    }
    context += `BUSINESS FACTS:\n`;
    for (const [cat, items] of Object.entries(byCategory)) {
      context += `  [${cat}]\n`;
      for (const item of items) context += `    ${item}\n`;
    }
    context += '\n';
  }

  if (recentDecisions.length > 0) {
    context += `RECENT AGENT ACTIONS:\n`;
    for (const d of recentDecisions) {
      context += `  • [${d.created_at.slice(0, 16)}] ${d.user_message?.slice(0, 80) || 'N/A'}\n`;
    }
    context += '\n';
  }

  return context.trim();
}

module.exports = {
  // Facts
  setFact, getFact, getFactsByCategory, getAllFacts,
  // Owner
  setOwnerField, getOwnerProfile, saveOwnerProfileBulk,
  // Villas
  upsertVilla, getVilla, getAllVillas,
  // Guests
  upsertGuest, getGuest, searchGuests, updateGuestStats,
  // Bookings
  saveBooking, updateBookingStatus, getBookings, getUpcomingBookings,
  // Decisions
  logDecision, getRecentDecisions,
  // Notes
  saveNote, searchNotes, getAllNotes,
  // Context
  buildContextSummary,
  // DB
  db
};
