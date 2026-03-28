// skill-loader.js — Progressive Skill Loader for TVMbot
// Loads domain-specific skills ONLY when relevant keywords are detected
// This saves tokens by not stuffing the system prompt with everything on every request

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = __dirname;

// ─── Skill Registry ────────────────────────────────────────────────────────────
// Each skill has: file (markdown path), keywords (trigger words), summary (1-liner for non-match)
const SKILL_REGISTRY = [
  {
    id: 'booking-manager',
    file: 'booking-manager.md',
    keywords: [
      'book', 'booking', 'reservation', 'check-in', 'checkout', 'check-out',
      'guest', 'arrival', 'departure', 'extend stay', 'cancel booking',
      'reschedule', 'availability', 'occupancy', 'airbnb', 'booking.com',
      'tamu', 'pesan kamar', 'cek ketersediaan', 'available', 'occupied',
      'villa free', 'who is staying', 'siapa yang menginap',
      'free', 'kosong', 'villa ann', 'villa diane', 'villa kala',
      'villa louna', 'villa nissa', 'villa lyma', 'villa lian', 'villa lysa'
    ],
    summary: 'You can manage villa bookings (create, modify, cancel, check availability).'
  },
  {
    id: 'maintenance-tracker',
    file: 'maintenance-tracker.md',
    keywords: [
      'maintenance', 'repair', 'fix', 'broken', 'issue', 'problem',
      'pool', 'ac ', 'a/c', 'wifi', 'leak', 'damage', 'pending task',
      'urgent', 'rusak', 'bocor', 'perbaikan', 'kerusakan', 'teknisi',
      'tukang', 'plumber', 'electrician', 'pump', 'not working', 'mati',
      'bunyi', 'strange noise', 'clogged'
    ],
    summary: 'You can track maintenance issues (report, update status, get summary).'
  },
  {
    id: 'finance-reporter',
    file: 'finance-reporter.md',
    keywords: [
      'payment', 'invoice', 'expense', 'income', 'revenue', 'bank',
      'balance', 'transaction', 'money', 'price', 'cost', 'fee',
      'earning', 'bill', 'outstanding', 'paid', 'financial', 'report',
      'budget', 'profit', 'loss', 'monthly', 'cash flow', 'bayar',
      'uang', 'biaya', 'tagihan', 'pendapatan', 'pengeluaran',
      'laporan keuangan', 'how much', 'berapa', 'total', 'summary'
    ],
    summary: 'You can handle finances (log payments/expenses, reports, invoices, bank balances).'
  },
  {
    id: 'calendar-ops',
    file: 'calendar-ops.md',
    keywords: [
      'calendar', 'event', 'schedule', 'appointment', 'meeting',
      'reschedule', 'cancel event', 'delete event', 'move event',
      'create event', 'block dates', 'jadwal', 'hapus jadwal',
      'pindah jadwal', 'umrah', 'holiday', 'day off', 'cuti',
      'today schedule', 'this week', 'tomorrow'
    ],
    summary: 'You can manage calendar events (create, update, delete, check schedule).'
  },
  {
    id: 'email-ops',
    file: 'email-ops.md',
    keywords: [
      'email', 'gmail', 'inbox', 'mail', 'send email', 'unread',
      'message from', 'reply email', 'forward', 'draft', 'compose',
      'kirim email', 'baca email', 'cek email', 'airbnb email',
      'booking email'
    ],
    summary: 'You can manage emails (read, send, search, check flagged).'
  },
  {
    id: 'guest-comms',
    file: 'guest-comms.md',
    keywords: [
      'guest message', 'guest communication', 'check-in instructions',
      'welcome', 'checkout reminder', 'review request', 'complaint',
      'feedback', 'template', 'send to guest', 'guest info',
      'instruksi', 'sambutan', 'complaint', 'respond to guest',
      'pre-arrival', 'mid-stay'
    ],
    summary: 'You can handle guest communications (templates, check-in info, complaints, reviews).'
  },
  {
    id: 'data-ops',
    file: 'data-ops.md',
    keywords: [
      'sheet', 'spreadsheet', 'data', 'lookup', 'search file',
      'drive', 'folder', 'document', 'contract', 'upload', 'download',
      'pdf', 'table', 'tab', 'row', 'column', 'find file', 'organize',
      'convert', 'merge', 'villa info', 'supplier', 'bills',
      'cari file', 'cari data', 'laporan', 'internet account',
      'electricity', 'address', 'passport'
    ],
    summary: 'You can work with spreadsheets, Drive files, and data lookups across all sheets.'
  },
  {
    id: 'advisor',
    file: 'advisor.md',
    keywords: [
      'what do you think', 'advice', 'suggest', 'recommend', 'opinion',
      'should i', 'should we', 'how to handle', 'what would you do',
      'strategy', 'idea', 'brainstorm', 'discuss', 'help me think',
      'pros cons', 'options', 'better way', 'best approach', 'deal with',
      'handle this', 'apa pendapat', 'saran', 'bagaimana menurut',
      'sebaiknya', 'gimana ya', 'menurut kamu', 'what should',
      'how should', 'is it worth', 'worth it', 'decision', 'decide',
      'compare', 'pricing', 'price adjustment', 'occupancy', 'vacancy',
      'low season', 'high season', 'inspection', 'pattern', 'trend',
      'optimize', 'improve'
    ],
    summary: 'Strategic business advisor: gives clear opinions backed by data, recommends decisions on pricing, maintenance, staffing, and operations.'
  },
  {
    id: 'operations-auditor',
    file: 'operations-auditor.md',
    keywords: [
      'audit', 'check issues', 'any problems', 'inconsistency', 'missing data',
      'error', 'overlap', 'conflict', 'double booking', 'status report',
      'health check', 'scan', 'detect', 'anomaly',
      'apa yang salah', 'ada masalah', 'cek masalah', 'duplicate',
      'zombie task', 'stale', 'unresolved', 'any issues', 'problems'
    ],
    summary: 'Scans all systems for problems: missing data, stale tasks, booking conflicts, duplicates, broken workflows.'
  },
  {
    id: 'drive-search',
    file: 'drive-search.md',
    keywords: [
      'find file', 'search drive', 'find contract', 'find document',
      'find report', 'look for', 'where is', 'locate', 'search for',
      'contract for', 'agreement', 'google drive', 'drive folder',
      'find pdf', 'find passport', 'cari file', 'cari dokumen',
      'cari kontrak', 'dimana file', 'file for', 'document for'
    ],
    summary: 'Search Google Drive for contracts, reports, documents, passports, and any file by name or content.'
  },
  {
    id: 'knowledge-engine',
    file: 'knowledge-engine.md',
    keywords: [
      'summarize', 'summary', 'what does it say', 'extract', 'key points',
      'analyze document', 'read contract', 'read report', 'insights',
      'explain this', 'tell me about the contract', 'content of',
      'document says', 'clause', 'term', 'condition', 'termination',
      'expiry', 'highlight', 'digest', 'briefing', 'ringkasan', 'rangkuman',
      'apa isi', 'jelaskan', 'kontrak bilang', 'isi dokumen'
    ],
    summary: 'Document intelligence: reads, summarizes, and answers questions about contracts, reports, and any file content.'
  },
  {
    id: 'data-analyst',
    file: 'data-analyst.md',
    keywords: [
      'revenue per villa', 'calculate', 'total', 'average', 'compare',
      'lowest', 'highest', 'sort', 'rank', 'filter', 'breakdown',
      'statistics', 'occupancy rate', 'cost per', 'profit', 'loss',
      'margin', 'monthly', 'quarterly', 'year over year', 'growth',
      'decline', 'aggregate', 'sum', 'count', 'forecast', 'trend analysis',
      'top performing', 'worst performing', 'pendapatan per villa',
      'hitung', 'rata-rata', 'tertinggi', 'terendah', 'perbandingan'
    ],
    summary: 'Data analyst: calculates revenue, expenses, occupancy, profit/loss, trends, and comparisons across villas.'
  }
];

// ─── Skill Cache (loaded once, reused) ─────────────────────────────────────────
const skillCache = {};

function loadSkillContent(skillId) {
  if (skillCache[skillId]) return skillCache[skillId];

  const skill = SKILL_REGISTRY.find(s => s.id === skillId);
  if (!skill) return null;

  try {
    const filePath = path.join(SKILLS_DIR, skill.file);
    const content = fs.readFileSync(filePath, 'utf8');
    skillCache[skillId] = content;
    return content;
  } catch (err) {
    console.error(`[SkillLoader] Failed to load skill "${skillId}":`, err.message);
    return null;
  }
}

// ─── Match Skills to User Message ──────────────────────────────────────────────
function matchSkills(userMessage) {
  // Strip WhatsApp context tags
  const msg = userMessage.replace(/\[WhatsApp.*?\]\s*/gi, '').toLowerCase();

  const matched = [];
  const unmatched = [];

  for (const skill of SKILL_REGISTRY) {
    const isMatch = skill.keywords.some(kw => msg.includes(kw));
    if (isMatch) {
      matched.push(skill);
    } else {
      unmatched.push(skill);
    }
  }

  // Limit to max 2 matched skills to control token usage
  // Pick the ones with the most keyword hits
  if (matched.length > 2) {
    const scored = matched.map(skill => {
      const hits = skill.keywords.filter(kw => msg.includes(kw)).length;
      return { skill, hits };
    });
    scored.sort((a, b) => b.hits - a.hits);
    const top = scored.slice(0, 2).map(s => s.skill);
    const rest = scored.slice(2).map(s => s.skill);
    return { matched: top, unmatched: [...rest, ...unmatched] };
  }

  return { matched, unmatched };
}

// ─── Build Skill Context for System Prompt ─────────────────────────────────────
// Returns a string to append to the system prompt
// - Matched skills: full content loaded (progressive disclosure)
// - Unmatched skills: one-line summary only (minimal tokens)
function buildSkillContext(userMessage) {
  const { matched, unmatched } = matchSkills(userMessage);

  if (matched.length === 0 && unmatched.length === 0) return '';

  let context = '\n\n── DOMAIN SKILLS ──────────────────────────────────────────\n';

  // Load full content for matched skills
  if (matched.length > 0) {
    context += '\nACTIVE SKILLS (use these workflows for this request):\n';
    for (const skill of matched) {
      const content = loadSkillContent(skill.id);
      if (content) {
        context += '\n' + content + '\n';
      }
    }
  }

  // One-line summaries for unmatched skills (so bot knows they exist)
  if (unmatched.length > 0) {
    context += '\nOTHER CAPABILITIES (available if needed):\n';
    for (const skill of unmatched) {
      context += `- ${skill.summary}\n`;
    }
  }

  const matchedNames = matched.map(s => s.id).join(', ') || 'none';
  console.log(`[SkillLoader] Matched: ${matchedNames} | Unmatched: ${unmatched.length} skills (summaries only)`);

  return context;
}

// ─── Pre-warm Cache ────────────────────────────────────────────────────────────
function preloadSkills() {
  let loaded = 0;
  for (const skill of SKILL_REGISTRY) {
    const content = loadSkillContent(skill.id);
    if (content) loaded++;
  }
  console.log(`[SkillLoader] Pre-loaded ${loaded}/${SKILL_REGISTRY.length} skills into cache`);
}

module.exports = {
  buildSkillContext,
  matchSkills,
  preloadSkills,
  SKILL_REGISTRY
};
