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
    capability_type: 'operational',
    required_tools: ['calendar_create_event', 'calendar_get_events', 'calendar_check_availability', 'calendar_delete_event', 'calendar_update_event', 'sheets_read_data', 'sheets_append_row'],
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
    capability_type: 'operational',
    required_tools: ['maintenance_add_task', 'maintenance_update_task', 'maintenance_get_tasks', 'sheets_append_row', 'sheets_read_data'],
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
    capability_type: 'operational',
    required_tools: ['finance_log_payment', 'finance_log_expense', 'finance_get_report', 'finance_get_outstanding', 'finance_generate_invoice', 'sheets_read_data', 'sheets_append_row'],
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
    capability_type: 'operational',
    required_tools: ['calendar_get_events', 'calendar_create_event', 'calendar_delete_event', 'calendar_update_event', 'calendar_check_availability'],
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
    capability_type: 'operational',
    required_tools: ['gmail_list_messages', 'gmail_read_message', 'gmail_send_message', 'gmail_get_flagged'],
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
    capability_type: 'contextual',
    required_tools: [],
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
    capability_type: 'operational',
    required_tools: ['sheets_read_data', 'sheets_write_data', 'sheets_append_row', 'drive_search_files'],
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
    capability_type: 'contextual',
    required_tools: [],
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
    capability_type: 'operational',
    required_tools: ['sheets_read_data', 'calendar_get_events', 'maintenance_get_tasks', 'gmail_list_messages'],
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
    capability_type: 'operational',
    required_tools: ['drive_search_files', 'drive_read_contract', 'drive_scan_folder'],
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
    capability_type: 'contextual',
    required_tools: [],
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
    capability_type: 'operational',
    required_tools: ['sheets_read_data'],
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
  },
  {
    id: 'whatsapp-ops',
    file: 'whatsapp-ops.md',
    capability_type: 'operational',
    required_tools: ['whatsapp_send_group'],
    keywords: ['whatsapp', 'wa ', ' wa', 'group', 'send message', 'notify', 'kirim wa',
               'money flow', 'maintenance tvm', 'group syifa', 'tvmbot group',
               'notifikasi', 'broadcast', 'blast', 'chat group'],
    summary: 'You can send WhatsApp messages to groups (Money Flow, Maintenance TVM, Ops) and notify staff.',
    priority: 2
  },
  {
    id: 'villas',
    file: 'villas.md',
    capability_type: 'contextual',
    required_tools: [],
    keywords: [
      'villa alyssa', 'villa ann', 'villa diane', 'villa lian', 'villa louna',
      'villa lourinka', 'villa lysa', 'villa nissa', 'syifa', 'bayu', 'dewi',
      'wati', 'sari', 'rina', 'check-in time', 'check-out time', 'pool',
      'minimum stay', 'pic', 'housekeeping', 'turnover', 'villa capacity',
      'villa bedrooms', 'berapa kamar', 'jam check', 'late checkout', 'early checkin',
      'who is pic', 'siapa pic', 'contact syifa', 'contact bayu'
    ],
    summary: 'Villa reference: check-in/out times, PIC contacts (Syifa, Bayu, Dewi, Wati, Sari, Rina), bedroom counts, pool info, and standard procedures for all 8 villas.',
    priority: 3
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

  // Limit to max 3 matched skills to control token usage
  // (3 allows: villas reference + domain skill + secondary skill — common co-triggers)
  // Pick the ones with the most keyword hits
  if (matched.length > 3) {
    const scored = matched.map(skill => {
      const hits = skill.keywords.filter(kw => msg.includes(kw)).length;
      return { skill, hits };
    });
    scored.sort((a, b) => b.hits - a.hits);
    const top = scored.slice(0, 3).map(s => s.skill);
    const rest = scored.slice(3).map(s => s.skill);
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
        const capLabel = skill.capability_type === 'operational'
          ? '[OPERATIONAL — can execute via tools: ' + (skill.required_tools || []).join(', ') + ']'
          : '[CONTEXTUAL — guides reasoning only, no direct tool execution]';
        context += '\n' + capLabel + '\n' + content + '\n';
      }
    }
  }

  // One-line summaries for unmatched skills (so bot knows they exist)
  if (unmatched.length > 0) {
    context += '\nOTHER CAPABILITIES (available if needed):\n';
    for (const skill of unmatched) {
      if (!skill) continue;
      context += `- ${skill.summary || '(additional capability available)'}\n`;
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

// ─── Skill Classification Summary ──────────────────────────────────────────────
function getClassificationSummary() {
  const operational = SKILL_REGISTRY.filter(s => s.capability_type === 'operational');
  const contextual  = SKILL_REGISTRY.filter(s => s.capability_type === 'contextual');
  return {
    total: SKILL_REGISTRY.length,
    operational: operational.map(s => s.id),
    contextual:  contextual.map(s => s.id),
    operationalCount: operational.length,
    contextualCount:  contextual.length
  };
}

module.exports = {
  buildSkillContext,
  matchSkills,
  preloadSkills,
  getClassificationSummary,
  SKILL_REGISTRY
};
