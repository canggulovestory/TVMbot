/**
 * swarm-coordinator.js — Multi-Agent Swarm Coordinator for TVMbot
 * Inspired by ruflo's UnifiedSwarmCoordinator + Queen-Worker topology
 *
 * TVMbot becomes a General Manager with specialized departments (agents):
 *   - Each agent has expertise, personality, and decision authority
 *   - Complex tasks get routed to multiple agents
 *   - Consensus voting resolves conflicts between agents
 *   - Queen (GM) coordinates and makes final calls
 *
 * Architecture:
 *   Queen (TVMbot GM) → dispatches to → Worker Agents → consensus → final answer
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── DATABASE ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'swarm.db');
let db;
try {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (e) {
  db = new Database(':memory:');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS swarm_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT UNIQUE NOT NULL,
    message TEXT NOT NULL,
    intent TEXT,
    assigned_agents TEXT DEFAULT '[]',
    agent_responses TEXT DEFAULT '[]',
    consensus_result TEXT,
    consensus_method TEXT,
    final_response TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT,
    completed_at TEXT,
    total_time_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS agent_performance (
    agent_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    avg_quality REAL DEFAULT 0.5,
    total_tasks INTEGER DEFAULT 0,
    last_task_at TEXT,
    PRIMARY KEY (agent_id, task_type)
  );
`);

// ─── AGENT DEFINITIONS ──────────────────────────────────────────────────────
// Each agent is a specialized "department head" in the company

const AGENTS = {
  // ═══════════════════════════════════════════════════════════════
  // VILLA MANAGEMENT DIVISION
  // ═══════════════════════════════════════════════════════════════
  'villa-ops': {
    name: 'Villa Operations Manager',
    role: 'Oversees all day-to-day villa operations: maintenance, cleaning, property management, vendor coordination, and guest readiness.',
    expertise: ['maintenance', 'cleaning', 'property', 'villa', 'vendor', 'inspection', 'pool', 'garden', 'ac', 'plumber', 'electrician', 'rusak', 'bocor', 'perbaiki'],
    personality: 'Detail-oriented, proactive, action-focused. Thinks in checklists and SOPs.',
    decisionWeight: 1.0,
    systemPromptAddition: `You are the Villa Operations Manager. You ensure every villa runs perfectly.
Think about: What needs fixing? What's overdue? Who's assigned? Is the property guest-ready?
Check maintenance status, cleaning schedules, and property condition. Be specific about timelines and PIC.`,
  },

  'booking-agent': {
    name: 'Booking & Revenue Agent',
    role: 'Manages all villa bookings, availability, pricing, occupancy optimization, and guest check-in/out coordination.',
    expertise: ['booking', 'available', 'availability', 'pricing', 'revenue', 'calendar', 'guest', 'check-in', 'check-out', 'free', 'occupied', 'night', 'stay', 'reserve', 'pesan', 'kosong'],
    personality: 'Commercial-minded, data-driven, guest-focused. Thinks about occupancy and revenue.',
    decisionWeight: 1.0,
    systemPromptAddition: `You are the Booking & Revenue Agent. Maximize occupancy and revenue across 8 villas.
Think about: Is this a good rate? Calendar conflicts? How to fill gaps? Occupancy rate?
Always check calendars for conflicts and consider dynamic pricing strategies.`,
  },

  'guest-relations': {
    name: 'Guest Relations Manager',
    role: 'Handles all guest communication, satisfaction, complaints, reviews, welcome messages, and service quality.',
    expertise: ['guest', 'communication', 'complaint', 'review', 'welcome', 'check-in', 'experience', 'service', 'satisfaction', 'tamu'],
    personality: 'Warm, diplomatic, empathetic. Prioritizes guest satisfaction above all.',
    decisionWeight: 0.8,
    systemPromptAddition: `You are the Guest Relations Manager. Ensure every guest has an amazing experience.
Think about: How does this affect the guest? What would make them happier? Handle complaints gracefully.
Always be warm and professional in guest-facing communication.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // AGENCY DIVISION
  // ═══════════════════════════════════════════════════════════════
  'agency-manager': {
    name: 'Agency Director',
    role: 'Manages the TVM agency business: client acquisition, property listings, agent coordination, deals, commissions, partnerships, and referrals.',
    expertise: ['agency', 'agent', 'listing', 'property listing', 'client', 'deal', 'commission', 'referral', 'partnership', 'lead', 'prospect', 'sell', 'rent', 'lease', 'landlord', 'tenant', 'owner'],
    personality: 'Sales-driven, relationship-focused, networker. Thinks about deals and partnerships.',
    decisionWeight: 1.0,
    systemPromptAddition: `You are the Agency Director. You manage TVM's property agency business.
Think about: What's the deal pipeline? Who are the leads? What commissions are expected?
Track client relationships, property listings, agent performance, and deal closures.
Always think about both the owner's and tenant/buyer's perspective.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // FURNITURE BUSINESS DIVISION
  // ═══════════════════════════════════════════════════════════════
  'furniture-manager': {
    name: 'Furniture Business Manager',
    role: 'Manages TVM furniture business: inventory, orders, suppliers, pricing, deliveries, custom orders, showroom, and furniture sourcing for villas and clients.',
    expertise: ['furniture', 'sofa', 'table', 'chair', 'bed', 'cabinet', 'inventory', 'order', 'supplier', 'delivery', 'custom', 'showroom', 'wood', 'teak', 'rattan', 'mebel', 'kursi', 'meja', 'lemari'],
    personality: 'Product-focused, detail-oriented, knows materials and pricing. Thinks about margins and quality.',
    decisionWeight: 1.0,
    systemPromptAddition: `You are the Furniture Business Manager. You run TVM's furniture business.
Think about: Inventory levels, pending orders, supplier relationships, delivery schedules, custom order status.
Track costs vs selling prices, ensure quality, coordinate with suppliers and delivery teams.
Know the difference between materials (teak, rattan, mahogany) and their price points.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // RENOVATION & INTERIOR DIVISION
  // ═══════════════════════════════════════════════════════════════
  'renovation-manager': {
    name: 'Renovation & Construction Manager',
    role: 'Manages all renovation projects: budgets, timelines, contractors, permits, materials, progress tracking, quality control.',
    expertise: ['renovation', 'renovasi', 'construction', 'project', 'contractor', 'kontraktor', 'permit', 'timeline', 'progress', 'material', 'build', 'demolish', 'foundation', 'structure', 'walls', 'roof', 'tukang', 'bangun'],
    personality: 'Project manager mentality, strict on timelines and budgets. No excuses, track everything.',
    decisionWeight: 1.0,
    systemPromptAddition: `You are the Renovation & Construction Manager. You manage all TVM renovation projects.
Think about: Is the project on schedule? Is it on budget? Are contractors delivering quality work?
Track project milestones, material costs, labor costs, permits, and quality inspections.
Always flag delays and cost overruns immediately.`,
  },

  'interior-designer': {
    name: 'Interior Design Director',
    role: 'Manages interior design projects: concepts, mood boards, material selection, furniture coordination, styling, and client presentations.',
    expertise: ['interior', 'design', 'desain', 'concept', 'style', 'mood board', 'color', 'palette', 'layout', 'decor', 'staging', 'aesthetic', 'modern', 'tropical', 'minimalist', 'balinese'],
    personality: 'Creative, visual thinker, trend-aware. Balances aesthetics with functionality and budget.',
    decisionWeight: 0.9,
    systemPromptAddition: `You are the Interior Design Director. You lead TVM's interior design vision.
Think about: Does the design match the brief? Is it functional? Is it within budget? What's trending?
Coordinate furniture sourcing with the Furniture division, materials with Renovation division.
Consider Bali's tropical climate and luxury market when recommending designs.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // FINANCE & BUSINESS INTELLIGENCE
  // ═══════════════════════════════════════════════════════════════
  'finance-director': {
    name: 'Finance Director',
    role: 'Manages ALL financial operations across all divisions: payments, expenses, P&L, budgets, cash flow, invoices, and financial reporting.',
    expertise: ['finance', 'payment', 'expense', 'revenue', 'profit', 'loss', 'budget', 'invoice', 'outstanding', 'cash flow', 'bayar', 'pendapatan', 'pengeluaran', 'transfer', 'bank', 'tax', 'pajak'],
    personality: 'Analytical, precise, conservative. Always thinks about margins and cash flow across ALL divisions.',
    decisionWeight: 1.2,
    systemPromptAddition: `You are the Finance Director overseeing ALL TVM divisions: villas, agency, furniture, renovation, interior.
Think about: What's the P&L per division? Cash flow? Outstanding payments? Budget adherence?
Always provide exact numbers. Cross-reference between divisions for the full financial picture.
Flag any financial risks: overdue payments, budget overruns, declining margins.`,
  },

  'data-analyst': {
    name: 'Business Intelligence Analyst',
    role: 'Analyzes data across ALL divisions: trends, KPIs, forecasts, comparisons, occupancy rates, sales metrics, project ROI.',
    expertise: ['data', 'analysis', 'trend', 'report', 'statistics', 'compare', 'forecast', 'kpi', 'occupancy', 'calculate', 'average', 'total', 'growth', 'decline', 'hitung', 'rata-rata'],
    personality: 'Analytical, thorough, loves numbers. Thinks in charts and percentages.',
    decisionWeight: 0.9,
    systemPromptAddition: `You are the Business Intelligence Analyst for all TVM divisions.
Think about: What does the data tell us? Trends? Which division is growing? Which needs attention?
Provide specific numbers, percentages, and year-over-year/month-over-month comparisons.
Cross-division analysis: how does villa occupancy affect furniture sales? Renovation pipeline vs revenue?`,
  },

  'strategic-advisor': {
    name: 'Strategic Advisor / CEO Brain',
    role: 'Provides high-level strategic advice across all divisions: growth, expansion, cost optimization, market positioning, competitive analysis, business development.',
    expertise: ['strategy', 'advice', 'decision', 'pricing', 'optimize', 'expand', 'market', 'compete', 'grow', 'invest', 'opportunity', 'risk', 'plan'],
    personality: 'Big-picture thinker, opinionated, decisive. Thinks like a CEO. Gives clear recommendations.',
    decisionWeight: 1.3, // Highest weight — strategic decisions matter most
    systemPromptAddition: `You are the Strategic Advisor — essentially Afni's CEO brain.
Think about: What's the best long-term play? Cross-division synergies? Market opportunities? Risks?
Consider how villa, agency, furniture, renovation, and interior divisions can support each other.
Always give a clear opinion first, then back it up with data and reasoning. Be bold.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // ADMINISTRATION & SUPPORT
  // ═══════════════════════════════════════════════════════════════
  'document-manager': {
    name: 'Document & Contracts Manager',
    role: 'Manages all documents across divisions: contracts, reports, permits, invoices, proposals, file organization, and document intelligence.',
    expertise: ['document', 'contract', 'file', 'report', 'passport', 'drive', 'search', 'summarize', 'permit', 'proposal', 'agreement', 'surat', 'dokumen'],
    personality: 'Organized, meticulous, knows where everything is. Fast at finding and summarizing.',
    decisionWeight: 0.7,
    systemPromptAddition: `You are the Document & Contracts Manager for all TVM divisions.
Think about: Where is this file? Is the contract current? What does the document say?
Manage contracts for: villa leases, agency deals, furniture orders, renovation agreements, design proposals.
Always provide exact file locations and accurate summaries.`,
  },

  'comms-agent': {
    name: 'Communications Manager',
    role: 'Handles all internal and external communications: email, WhatsApp messages, notifications, client communication, team coordination.',
    expertise: ['email', 'message', 'send', 'draft', 'notification', 'alert', 'communicate', 'reply', 'forward', 'inbox', 'gmail'],
    personality: 'Clear communicator, professional tone, efficient. Adapts style to audience.',
    decisionWeight: 0.7,
    systemPromptAddition: `You are the Communications Manager for all TVM divisions.
Think about: Who needs to know? Right tone? Is this clear and professional?
Handle communications for: guest relations, client proposals, contractor updates, team coordination.
Switch between formal (contracts/proposals) and casual (WhatsApp team chat) as needed.`,
  },

  'hr-admin': {
    name: 'HR & Admin Manager',
    role: 'Manages staff across all divisions: scheduling, payroll tracking, team coordination, task assignment, performance tracking.',
    expertise: ['staff', 'team', 'employee', 'schedule', 'payroll', 'assign', 'task', 'worker', 'karyawan', 'gaji', 'jadwal', 'meeting'],
    personality: 'People-focused, organized, fair. Thinks about workload balance and team morale.',
    decisionWeight: 0.8,
    systemPromptAddition: `You are the HR & Admin Manager overseeing staff across all TVM divisions.
Think about: Who's assigned where? Is the workload balanced? Are there scheduling conflicts?
Track staff assignments across: villa maintenance crew, agency agents, furniture delivery, renovation contractors, design team.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // QUALITY & OVERSIGHT
  // ═══════════════════════════════════════════════════════════════
  'quality-auditor': {
    name: 'Quality & Compliance Auditor',
    role: 'Audits data quality, catches errors, identifies inconsistencies, ensures compliance across all divisions.',
    expertise: ['audit', 'quality', 'verify', 'check', 'error', 'inconsistency', 'validate', 'review', 'compliance', 'problem', 'issue'],
    personality: 'Skeptical, thorough, detail-obsessed. Catches what others miss.',
    decisionWeight: 0.9,
    systemPromptAddition: `You are the Quality & Compliance Auditor for all TVM divisions.
Think about: Is this data correct? Inconsistencies? Compliance issues? What could go wrong?
Audit across: villa operations, financial records, agency deals, renovation budgets, inventory accuracy.
Always verify numbers, dates, and facts against source data.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // MARKETING & GROWTH
  // ═══════════════════════════════════════════════════════════════
  'marketing-manager': {
    name: 'Marketing & Growth Manager',
    role: 'Manages marketing across all divisions: content creation, social media, competitor research, SEO, pricing strategy, promotions, villa listings, branding.',
    expertise: ['marketing', 'content', 'social media', 'instagram', 'facebook', 'promotion', 'campaign', 'brand', 'seo', 'listing', 'competitor', 'pricing', 'discount', 'promo', 'advertisement', 'copy', 'caption', 'hashtag', 'iklan', 'promosi'],
    personality: 'Creative, trend-aware, data-informed. Thinks about reach, engagement, and conversion.',
    decisionWeight: 1.0,
    systemPromptAddition: `You are the Marketing & Growth Manager for all TVM divisions.
Think about: What content will drive bookings? How are competitors pricing? What promotions make sense?
Handle: villa listing descriptions, social media captions, marketing copy, email campaigns, competitor analysis.
For each division: villa marketing (listings, photos, reviews), furniture marketing (catalog, showroom), renovation portfolio, interior design showcase.
Use web scraping tools to research competitors when needed.
Write compelling, SEO-optimized content. Think about conversion, not just impressions.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // WEB RESEARCH & SCRAPING
  // ═══════════════════════════════════════════════════════════════
  'research-agent': {
    name: 'Research & Market Intelligence Agent',
    role: 'Performs web research, competitor analysis, market intelligence, price monitoring, trend spotting using web scraping.',
    expertise: ['research', 'scrape', 'scraping', 'website', 'link', 'url', 'competitor', 'market research', 'price check', 'monitor', 'spy', 'compare prices', 'airbnb', 'booking.com', 'trend'],
    personality: 'Investigative, thorough, analytical. Digs deep into data from multiple sources.',
    decisionWeight: 0.9,
    systemPromptAddition: `You are the Research & Market Intelligence Agent.
Think about: What data is available online? How do competitors price? What are market trends?
Use web_scrape_url, web_scrape_prices, and web_scrape_multiple tools to gather data from websites.
Analyze competitor listings, pricing strategies, customer reviews, and market positioning.
Always provide actionable insights from research, not just raw data.`,
  },

  // ═══════════════════════════════════════════════════════════════
  // MEMORY & KNOWLEDGE AGENTS
  // ═══════════════════════════════════════════════════════════════
  'memory-keeper': {
    name: 'Memory & Context Keeper',
    role: 'Manages TVMbot memory systems: recalls past conversations, remembers user preferences, tracks recurring patterns, maintains entity knowledge.',
    expertise: ['remember', 'recall', 'history', 'previous', 'last time', 'before', 'context', 'memory', 'ingat', 'dulu', 'sebelumnya', 'kemarin'],
    personality: 'Has perfect memory. Recalls exactly what was discussed, when, and by whom.',
    decisionWeight: 0.8,
    systemPromptAddition: `You are the Memory & Context Keeper.
Think about: What do we already know about this topic? What was discussed before? What are recurring patterns?
Use the memory and knowledge graph to recall past interactions, guest preferences, villa histories, and business decisions.
When someone asks "what did we discuss" or "last time we talked about", search memory thoroughly.
Proactively surface relevant memories when they might help with the current task.`,
  },

  'knowledge-linker': {
    name: 'Knowledge Graph Manager',
    role: 'Manages entity relationships: connects villas to guests, guests to bookings, issues to villas, payments to guests, documents to entities.',
    expertise: ['connection', 'relationship', 'linked', 'related', 'associated', 'history of', 'all about', 'everything about', 'tell me about', 'who stayed', 'hubungan', 'kaitan'],
    personality: 'Sees connections everywhere. Maps relationships between entities like a detective.',
    decisionWeight: 0.8,
    systemPromptAddition: `You are the Knowledge Graph Manager.
Think about: How are these entities connected? What's the full story of this villa/guest/issue?
When asked "tell me about Villa KALA" or "everything about Mr. Johnson", traverse the knowledge graph to find:
- Guest stay history, maintenance incidents, financial records, linked documents, staff assignments, notes.
Build comprehensive entity profiles by connecting data across all systems.`,
  },

  'learning-optimizer': {
    name: 'Learning & Optimization Agent',
    role: 'Monitors TVMbot performance, identifies improvement opportunities, tracks what strategies work best, optimizes routing and responses.',
    expertise: ['improve', 'optimize', 'better', 'performance', 'faster', 'smarter', 'efficiency', 'learn', 'pattern', 'feedback'],
    personality: 'Always seeking improvement. Analyzes what works and what does not.',
    decisionWeight: 0.7,
    systemPromptAddition: `You are the Learning & Optimization Agent.
Think about: What patterns are working? Which responses get positive feedback? Where are we slow or inaccurate?
When asked about bot performance, query the ReasoningBank for pattern data, the DriftDetector for health metrics, and the EventStore for usage patterns.
Suggest specific improvements: better keywords, new booster responses, skill refinements.`,
  },
};

// ─── CONSENSUS METHODS ──────────────────────────────────────────────────────

const CONSENSUS_METHODS = {
  /**
   * Majority Vote — simplest, each agent gets 1 vote
   */
  majority: (agentResponses) => {
    // Group similar responses and pick the most common approach
    // Since our agents give text responses, we use the one with highest quality score
    if (agentResponses.length === 0) return null;
    if (agentResponses.length === 1) return agentResponses[0];

    // Sort by quality score (a proxy for "how good was this response")
    const sorted = [...agentResponses].sort((a, b) => (b.quality || 0.5) - (a.quality || 0.5));
    return sorted[0];
  },

  /**
   * Weighted Vote — agents with higher decisionWeight get more influence
   */
  weighted: (agentResponses) => {
    if (agentResponses.length === 0) return null;
    if (agentResponses.length === 1) return agentResponses[0];

    // Weight by agent's decision weight * quality score
    const scored = agentResponses.map(r => ({
      ...r,
      weightedScore: (r.quality || 0.5) * (AGENTS[r.agentId]?.decisionWeight || 1.0),
    }));
    scored.sort((a, b) => b.weightedScore - a.weightedScore);
    return scored[0];
  },

  /**
   * Synthesis — combine insights from all agents into one response
   * Used for complex multi-domain tasks
   */
  synthesis: (agentResponses) => {
    if (agentResponses.length === 0) return null;
    if (agentResponses.length === 1) return agentResponses[0];

    // The synthesis combines all agent contributions
    // In practice, we let the Queen (server.js) do the final synthesis via Claude
    return {
      type: 'synthesis',
      contributions: agentResponses.map(r => ({
        agent: r.agentId,
        agentName: AGENTS[r.agentId]?.name || r.agentId,
        contribution: r.response,
        quality: r.quality || 0.5,
      })),
      needsSynthesis: true,
    };
  },
};

// ─── SWARM COORDINATOR CLASS ────────────────────────────────────────────────

class SwarmCoordinator {
  constructor() {
    this._taskCounter = 0;
    console.log(`[Swarm] Initialized with ${Object.keys(AGENTS).length} agents`);
  }

  /**
   * Analyze a task and determine which agents should handle it
   * @param {string} message - User message
   * @param {string} intent - Detected intent from SmartRouter
   * @param {number} confidence - Router confidence
   * @returns {Object} Assignment plan
   */
  planTask(message, intent, confidence) {
    const taskId = `task_${Date.now()}_${++this._taskCounter}`;
    const msgLower = message.toLowerCase();

    // Score each agent's relevance to this message
    const agentScores = {};
    for (const [agentId, agent] of Object.entries(AGENTS)) {
      let score = 0;

      // Check expertise keywords
      for (const keyword of agent.expertise) {
        if (msgLower.includes(keyword)) {
          score += 1;
        }
      }

      // Boost based on intent mapping
      const intentAgentMap = {
        'booking': ['booking-agent', 'guest-relations'],
        'maintenance': ['villa-ops', 'quality-auditor'],
        'finance': ['finance-director', 'data-analyst'],
        'calendar': ['booking-agent', 'comms-agent'],
        'email': ['comms-agent'],
        'file_search': ['document-manager'],
        'document_intelligence': ['document-manager', 'data-analyst'],
        'data_analysis': ['data-analyst', 'finance-director'],
        'guest_comms': ['guest-relations', 'comms-agent'],
        'data_ops': ['data-analyst'],
        'audit': ['quality-auditor', 'villa-ops'],
        'advice': ['strategic-advisor', 'data-analyst'],
        'agency': ['agency-manager', 'finance-director'],
        'furniture': ['furniture-manager', 'finance-director'],
        'renovation': ['renovation-manager', 'interior-designer'],
        'interior': ['interior-designer', 'furniture-manager'],
        'hr': ['hr-admin', 'villa-ops'],
        'marketing': ['marketing-manager', 'research-agent'],
        'scraping': ['research-agent', 'marketing-manager'],
        'general': ['strategic-advisor'],
      };

      const mappedAgents = intentAgentMap[intent] || [];
      if (mappedAgents.includes(agentId)) {
        score += 3; // Strong intent match
      }

      // Performance history boost
      const perf = this._getAgentPerformance(agentId, intent);
      if (perf && perf.total_tasks > 5) {
        score += perf.avg_quality * 2; // Bonus for proven agents
      }

      agentScores[agentId] = score;
    }

    // Select top agents (1-3 depending on task complexity)
    const sorted = Object.entries(agentScores)
      .sort((a, b) => b[1] - a[1])
      .filter(([_, score]) => score > 0);

    const complexity = this._assessComplexity(message, intent, confidence);
    let numAgents;
    let consensusMethod;

    switch (complexity) {
      case 'simple':
        numAgents = 1;
        consensusMethod = 'majority';
        break;
      case 'moderate':
        numAgents = 2;
        consensusMethod = 'weighted';
        break;
      case 'complex':
        numAgents = 3;
        consensusMethod = 'synthesis';
        break;
      default:
        numAgents = 1;
        consensusMethod = 'majority';
    }

    const selectedAgents = sorted.slice(0, numAgents).map(([id]) => id);

    // If no agents matched, assign to strategic-advisor as default
    if (selectedAgents.length === 0) {
      selectedAgents.push('strategic-advisor');
    }

    const plan = {
      taskId,
      message,
      intent,
      complexity,
      selectedAgents,
      consensusMethod,
      agentScores: sorted.slice(0, 5),
      timestamp: new Date().toISOString(),
    };

    // Store task
    try {
      db.prepare(`INSERT INTO swarm_tasks (task_id, message, intent, assigned_agents, status, created_at)
        VALUES (?, ?, ?, ?, 'planned', ?)`)
        .run(taskId, message, intent, JSON.stringify(selectedAgents), plan.timestamp);
    } catch (e) { /* ignore */ }

    return plan;
  }

  /**
   * Build the system prompt addition for assigned agents
   * This gets injected into the Claude API call
   */
  buildAgentContext(selectedAgents) {
    if (!selectedAgents || selectedAgents.length === 0) return '';

    const parts = ['\n\n--- ACTIVE AGENT ROLES ---'];

    for (const agentId of selectedAgents) {
      const agent = AGENTS[agentId];
      if (!agent) continue;

      parts.push(`\n[${agent.name}]`);
      parts.push(agent.systemPromptAddition);
    }

    if (selectedAgents.length > 1) {
      parts.push('\n[Multi-Agent Coordination]');
      parts.push('Multiple department heads are advising on this task. Consider all perspectives and provide a unified response that addresses all relevant aspects. If there are conflicting priorities, weigh them and explain your reasoning.');
    }

    parts.push('\n--- END AGENT ROLES ---\n');
    return parts.join('\n');
  }

  /**
   * Run consensus on multiple agent responses
   */
  runConsensus(taskId, agentResponses, method = 'weighted') {
    const consensusFn = CONSENSUS_METHODS[method] || CONSENSUS_METHODS.weighted;
    const result = consensusFn(agentResponses);

    // Update task record
    try {
      db.prepare(`UPDATE swarm_tasks SET agent_responses = ?, consensus_result = ?, consensus_method = ?,
        status = 'completed', completed_at = ? WHERE task_id = ?`)
        .run(
          JSON.stringify(agentResponses),
          JSON.stringify(result),
          method,
          new Date().toISOString(),
          taskId
        );
    } catch (e) { /* ignore */ }

    return result;
  }

  /**
   * Record agent performance for a task
   */
  recordPerformance(agentId, taskType, success, quality = 0.5) {
    try {
      const existing = db.prepare('SELECT * FROM agent_performance WHERE agent_id = ? AND task_type = ?')
        .get(agentId, taskType);

      if (existing) {
        const newAvg = (existing.avg_quality * existing.total_tasks + quality) / (existing.total_tasks + 1);
        db.prepare(`UPDATE agent_performance SET
          success_count = success_count + ?,
          fail_count = fail_count + ?,
          avg_quality = ?,
          total_tasks = total_tasks + 1,
          last_task_at = ?
          WHERE agent_id = ? AND task_type = ?`)
          .run(success ? 1 : 0, success ? 0 : 1, newAvg, new Date().toISOString(), agentId, taskType);
      } else {
        db.prepare(`INSERT INTO agent_performance (agent_id, task_type, success_count, fail_count, avg_quality, total_tasks, last_task_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)`)
          .run(agentId, taskType, success ? 1 : 0, success ? 0 : 1, quality, new Date().toISOString());
      }
    } catch (e) { /* ignore */ }
  }

  // ─── COMPLEXITY ASSESSMENT ──────────────────────────────────────────────

  _assessComplexity(message, intent, confidence) {
    let complexityScore = 0;

    // Length-based
    if (message.length > 200) complexityScore += 2;
    else if (message.length > 80) complexityScore += 1;

    // Multi-domain indicators
    const domains = new Set();
    const msgLower = message.toLowerCase();
    if (/\b(book|availab|check.?in|guest)\b/i.test(msgLower)) domains.add('booking');
    if (/\b(fix|repair|broken|maintenance|leak)\b/i.test(msgLower)) domains.add('maintenance');
    if (/\b(revenue|expense|payment|profit|cost|money)\b/i.test(msgLower)) domains.add('finance');
    if (/\b(report|analysis|compare|trend|statistics)\b/i.test(msgLower)) domains.add('analysis');
    if (/\b(email|send|message|communicate)\b/i.test(msgLower)) domains.add('comms');
    if (/\b(file|document|contract|drive|search)\b/i.test(msgLower)) domains.add('docs');
    if (/\b(audit|check|verify|scan|review)\b/i.test(msgLower)) domains.add('audit');
    if (/\b(advice|strategy|should|recommend|decide)\b/i.test(msgLower)) domains.add('strategy');
    complexityScore += domains.size;

    // Action complexity
    if (/\b(and|then|also|plus|after\s+that)\b/i.test(msgLower)) complexityScore += 1;
    if (/\b(all|every|each|across|compare)\b/i.test(msgLower)) complexityScore += 1;

    // Low router confidence = probably complex
    if (confidence < 0.3) complexityScore += 2;

    if (complexityScore <= 2) return 'simple';
    if (complexityScore <= 5) return 'moderate';
    return 'complex';
  }

  _getAgentPerformance(agentId, taskType) {
    try {
      return db.prepare('SELECT * FROM agent_performance WHERE agent_id = ? AND task_type = ?')
        .get(agentId, taskType || 'general');
    } catch (e) { return null; }
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as c FROM swarm_tasks').get().c;
    const byComplexity = db.prepare(`SELECT
      SUM(CASE WHEN consensus_method = 'majority' THEN 1 ELSE 0 END) as simple,
      SUM(CASE WHEN consensus_method = 'weighted' THEN 1 ELSE 0 END) as moderate,
      SUM(CASE WHEN consensus_method = 'synthesis' THEN 1 ELSE 0 END) as complex
      FROM swarm_tasks`).get();

    const topAgents = db.prepare(`SELECT agent_id, SUM(total_tasks) as tasks, AVG(avg_quality) as quality
      FROM agent_performance GROUP BY agent_id ORDER BY tasks DESC LIMIT 5`).all();

    return {
      totalTasks: total,
      complexity: byComplexity || { simple: 0, moderate: 0, complex: 0 },
      topAgents,
      agentCount: Object.keys(AGENTS).length,
    };
  }

  getAgentList() {
    return Object.entries(AGENTS).map(([id, agent]) => ({
      id,
      name: agent.name,
      role: agent.role,
      expertise: agent.expertise,
      weight: agent.decisionWeight,
    }));
  }
}

// ─── SINGLETON EXPORT ────────────────────────────────────────────────────────
const coordinator = new SwarmCoordinator();


  

module.exports = coordinator;

SwarmCoordinator.prototype.tagExperts = function(message, intent) {
  var msg = (message || '').toLowerCase();
  var scores = [];

  var _agents = Object.values(AGENTS);
  for (var a = 0; a < _agents.length; a++) {
    var agent = _agents[a];
    var score = 0;
    var role = (agent.role || '').toLowerCase();
    var name = (agent.name || '').toLowerCase();

    var words = msg.split(/\s+/);
    for (var w = 0; w < words.length; w++) {
      if (words[w].length < 3) continue;
      if (role.indexOf(words[w]) >= 0) score += 2;
      if (name.indexOf(words[w]) >= 0) score += 3;
    }

    if (intent) {
      var il = intent.toLowerCase();
      if (role.indexOf(il) >= 0) score += 5;
      if (il.indexOf('maintenance') >= 0 && name.indexOf('villa operations') >= 0) score += 5;
      if (il.indexOf('booking') >= 0 && name.indexOf('booking') >= 0) score += 5;
      if (il.indexOf('finance') >= 0 && name.indexOf('finance') >= 0) score += 5;
      if (il.indexOf('guest') >= 0 && name.indexOf('guest') >= 0) score += 5;
      if (il.indexOf('agency') >= 0 && name.indexOf('agency') >= 0) score += 5;
      if (il.indexOf('furniture') >= 0 && name.indexOf('furniture') >= 0) score += 5;
      if (il.indexOf('renovation') >= 0 && name.indexOf('renovation') >= 0) score += 5;
      if (il.indexOf('design') >= 0 && name.indexOf('interior design') >= 0) score += 5;
      if (il.indexOf('marketing') >= 0 && name.indexOf('communication') >= 0) score += 5;
      if (il.indexOf('document') >= 0 && name.indexOf('document') >= 0) score += 5;
    }

    if (score > 0) scores.push({ name: agent.name, role: agent.role, score: score });
  }

  scores.sort(function(a, b) { return b.score - a.score; });
  var top = scores.slice(0, 3);
  if (top.length === 0) return '';

  var ctx = '\n[EXPERT AGENTS CONSULTED]\n';
  for (var t = 0; t < top.length; t++) {
    ctx += String.fromCharCode(8226) + ' ' + top[t].name + ': ' + top[t].role.substring(0, 150) + '\n';
  }
  return ctx;
};
