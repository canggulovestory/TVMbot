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

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    villa_name TEXT,
    guest_name TEXT,
    booking_id INTEGER,
    payment_method TEXT,
    reference TEXT,
    status TEXT DEFAULT 'paid' CHECK(status IN ('paid','pending','partial','refunded')),
    date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    bank TEXT,
    account_number TEXT,
    currency TEXT DEFAULT 'USD',
    balance REAL DEFAULT 0,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL UNIQUE,
    guest_name TEXT NOT NULL,
    guest_email TEXT,
    villa_name TEXT,
    booking_id INTEGER,
    line_items TEXT,
    subtotal REAL,
    tax_rate REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total REAL,
    currency TEXT DEFAULT 'USD',
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','overdue','cancelled')),
    due_date TEXT,
    paid_date TEXT,
    file_path TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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

// ─── Transactions ──────────────────────────────────────────────────────────────
function logTransaction(data) {
  const stmt = db.prepare(`
    INSERT INTO transactions (type, category, description, amount, currency, villa_name, guest_name, booking_id, payment_method, reference, status, date)
    VALUES (@type, @category, @description, @amount, @currency, @villa_name, @guest_name, @booking_id, @payment_method, @reference, @status, @date)
  `);
  const res = stmt.run({
    type: data.type,
    category: data.category || (data.type === 'income' ? 'booking' : 'operations'),
    description: data.description,
    amount: parseFloat(data.amount),
    currency: data.currency || 'USD',
    villa_name: data.villa_name || null,
    guest_name: data.guest_name || null,
    booking_id: data.booking_id || null,
    payment_method: data.payment_method || null,
    reference: data.reference || null,
    status: data.status || 'paid',
    date: data.date || new Date().toISOString().slice(0, 10)
  });
  return res.lastInsertRowid;
}

function getTransactions(filter = {}) {
  if (filter.type) return db.prepare('SELECT * FROM transactions WHERE type = ? ORDER BY date DESC LIMIT 50').all(filter.type);
  if (filter.villa) return db.prepare('SELECT * FROM transactions WHERE villa_name = ? ORDER BY date DESC LIMIT 50').all(filter.villa);
  if (filter.month) return db.prepare("SELECT * FROM transactions WHERE strftime('%Y-%m', date) = ? ORDER BY date DESC").all(filter.month);
  return db.prepare('SELECT * FROM transactions ORDER BY date DESC LIMIT 50').all();
}

function getPLReport(startDate, endDate) {
  const rows = db.prepare(
    "SELECT type, category, SUM(amount) as total FROM transactions WHERE date >= ? AND date <= ? AND status != 'refunded' GROUP BY type, category ORDER BY type, total DESC"
  ).all(startDate, endDate);

  const income = rows.filter(r => r.type === 'income');
  const expenses = rows.filter(r => r.type === 'expense');
  const totalIncome = income.reduce((s, r) => s + r.total, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.total, 0);

  return {
    period: { from: startDate, to: endDate },
    income: { breakdown: income, total: totalIncome },
    expenses: { breakdown: expenses, total: totalExpenses },
    net_profit: totalIncome - totalExpenses,
    profit_margin: totalIncome > 0 ? (((totalIncome - totalExpenses) / totalIncome) * 100).toFixed(1) + '%' : '0%'
  };
}

function getOutstandingPayments() {
  return db.prepare("SELECT * FROM transactions WHERE status IN ('pending','partial') ORDER BY date ASC").all();
}

// ─── Bank Accounts ─────────────────────────────────────────────────────────────
function upsertBankAccount(data) {
  db.prepare(`
    INSERT INTO bank_accounts (name, bank, account_number, currency, balance, notes, updated_at)
    VALUES (@name, @bank, @account_number, @currency, @balance, @notes, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      bank=excluded.bank, account_number=excluded.account_number,
      currency=excluded.currency, balance=excluded.balance,
      notes=excluded.notes, updated_at=excluded.updated_at
  `).run({
    name: data.name,
    bank: data.bank || null,
    account_number: data.account_number || null,
    currency: data.currency || 'USD',
    balance: parseFloat(data.balance) || 0,
    notes: data.notes || null
  });
}

function updateBankBalance(name, balance) {
  db.prepare("UPDATE bank_accounts SET balance = ?, updated_at = datetime('now') WHERE name = ?").run(parseFloat(balance), name);
}

function getAllBankAccounts() {
  return db.prepare('SELECT * FROM bank_accounts ORDER BY name').all();
}

function getTotalBankBalance() {
  return db.prepare("SELECT currency, SUM(balance) as total FROM bank_accounts GROUP BY currency").all();
}

// ─── Invoices ──────────────────────────────────────────────────────────────────
function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const last = db.prepare("SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1").get();
  if (!last) return `INV-${year}-001`;
  const num = parseInt(last.invoice_number.split('-')[2] || 0) + 1;
  return `INV-${year}-${String(num).padStart(3, '0')}`;
}

function saveInvoice(data) {
  const invoiceNumber = data.invoice_number || generateInvoiceNumber();
  const stmt = db.prepare(`
    INSERT INTO invoices (invoice_number, guest_name, guest_email, villa_name, booking_id, line_items, subtotal, tax_rate, tax_amount, total, currency, status, due_date, notes)
    VALUES (@invoice_number, @guest_name, @guest_email, @villa_name, @booking_id, @line_items, @subtotal, @tax_rate, @tax_amount, @total, @currency, @status, @due_date, @notes)
  `);
  const res = stmt.run({
    invoice_number: invoiceNumber,
    guest_name: data.guest_name,
    guest_email: data.guest_email || null,
    villa_name: data.villa_name || null,
    booking_id: data.booking_id || null,
    line_items: JSON.stringify(data.line_items || []),
    subtotal: parseFloat(data.subtotal) || 0,
    tax_rate: parseFloat(data.tax_rate) || 0,
    tax_amount: parseFloat(data.tax_amount) || 0,
    total: parseFloat(data.total) || 0,
    currency: data.currency || 'USD',
    status: data.status || 'draft',
    due_date: data.due_date || null,
    notes: data.notes || null
  });
  return { id: res.lastInsertRowid, invoice_number: invoiceNumber };
}

function updateInvoiceStatus(invoiceNumber, status, filePath = null) {
  db.prepare(`
    UPDATE invoices SET status = ?, file_path = COALESCE(?, file_path),
    paid_date = CASE WHEN ? = 'paid' THEN date('now') ELSE paid_date END,
    updated_at = datetime('now') WHERE invoice_number = ?
  `).run(status, filePath, status, invoiceNumber);
}

function getInvoices(filter = {}) {
  if (filter.status) return db.prepare("SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC").all(filter.status);
  if (filter.guest_email) return db.prepare("SELECT * FROM invoices WHERE guest_email = ? ORDER BY created_at DESC").all(filter.guest_email);
  return db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 20').all();
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
  // Finance — Transactions
  logTransaction, getTransactions, getPLReport, getOutstandingPayments,
  // Finance — Bank Accounts
  upsertBankAccount, updateBankBalance, getAllBankAccounts, getTotalBankBalance,
  // Finance — Invoices
  generateInvoiceNumber, saveInvoice, updateInvoiceStatus, getInvoices,
  // Context
  buildContextSummary,
  // DB
  db
};
