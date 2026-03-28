/**
 * smart-router.js — Q-Learning Smart Router + Agent Booster for TVMbot
 * Inspired by ruflo's Q-Learning Router, MoE (Mixture of Experts), and Agent Booster
 *
 * REPLACES simple keyword matching with intelligent multi-signal routing:
 *   1. Q-Learning table that improves routing over time
 *   2. Multi-signal scoring (keywords + entities + intent patterns + history)
 *   3. Agent Booster: handles simple queries WITHOUT calling Claude API ($0 cost)
 *   4. Confidence scoring with fallback strategies
 *   5. Routing analytics and performance tracking
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');

// ─── DATABASE SETUP ──────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'smart-router.db');
let db;
try {
  const fs = require('fs');
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
} catch (e) {
  console.warn('[SmartRouter] DB init failed, using in-memory:', e.message);
  db = new Database(':memory:');
}

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS q_table (
    state TEXT NOT NULL,
    action TEXT NOT NULL,
    q_value REAL DEFAULT 0.0,
    visits INTEGER DEFAULT 0,
    avg_reward REAL DEFAULT 0.0,
    last_updated TEXT,
    PRIMARY KEY (state, action)
  );

  CREATE TABLE IF NOT EXISTS routing_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    message_hash TEXT,
    detected_intent TEXT,
    selected_skills TEXT,
    confidence REAL,
    was_boosted INTEGER DEFAULT 0,
    response_time_ms INTEGER,
    success INTEGER DEFAULT 1,
    reward REAL DEFAULT 0.0
  );

  CREATE TABLE IF NOT EXISTS booster_cache (
    pattern TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    category TEXT NOT NULL,
    hit_count INTEGER DEFAULT 0,
    last_hit TEXT
  );

  CREATE TABLE IF NOT EXISTS intent_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent TEXT NOT NULL,
    pattern TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    examples TEXT DEFAULT '[]'
  );
`);

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

// Q-Learning hyperparameters
const ALPHA = 0.1;          // Learning rate
const GAMMA = 0.9;          // Discount factor
const EPSILON = 0.05;       // Exploration rate (5% random exploration)
const MIN_CONFIDENCE = 0.15; // Below this, load all skills

// Villa names for entity detection
const VILLA_NAMES = ['ANN', 'DIANE', 'KALA', 'LOUNA', 'NISSA', 'LYMA', 'LIAN', 'LYSA'];

// ─── INTENT CLASSIFIER ──────────────────────────────────────────────────────
// Multi-signal intent detection (inspired by ruflo's MoE — Mixture of Experts)

const INTENT_DEFINITIONS = {
  'booking': {
    keywords: [
      'book', 'booking', 'reserve', 'reservation', 'available', 'availability',
      'check-in', 'checkin', 'check-out', 'checkout', 'free', 'occupied',
      'vacant', 'guest', 'stay', 'night', 'pesan', 'tersedia', 'kosong',
      'tamu', 'menginap'
    ],
    patterns: [
      /\b(is|are)\s+(villa\s+)?\w+\s+(free|available|booked|occupied)/i,
      /\bbook(ing)?\s+(villa\s+)?\w+/i,
      /\bcheck[\s-]?(in|out)/i,
      /\b(any|which)\s+villa(s)?\s+(free|available)/i,
      /\bfor\s+\d+\s+night/i,
      /\b\d+\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    ],
    requiredTools: ['calendar', 'sheets'],
    skills: ['booking-manager', 'calendar-ops'],
  },
  'maintenance': {
    keywords: [
      'broken', 'fix', 'repair', 'leak', 'damage', 'maintenance', 'issue',
      'problem', 'replace', 'crack', 'clog', 'rusak', 'bocor', 'perbaiki',
      'kerusakan', 'plumber', 'electrician', 'ac', 'pool', 'pump',
      'roof', 'pipe', 'toilet', 'door', 'window', 'light'
    ],
    patterns: [
      /\b(is|are)\s+broken/i,
      /\bneed(s)?\s+(to\s+)?(fix|repair|replace)/i,
      /\b(pool|ac|air\s*con|pump|roof|pipe|toilet|door|window|light)\b.*\b(broken|leak|damage|issue|problem)/i,
      /\b(broken|leak|damage|issue|problem)\b.*\b(pool|ac|pump|roof|pipe|toilet)/i,
      /\bCLOSED\./,
    ],
    requiredTools: ['sheets'],
    skills: ['maintenance-tracker'],
  },
  'finance': {
    keywords: [
      'revenue', 'expense', 'payment', 'income', 'profit', 'loss', 'cost',
      'invoice', 'receipt', 'financial', 'money', 'bayar', 'pendapatan',
      'pengeluaran', 'transfer', 'bank', 'amount', 'total', 'budget',
      'outstanding', 'owed', 'debt', 'balance'
    ],
    patterns: [
      /\b(how\s+much|what('s|\s+is)\s+(the\s+)?(total|revenue|income|expense|profit|cost))/i,
      /\brevenue\s+(per|for|of)\s/i,
      /\bfinancial\s+report/i,
      /\bpay(ment)?\s+(from|to|for)/i,
      /\b(IDR|Rp|USD|\$)\s*[\d,.]+/i,
    ],
    requiredTools: ['sheets', 'finance'],
    skills: ['finance-reporter', 'data-analyst'],
  },
  'calendar': {
    keywords: [
      'calendar', 'event', 'schedule', 'meeting', 'appointment', 'remind',
      'reminder', 'jadwal', 'acara', 'when', 'date', 'time', 'today',
      'tomorrow', 'next week', 'this week'
    ],
    patterns: [
      /\b(create|add|set|make)\s+(a\s+)?(calendar|event|meeting|reminder)/i,
      /\bwhat('s|\s+is)\s+(on\s+)?(my\s+)?(calendar|schedule)/i,
      /\b(today|tomorrow|this\s+week|next\s+week)('s)?\s+(schedule|calendar|events)/i,
    ],
    requiredTools: ['calendar'],
    skills: ['calendar-ops'],
  },
  'email': {
    keywords: [
      'email', 'gmail', 'inbox', 'send email', 'mail', 'message',
      'forward', 'draft', 'subject', 'attachment'
    ],
    patterns: [
      /\b(send|write|draft|read|check)\s+(an?\s+)?email/i,
      /\b(my\s+)?(inbox|gmail|email)/i,
      /\bemail\s+(to|from|about)/i,
    ],
    requiredTools: ['gmail'],
    skills: ['email-ops'],
  },
  'file_search': {
    keywords: [
      'find file', 'search drive', 'find contract', 'find document',
      'find report', 'look for', 'where is', 'locate', 'search for',
      'cari file', 'cari dokumen', 'passport', 'agreement'
    ],
    patterns: [
      /\b(find|search|locate|where\s+is|look\s+for)\s+(the\s+)?(file|document|contract|report|passport|agreement|pdf)/i,
      /\b(give|send|show)\s+me\s+the\s+(contract|report|passport|document|file|agreement)/i,
      /\bgoogle\s+drive/i,
    ],
    requiredTools: ['drive'],
    skills: ['drive-search'],
  },
  'document_intelligence': {
    keywords: [
      'summarize', 'summary', 'what does it say', 'extract', 'key points',
      'analyze document', 'read contract', 'read report', 'insights',
      'explain this', 'content of', 'clause', 'term', 'termination',
      'ringkasan', 'rangkuman', 'apa isi', 'jelaskan'
    ],
    patterns: [
      /\b(summarize|summary\s+of|what\s+does\s+(it|the\s+\w+)\s+say)/i,
      /\b(key\s+points|main\s+points|highlights)\s+(of|from|in)/i,
      /\bwhat\s+(are\s+)?the\s+(terms?|clauses?|conditions?)\s/i,
    ],
    requiredTools: ['drive'],
    skills: ['knowledge-engine'],
  },
  'data_analysis': {
    keywords: [
      'calculate', 'average', 'compare', 'lowest', 'highest', 'sort',
      'rank', 'filter', 'breakdown', 'statistics', 'occupancy rate',
      'cost per', 'growth', 'decline', 'aggregate', 'sum', 'count',
      'forecast', 'trend', 'top performing', 'worst performing',
      'hitung', 'rata-rata', 'tertinggi', 'terendah', 'perbandingan'
    ],
    patterns: [
      /\b(revenue|expense|cost|profit|occupancy)\s+per\s+(villa|month|week)/i,
      /\b(compare|comparison)\s+.*(villa|month|quarter)/i,
      /\b(top|best|worst|lowest|highest)\s+(performing|revenue|occupancy)/i,
      /\btrend\s+(analysis|for|of|in)/i,
    ],
    requiredTools: ['sheets'],
    skills: ['data-analyst'],
  },
  'guest_comms': {
    keywords: [
      'guest message', 'check-in instructions', 'welcome message',
      'thank you message', 'guest communication', 'send to guest',
      'guest info', 'arrival', 'departure', 'directions'
    ],
    patterns: [
      /\b(send|write|prepare)\s+(a\s+)?(welcome|check[\s-]?in|thank\s+you|arrival|departure)\s+(message|instructions|info)/i,
      /\bguest\s+(message|communication|info|instructions)/i,
    ],
    requiredTools: ['calendar', 'gmail'],
    skills: ['guest-comms'],
  },
  'data_ops': {
    keywords: [
      'sheet', 'spreadsheet', 'data', 'lookup', 'find data', 'update cell',
      'add row', 'read sheet', 'write to sheet', 'column', 'row'
    ],
    patterns: [
      /\b(read|write|update|add|append)\s+(to\s+)?(the\s+)?(sheet|spreadsheet|data|cell|row|column)/i,
      /\b(google\s+)?sheet(s)?/i,
    ],
    requiredTools: ['sheets'],
    skills: ['data-ops'],
  },
  'audit': {
    keywords: [
      'audit', 'check issues', 'any problems', 'inconsistency',
      'double booking', 'status report', 'health check', 'scan',
      'verify', 'validate'
    ],
    patterns: [
      /\b(run|do|perform)\s+(an?\s+)?(audit|check|scan|verification)/i,
      /\b(any|are\s+there)\s+(issues?|problems?|errors?|inconsistenc)/i,
      /\bstatus\s+report/i,
    ],
    requiredTools: ['sheets', 'calendar'],
    skills: ['operations-auditor'],
  },
  'advice': {
    keywords: [
      'what do you think', 'advice', 'suggest', 'recommend', 'should we',
      'pricing', 'strategy', 'optimize', 'decision', 'opinion'
    ],
    patterns: [
      /\b(what\s+do\s+you\s+(think|suggest|recommend))/i,
      /\bshould\s+(we|i)\s/i,
      /\b(your\s+)?(advice|opinion|recommendation|suggestion)/i,
    ],
    requiredTools: ['sheets'],
    skills: ['advisor'],
  },

  // ─── TVM BUSINESS DIVISIONS ────────────────────────────────
  'agency': {
    keywords: [
      'agency', 'listing', 'property listing', 'client', 'deal', 'commission',
      'referral', 'partnership', 'lead', 'prospect', 'sell property',
      'rent property', 'lease', 'landlord', 'tenant', 'owner', 'agent'
    ],
    patterns: [
      /\b(new\s+)?(listing|client|lead|deal|prospect|referral)/i,
      /\b(property|villa)\s+(for\s+)?(sale|rent|lease)/i,
      /\b(agency|commission|partnership)\b/i,
      /\b(landlord|tenant|owner)\s+(wants?|needs?|looking)/i,
    ],
    requiredTools: ['sheets', 'calendar'],
    skills: ['advisor'],
  },
  'furniture': {
    keywords: [
      'furniture', 'sofa', 'table', 'chair', 'bed', 'cabinet', 'wardrobe',
      'inventory', 'order', 'delivery', 'custom order', 'showroom',
      'teak', 'rattan', 'wood', 'mebel', 'kursi', 'meja', 'lemari',
      'supplier', 'stock'
    ],
    patterns: [
      /\b(furniture|mebel)\s+(order|stock|deliver|price|inventory)/i,
      /\b(order|deliver|ship)\s+(the\s+)?(furniture|sofa|table|bed|chair)/i,
      /\b(how\s+much|price|cost)\s+(for\s+)?(the\s+)?(sofa|table|chair|bed|cabinet|furniture)/i,
      /\b(custom|bespoke)\s+(furniture|order|design)/i,
    ],
    requiredTools: ['sheets'],
    skills: ['data-ops'],
  },
  'renovation': {
    keywords: [
      'renovation', 'renovasi', 'construction', 'project', 'contractor',
      'kontraktor', 'permit', 'timeline', 'progress', 'build', 'demolish',
      'foundation', 'structure', 'walls', 'roof', 'tukang', 'bangun',
      'material', 'cement', 'brick', 'tile'
    ],
    patterns: [
      /\b(renovation|renovasi|construction)\s+(project|status|progress|budget|timeline)/i,
      /\b(project|proyek)\s+(update|status|progress|timeline|budget)/i,
      /\b(contractor|kontraktor|tukang)\s/i,
      /\b(how\s+is\s+the|update\s+on)\s+(renovation|project|construction)/i,
    ],
    requiredTools: ['sheets', 'calendar'],
    skills: ['data-ops'],
  },
  'interior': {
    keywords: [
      'interior', 'design', 'desain', 'concept', 'style', 'mood board',
      'color', 'palette', 'layout', 'decor', 'staging', 'aesthetic',
      'modern', 'tropical', 'minimalist', 'balinese', 'furnish'
    ],
    patterns: [
      /\b(interior\s+design|desain\s+interior)/i,
      /\b(mood\s+board|color\s+palette|design\s+concept)/i,
      /\b(style|aesthetic)\s+(for|of)\s/i,
      /\b(furnish|decorate|stage)\s+(the\s+)?(villa|room|space|property)/i,
    ],
    requiredTools: ['drive'],
    skills: ['advisor'],
  },
  'hr': {
    keywords: [
      'staff', 'team', 'employee', 'hire', 'payroll', 'salary', 'schedule staff',
      'assign', 'worker', 'karyawan', 'gaji', 'performance', 'attendance',
      'leave', 'cuti', 'shift'
    ],
    patterns: [
      /\b(staff|team|employee|karyawan)\s+(schedule|assign|performance|salary|payroll)/i,
      /\b(who\s+is\s+(assigned|working|available))/i,
      /\b(hire|recruit|fire|terminate)\s/i,
      /\b(payroll|salary|gaji)\s+(report|update|status)/i,
    ],
    requiredTools: ['sheets'],
    skills: ['data-ops'],
  },
  'marketing': {
    keywords: [
      'marketing', 'content', 'social media', 'instagram', 'facebook', 'tiktok',
      'promotion', 'campaign', 'listing description', 'caption', 'hashtag',
      'branding', 'seo', 'advertisement', 'promo', 'discount', 'copy',
      'iklan', 'promosi', 'konten'
    ],
    patterns: [
      /\b(write|create|make|draft)\s+(a\s+)?(caption|listing|description|post|content|copy|ad|advertisement)/i,
      /\b(social\s+media|instagram|facebook|tiktok|marketing)\s+(post|content|strategy|campaign)/i,
      /\b(promote|advertise|market)\s+(the\s+)?(villa|property|furniture|service)/i,
    ],
    requiredTools: ['drive'],
    skills: ['advisor'],
  },
  'scraping': {
    keywords: [
      'scrape', 'scraping', 'website', 'link', 'url', 'competitor',
      'price check', 'monitor', 'airbnb', 'booking.com', 'check website',
      'extract from', 'fetch from', 'look at this link', 'check this link',
      'cek link', 'cek website', 'lihat harga'
    ],
    patterns: [
      /\b(scrape|check|look\s+at|visit|open|fetch|extract\s+from)\s+(this\s+)?(link|url|website|page|site)/i,
      /https?:\/\/\S+/i,
      /\b(competitor|airbnb|booking\.com|agoda|traveloka)\s+(price|listing|rate)/i,
      /\b(price|harga)\s+(check|monitor|compare|comparison)\s/i,
    ],
    requiredTools: ['scraper'],
    skills: ['advisor'],
  },
};

// ─── AGENT BOOSTER ───────────────────────────────────────────────────────────
// Handles simple queries WITHOUT calling Claude API = $0 cost
// Inspired by ruflo's WASM Agent Booster transforms

const BOOSTER_PATTERNS = {
  // Greetings
  greeting: {
    patterns: [
      /^(hi|hello|hey|halo|hai|good\s+(morning|afternoon|evening|night)|selamat\s+(pagi|siang|sore|malam)|assalamualaikum|yo|sup)\s*[!.?]*$/i,
    ],
    responses: [
      "Hi! I'm TVMbot, ready to help with villa management. What do you need?",
      "Hello! How can I help you today?",
      "Hi there! What can I do for you?",
    ],
    category: 'greeting',
  },
  // Bot status check
  status: {
    patterns: [
      /^(are\s+you\s+(there|alive|working|online|awake)|you\s+there\??|bot\??|hello\s*bot|test(ing)?)\s*[!.?]*$/i,
      /^(ping|status)\s*$/i,
    ],
    responses: [
      "I'm here and operational! What do you need help with?",
      "Yes, I'm online and ready. How can I assist?",
    ],
    category: 'status',
  },
  // Thanks
  thanks: {
    patterns: [
      /^(thanks?(\s+you)?|thank\s+you(\s+(so\s+much|very\s+much))?|thx|ty|terima\s*kasih|makasih|ok\s+thanks?)\s*[!.]*$/i,
    ],
    responses: [
      "You're welcome! Let me know if you need anything else.",
      "Happy to help! Anything else?",
    ],
    category: 'thanks',
  },
  // Simple acknowledgment
  acknowledgment: {
    patterns: [
      /^(ok(ay)?|got\s+it|noted|understood|sure|alright|baik(lah)?|oke?|siap|mantap)\s*[!.]*$/i,
    ],
    responses: null, // Don't respond to bare acknowledgments
    category: 'acknowledgment',
  },
  // Villa list query
  villa_list: {
    patterns: [
      /^(what\s+villas?\s+(do\s+you|we)\s+manage|list\s+(of\s+)?villas?|how\s+many\s+villas?|villa\s+apa\s+saja|daftar\s+villa)\s*\??$/i,
    ],
    responses: [
      "We manage 8 villas in Bali:\n\n• *ANN*\n• *DIANE*\n• *KALA*\n• *LOUNA*\n• *NISSA*\n• *LYMA*\n• *LIAN*\n• *LYSA*\n\nWhich villa would you like to know more about?",
    ],
    category: 'faq',
  },
  // Who are you
  identity: {
    patterns: [
      /^(who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|apa\s+kamu|siapa\s+kamu|kamu\s+bisa\s+apa)\s*\??$/i,
    ],
    responses: [
      "I'm *TVMbot*, the AI assistant for The Villa Managers. I can help with:\n\n• Villa bookings & availability\n• Maintenance tracking\n• Financial reports\n• Google Drive file search\n• Document summaries\n• Email management\n• Calendar scheduling\n• Strategic business advice\n\nJust ask me anything!",
    ],
    category: 'faq',
  },
};

// ─── CORE ROUTER CLASS ──────────────────────────────────────────────────────

class SmartRouter {
  constructor() {
    this._seedIntentPatterns();
    this._seedBoosterCache();
    console.log('[SmartRouter] Initialized with Q-Learning routing + Agent Booster');
  }

  /**
   * Main routing function — replaces the old skill-loader.matchSkills()
   * Returns: { skills, confidence, intent, boosted, boosterResponse, requiredTools }
   */
  route(message, context = {}) {
    const startTime = Date.now();
    const cleanMsg = this._stripWhatsAppContext(message);

    // ─── Step 1: Agent Booster check (skip Claude entirely?) ───
    const boosterResult = this._checkBooster(cleanMsg);
    if (boosterResult) {
      this._logRouting(cleanMsg, 'booster:' + boosterResult.category, [], 1.0, true, Date.now() - startTime);
      return {
        skills: [],
        confidence: 1.0,
        intent: 'booster:' + boosterResult.category,
        boosted: true,
        boosterResponse: boosterResult.response,
        requiredTools: [],
        routingTimeMs: Date.now() - startTime,
      };
    }

    // ─── Step 2: Multi-signal intent classification ───
    const intentScores = this._classifyIntent(cleanMsg, context);

    // ─── Step 3: Q-Learning adjustment ───
    const state = this._messageToState(cleanMsg);
    const qAdjusted = this._applyQLearning(state, intentScores);

    // ─── Step 4: Select top intents + map to skills ───
    const sorted = Object.entries(qAdjusted).sort((a, b) => b[1] - a[1]);
    const topIntent = sorted[0];
    const confidence = topIntent ? topIntent[1] : 0;

    let selectedSkills = [];
    let requiredTools = [];
    let intentName = 'general';

    if (confidence >= MIN_CONFIDENCE) {
      // Take top 1-2 intents (only include 2nd if it's close to 1st)
      const primaryIntent = INTENT_DEFINITIONS[topIntent[0]];
      if (primaryIntent) {
        selectedSkills.push(...primaryIntent.skills);
        requiredTools.push(...(primaryIntent.requiredTools || []));
        intentName = topIntent[0];
      }

      // Check if 2nd intent is within 60% of the primary
      if (sorted.length > 1 && sorted[1][1] >= topIntent[1] * 0.6) {
        const secondaryIntent = INTENT_DEFINITIONS[sorted[1][0]];
        if (secondaryIntent) {
          for (const s of secondaryIntent.skills) {
            if (!selectedSkills.includes(s)) selectedSkills.push(s);
          }
          for (const t of secondaryIntent.requiredTools || []) {
            if (!requiredTools.includes(t)) requiredTools.push(t);
          }
        }
      }

      // Cap at 3 skills max
      selectedSkills = selectedSkills.slice(0, 3);
    }

    // ─── Step 5: Log and return ───
    const routingTime = Date.now() - startTime;
    this._logRouting(cleanMsg, intentName, selectedSkills, confidence, false, routingTime);

    return {
      skills: selectedSkills,
      confidence,
      intent: intentName,
      boosted: false,
      boosterResponse: null,
      requiredTools: [...new Set(requiredTools)],
      routingTimeMs: routingTime,
      allScores: sorted.slice(0, 5).map(([k, v]) => ({ intent: k, score: Math.round(v * 100) / 100 })),
    };
  }

  /**
   * Reward function — called after a successful/failed response
   * This is how the Q-Learning table gets updated
   */
  reward(message, selectedSkills, rewardValue) {
    const state = this._messageToState(message);
    for (const skill of selectedSkills) {
      // Find which intent maps to this skill
      for (const [intentName, def] of Object.entries(INTENT_DEFINITIONS)) {
        if (def.skills.includes(skill)) {
          this._updateQValue(state, intentName, rewardValue);
          break;
        }
      }
    }
  }

  /**
   * Report a successful completion (positive reward)
   */
  reportSuccess(message, skills, responseTimeMs) {
    // Reward = 1.0 base, bonus for fast responses
    const timeBonus = responseTimeMs < 5000 ? 0.2 : responseTimeMs < 10000 ? 0.1 : 0;
    this.reward(message, skills, 1.0 + timeBonus);
  }

  /**
   * Report a failed/poor completion (negative reward)
   */
  reportFailure(message, skills) {
    this.reward(message, skills, -0.5);
  }

  // ─── INTENT CLASSIFICATION ──────────────────────────────────────────────

  _classifyIntent(message, context = {}) {
    const scores = {};
    const msgLower = message.toLowerCase();
    const words = msgLower.split(/\s+/).filter(w => w.length > 1);

    for (const [intentName, def] of Object.entries(INTENT_DEFINITIONS)) {
      let score = 0;

      // Signal 1: Keyword matching (weighted)
      let keywordHits = 0;
      for (const kw of def.keywords) {
        if (kw.includes(' ')) {
          // Multi-word keyword: exact phrase match
          if (msgLower.includes(kw.toLowerCase())) {
            keywordHits += 2; // Phrase matches worth more
          }
        } else {
          // Single word: word boundary match
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          if (regex.test(msgLower)) {
            keywordHits += 1;
          }
        }
      }
      score += Math.min(keywordHits / 3, 1.0) * 0.4; // Max 40% from keywords

      // Signal 2: Regex pattern matching
      let patternHits = 0;
      for (const pattern of def.patterns || []) {
        if (pattern.test(message)) {
          patternHits += 1;
        }
      }
      score += Math.min(patternHits / 2, 1.0) * 0.35; // Max 35% from patterns

      // Signal 3: Entity detection (villa names, amounts, dates)
      let entityScore = 0;
      const hasVilla = VILLA_NAMES.some(v => msgLower.includes(v.toLowerCase()));
      const hasAmount = /\b(IDR|Rp|USD|\$)\s*[\d,.]+|\b\d{1,3}([,.]\d{3})+\b/i.test(message);
      const hasDate = /\b\d{1,2}[\/\-\.]\d{1,2}([\/\-\.]\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i.test(message);

      if (hasVilla && ['booking', 'maintenance', 'finance', 'data_analysis'].includes(intentName)) entityScore += 0.3;
      if (hasAmount && ['finance', 'data_analysis'].includes(intentName)) entityScore += 0.3;
      if (hasDate && ['booking', 'calendar', 'finance'].includes(intentName)) entityScore += 0.2;
      score += Math.min(entityScore, 0.25); // Max 25% from entities

      scores[intentName] = score;
    }

    return scores;
  }

  // ─── Q-LEARNING ─────────────────────────────────────────────────────────

  _messageToState(message) {
    // Convert message to a compact state representation
    const msgLower = message.toLowerCase();
    const features = [];

    // Feature: message length bucket
    if (message.length < 20) features.push('short');
    else if (message.length < 60) features.push('medium');
    else features.push('long');

    // Feature: contains villa name
    if (VILLA_NAMES.some(v => msgLower.includes(v.toLowerCase()))) features.push('has_villa');

    // Feature: is question
    if (message.includes('?') || /^(what|who|when|where|how|is|are|can|do|does|will)\s/i.test(message)) features.push('question');

    // Feature: is command
    if (/^(book|fix|send|create|update|add|log|report|mark|close|find|search)/i.test(message)) features.push('command');

    // Feature: has amount
    if (/\b(IDR|Rp|USD|\$)\s*[\d,.]+/i.test(message)) features.push('has_amount');

    // Feature: language
    if (/\b(tolong|bisa|apa|siapa|dimana|kapan|berapa|bagaimana)\b/i.test(message)) features.push('bahasa');

    return features.sort().join('|') || 'empty';
  }

  _applyQLearning(state, intentScores) {
    const adjusted = { ...intentScores };

    // Epsilon-greedy: small chance of random exploration
    if (Math.random() < EPSILON) {
      return adjusted; // Don't apply Q-values, let natural scores decide
    }

    // Apply Q-value adjustments
    for (const [action, score] of Object.entries(adjusted)) {
      const qRow = db.prepare('SELECT q_value, visits FROM q_table WHERE state = ? AND action = ?').get(state, action);
      if (qRow && qRow.visits >= 3) {
        // Only apply Q-learning after 3+ visits (need enough data)
        // Blend: 70% natural score + 30% Q-value influence
        const qInfluence = Math.tanh(qRow.q_value) * 0.3; // tanh squashes to [-0.3, 0.3]
        adjusted[action] = Math.max(0, score + qInfluence);
      }
    }

    return adjusted;
  }

  _updateQValue(state, action, reward) {
    const existing = db.prepare('SELECT q_value, visits, avg_reward FROM q_table WHERE state = ? AND action = ?').get(state, action);

    if (existing) {
      // Q-Learning update: Q(s,a) = Q(s,a) + α * (reward + γ * maxQ - Q(s,a))
      // Simplified since we don't have a clear "next state": Q(s,a) = Q(s,a) + α * (reward - Q(s,a))
      const newQ = existing.q_value + ALPHA * (reward - existing.q_value);
      const newAvg = (existing.avg_reward * existing.visits + reward) / (existing.visits + 1);

      db.prepare('UPDATE q_table SET q_value = ?, visits = visits + 1, avg_reward = ?, last_updated = ? WHERE state = ? AND action = ?')
        .run(newQ, newAvg, new Date().toISOString(), state, action);
    } else {
      db.prepare('INSERT INTO q_table (state, action, q_value, visits, avg_reward, last_updated) VALUES (?, ?, ?, 1, ?, ?)')
        .run(state, action, reward * ALPHA, reward, new Date().toISOString());
    }
  }

  // ─── AGENT BOOSTER ──────────────────────────────────────────────────────

  _checkBooster(message) {
    const trimmed = message.trim();

    for (const [category, def] of Object.entries(BOOSTER_PATTERNS)) {
      for (const pattern of def.patterns) {
        if (pattern.test(trimmed)) {
          if (!def.responses) return null; // Acknowledgment — don't respond

          // Pick random response
          const response = def.responses[Math.floor(Math.random() * def.responses.length)];

          // Update hit count in cache
          try {
            db.prepare(`INSERT INTO booster_cache (pattern, response, category, hit_count, last_hit)
              VALUES (?, ?, ?, 1, ?) ON CONFLICT(pattern) DO UPDATE SET hit_count = hit_count + 1, last_hit = ?`)
              .run(category, response, category, new Date().toISOString(), new Date().toISOString());
          } catch (e) { /* ignore */ }

          return { response, category };
        }
      }
    }

    return null;
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────

  _stripWhatsAppContext(message) {
    // Remove [WhatsApp Group msg from +xxx] and [Replying to: ...] tags
    return message
      .replace(/\[WhatsApp\s+(Group\s+msg|DM)\s+from\s+\+\d+\]\s*/gi, '')
      .replace(/\[Replying\s+to:\s+[^\]]*\]\s*/gi, '')
      .trim();
  }

  _logRouting(message, intent, skills, confidence, wasBoosted, timeMs) {
    try {
      const hash = this._quickHash(message);
      db.prepare(`INSERT INTO routing_log (timestamp, message_hash, detected_intent, selected_skills, confidence, was_boosted, response_time_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(new Date().toISOString(), hash, intent, JSON.stringify(skills), confidence, wasBoosted ? 1 : 0, timeMs);
    } catch (e) { /* ignore logging errors */ }
  }

  _quickHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(16);
  }

  _seedIntentPatterns() {
    const count = db.prepare('SELECT COUNT(*) as c FROM intent_patterns').get().c;
    if (count === 0) {
      const stmt = db.prepare('INSERT INTO intent_patterns (intent, pattern, weight) VALUES (?, ?, ?)');
      for (const [intent, def] of Object.entries(INTENT_DEFINITIONS)) {
        for (const kw of def.keywords.slice(0, 5)) {
          stmt.run(intent, kw, 1.0);
        }
      }
      console.log('[SmartRouter] Seeded intent patterns');
    }
  }

  _seedBoosterCache() {
    const count = db.prepare('SELECT COUNT(*) as c FROM booster_cache').get().c;
    if (count === 0) {
      const stmt = db.prepare('INSERT OR IGNORE INTO booster_cache (pattern, response, category, hit_count, last_hit) VALUES (?, ?, ?, 0, ?)');
      for (const [cat, def] of Object.entries(BOOSTER_PATTERNS)) {
        if (def.responses) {
          stmt.run(cat, def.responses[0], cat, new Date().toISOString());
        }
      }
      console.log('[SmartRouter] Seeded booster cache');
    }
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as c FROM routing_log').get().c;
    const boosted = db.prepare('SELECT COUNT(*) as c FROM routing_log WHERE was_boosted = 1').get().c;
    const avgConf = db.prepare('SELECT AVG(confidence) as avg FROM routing_log WHERE was_boosted = 0').get().avg || 0;
    const avgTime = db.prepare('SELECT AVG(response_time_ms) as avg FROM routing_log').get().avg || 0;
    const qEntries = db.prepare('SELECT COUNT(*) as c FROM q_table').get().c;
    const topIntents = db.prepare(`SELECT detected_intent, COUNT(*) as count FROM routing_log
      GROUP BY detected_intent ORDER BY count DESC LIMIT 5`).all();

    return {
      totalRoutings: total,
      boostedCount: boosted,
      boostedPercentage: total > 0 ? Math.round(boosted / total * 100) : 0,
      avgConfidence: Math.round(avgConf * 100) / 100,
      avgRoutingTimeMs: Math.round(avgTime),
      qTableEntries: qEntries,
      topIntents,
      savingsEstimate: `~$${(boosted * 0.003).toFixed(2)} saved (${boosted} API calls avoided)`,
    };
  }

  getQTable() {
    return db.prepare('SELECT * FROM q_table ORDER BY visits DESC LIMIT 20').all();
  }

  getRecentRoutings(limit = 10) {
    return db.prepare('SELECT * FROM routing_log ORDER BY id DESC LIMIT ?').all(limit);
  }
}

// ─── SINGLETON EXPORT ────────────────────────────────────────────────────────
const router = new SmartRouter();

module.exports = router;
module.exports.SmartRouter = SmartRouter;
module.exports.INTENT_DEFINITIONS = INTENT_DEFINITIONS;
module.exports.BOOSTER_PATTERNS = BOOSTER_PATTERNS;
