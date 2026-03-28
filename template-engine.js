/**
 * Template Engine — Pre-Built Response Templates for Common Scenarios
 * Inspired by ruflo's response template system.
 *
 * Provides structured, professional templates for recurring message types
 * so TVMbot gives consistent, high-quality responses without burning API tokens.
 *
 * Features:
 *   - Bilingual templates (English + Bahasa Indonesia)
 *   - Variable interpolation {{villa}}, {{date}}, etc.
 *   - Division-specific templates
 *   - Versioning (A/B test different template styles)
 *   - Usage tracking
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'templates.db');

class TemplateEngine {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Pre-defined templates
    this.templates = {
      // ── Greetings ──
      'greeting:en': {
        text: `Hello! 👋 I'm TVMbot, The Villa Managers' AI assistant. I can help you with:\n\n• Villa bookings & availability\n• Guest services & check-in/out\n• Maintenance requests\n• Financial reports & expenses\n• Marketing & property listings\n• Interior design & renovations\n• Furniture sourcing\n\nHow can I help you today?`,
        category: 'greeting',
        language: 'en',
      },
      'greeting:id': {
        text: `Halo! 👋 Saya TVMbot, asisten AI The Villa Managers. Saya bisa membantu Anda dengan:\n\n• Booking & ketersediaan villa\n• Layanan tamu & check-in/out\n• Permintaan maintenance\n• Laporan keuangan & pengeluaran\n• Marketing & listing properti\n• Desain interior & renovasi\n• Pengadaan furniture\n\nAda yang bisa saya bantu?`,
        category: 'greeting',
        language: 'id',
      },

      // ── Booking Confirmations ──
      'booking:confirmed:en': {
        text: `✅ *Booking Confirmed*\n\nVilla: {{villa}}\nGuest: {{guest_name}}\nCheck-in: {{checkin_date}}\nCheck-out: {{checkout_date}}\nTotal: {{total_amount}}\n\nA confirmation email has been sent. The villa team will prepare everything for your guest's arrival.\n\nRef: {{booking_ref}}`,
        category: 'booking',
        language: 'en',
      },
      'booking:confirmed:id': {
        text: `✅ *Booking Dikonfirmasi*\n\nVilla: {{villa}}\nTamu: {{guest_name}}\nCheck-in: {{checkin_date}}\nCheck-out: {{checkout_date}}\nTotal: {{total_amount}}\n\nEmail konfirmasi sudah dikirim. Tim villa akan menyiapkan segalanya untuk kedatangan tamu.\n\nRef: {{booking_ref}}`,
        category: 'booking',
        language: 'id',
      },

      // ── Availability Response ──
      'booking:available:en': {
        text: `📅 *Availability Check — {{villa}}*\n\n{{checkin_date}} to {{checkout_date}}: *AVAILABLE* ✅\n\nRate: {{rate_per_night}}/night\nEstimated total: {{total_amount}} ({{num_nights}} nights)\n\nWould you like me to proceed with the booking?`,
        category: 'booking',
        language: 'en',
      },
      'booking:unavailable:en': {
        text: `📅 *Availability Check — {{villa}}*\n\n{{checkin_date}} to {{checkout_date}}: *NOT AVAILABLE* ❌\n\n{{conflict_reason}}\n\nAlternative options:\n{{alternatives}}`,
        category: 'booking',
        language: 'en',
      },

      // ── Maintenance ──
      'maintenance:logged:en': {
        text: `🔧 *Maintenance Request Logged*\n\nVilla: {{villa}}\nIssue: {{issue_description}}\nPriority: {{priority}}\nReported by: {{reported_by}}\n\n{{priority_action}}\n\nRef: {{maintenance_ref}}`,
        category: 'maintenance',
        language: 'en',
      },
      'maintenance:logged:id': {
        text: `🔧 *Permintaan Maintenance Tercatat*\n\nVilla: {{villa}}\nMasalah: {{issue_description}}\nPrioritas: {{priority}}\nDilaporkan oleh: {{reported_by}}\n\n{{priority_action}}\n\nRef: {{maintenance_ref}}`,
        category: 'maintenance',
        language: 'id',
      },

      // ── Financial ──
      'finance:expense-logged:en': {
        text: `💰 *Expense Recorded*\n\nAmount: IDR {{amount}}\nCategory: {{category}}\nVilla/Division: {{division}}\nDescription: {{description}}\nDate: {{date}}\n\n{{approval_note}}\n\nRef: {{expense_ref}}`,
        category: 'finance',
        language: 'en',
      },
      'finance:summary:en': {
        text: `📊 *Financial Summary — {{period}}*\n\nRevenue: IDR {{revenue}}\nExpenses: IDR {{expenses}}\nNet: IDR {{net}}\n\nTop Revenue: {{top_revenue_source}}\nTop Expense: {{top_expense_category}}\n\n{{trend_note}}`,
        category: 'finance',
        language: 'en',
      },

      // ── Guest Services ──
      'guest:welcome:en': {
        text: `🌴 *Welcome to {{villa}}!*\n\nDear {{guest_name}},\n\nWe hope you enjoy your stay at {{villa}}. Here are some helpful details:\n\n📍 Address: {{address}}\n🔑 WiFi: {{wifi_password}}\n📞 Emergency: {{emergency_contact}}\n🕐 Check-out: {{checkout_time}}\n\nIf you need anything during your stay, just let us know!`,
        category: 'guest',
        language: 'en',
      },
      'guest:checkout-reminder:en': {
        text: `⏰ *Check-out Reminder*\n\nDear {{guest_name}},\n\nJust a friendly reminder that check-out for {{villa}} is tomorrow at {{checkout_time}}.\n\nPlease ensure:\n• All personal belongings are packed\n• Keys/cards returned to reception\n• Any damages reported\n\nWe hope you had a wonderful stay! 🌟`,
        category: 'guest',
        language: 'en',
      },

      // ── Marketing ──
      'marketing:listing:en': {
        text: `🏡 *{{villa}} — Available for Rent*\n\n{{description}}\n\n📍 Location: {{location}}\n🛏️ Bedrooms: {{bedrooms}}\n💰 Rate: {{rate_per_night}}/night\n\nFeatures:\n{{features}}\n\nBook now through The Villa Managers!\n📧 {{contact_email}}\n📱 {{contact_phone}}`,
        category: 'marketing',
        language: 'en',
      },

      // ── Error/Fallback ──
      'error:general:en': {
        text: `I apologize, but I encountered an issue while processing your request. Let me try a different approach, or I can connect you with our team for direct assistance.\n\nError: {{error_detail}}`,
        category: 'error',
        language: 'en',
      },
      'error:general:id': {
        text: `Mohon maaf, saya mengalami kendala saat memproses permintaan Anda. Saya akan mencoba cara lain, atau saya bisa menghubungkan Anda dengan tim kami untuk bantuan langsung.\n\nKendala: {{error_detail}}`,
        category: 'error',
        language: 'id',
      },

      // ── Status Updates ──
      'status:villa-overview:en': {
        text: `🏘️ *Villa Status Overview*\n\n{{villa_statuses}}\n\nTotal occupied: {{occupied_count}}/{{total_count}}\nUpcoming check-ins: {{upcoming_checkins}}\nUpcoming check-outs: {{upcoming_checkouts}}\n\nMaintenance pending: {{maintenance_pending}}`,
        category: 'status',
        language: 'en',
      },

      // ── Approval ──
      'approval:request:en': {
        text: `⚠️ *Approval Required*\n\nAction: {{action_description}}\nAmount: {{amount}}\nRequested by: {{requested_by}}\nRisk Level: {{risk_level}}\n\nPlease reply:\n• "approve {{ref}}" to approve\n• "reject {{ref}}" to reject\n\nThis request expires in {{expiry_hours}} hours.`,
        category: 'approval',
        language: 'en',
      },
    };

    this._seedTemplates();

    console.log(`[Templates] Initialized with ${Object.keys(this.templates).length} templates`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS template_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT UNIQUE,
        template_text TEXT NOT NULL,
        category TEXT,
        language TEXT DEFAULT 'en',
        version INTEGER DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS template_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT NOT NULL,
        session_id TEXT,
        variables TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_template_key ON template_registry(template_key);
      CREATE INDEX IF NOT EXISTS idx_template_category ON template_registry(category);
    `);
  }

  _seedTemplates() {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO template_registry (template_key, template_text, category, language)
      VALUES (?, ?, ?, ?)
    `);

    for (const [key, tmpl] of Object.entries(this.templates)) {
      insert.run(key, tmpl.text, tmpl.category, tmpl.language);
    }
  }

  /**
   * Render a template with variables
   */
  render(templateKey, variables = {}, language = 'en') {
    // Try language-specific key first
    let key = templateKey.includes(':') ? templateKey : `${templateKey}:${language}`;
    let tmpl = this.templates[key];

    // Fallback to English
    if (!tmpl && language !== 'en') {
      key = templateKey.replace(`:${language}`, ':en');
      tmpl = this.templates[key];
    }

    // Fallback to exact key
    if (!tmpl) tmpl = this.templates[templateKey];

    if (!tmpl) return null;

    // Interpolate variables
    let rendered = tmpl.text;
    for (const [varName, value] of Object.entries(variables)) {
      rendered = rendered.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), value || '');
    }

    // Remove unresolved placeholders
    rendered = rendered.replace(/\{\{[^}]+\}\}/g, '—');

    // Track usage
    this.db.prepare(`
      UPDATE template_registry SET usage_count = usage_count + 1, updated_at = datetime('now')
      WHERE template_key = ?
    `).run(key);

    this.db.prepare(`
      INSERT INTO template_usage (template_key, variables) VALUES (?, ?)
    `).run(key, JSON.stringify(variables));

    return rendered;
  }

  /**
   * Check if a response scenario matches a template
   */
  matchTemplate(intent, responseType, language = 'en') {
    const mappings = {
      'booking:create':      'booking:confirmed',
      'booking:check':       'booking:available',
      'maintenance:create':  'maintenance:logged',
      'finance:expense':     'finance:expense-logged',
      'finance:report':      'finance:summary',
      'guest:welcome':       'guest:welcome',
      'guest:checkout':      'guest:checkout-reminder',
      'marketing:listing':   'marketing:listing',
      'error':               'error:general',
      'greeting':            'greeting',
    };

    const baseKey = mappings[`${intent}:${responseType}`] || mappings[intent] || mappings[responseType];
    if (!baseKey) return null;

    return `${baseKey}:${language}`;
  }

  /**
   * Add a custom template
   */
  addTemplate(key, text, category = 'custom', language = 'en') {
    this.templates[key] = { text, category, language };
    this.db.prepare(`
      INSERT OR REPLACE INTO template_registry (template_key, template_text, category, language)
      VALUES (?, ?, ?, ?)
    `).run(key, text, category, language);
    return { added: key };
  }

  /**
   * Get most-used templates
   */
  getPopular(limit = 10) {
    return this.db.prepare(`
      SELECT template_key, usage_count, category FROM template_registry
      ORDER BY usage_count DESC LIMIT ?
    `).all(limit);
  }

  getStats() {
    const total = Object.keys(this.templates).length;
    const totalUsage = this.db.prepare('SELECT SUM(usage_count) as s FROM template_registry').get().s || 0;
    const categories = this.db.prepare(`
      SELECT category, COUNT(*) as c FROM template_registry GROUP BY category
    `).all();

    return {
      total,
      totalUsage,
      categories: Object.fromEntries(categories.map(r => [r.category, r.c])),
    };
  }
}

module.exports = new TemplateEngine();
