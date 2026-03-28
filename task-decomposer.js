/**
 * task-decomposer.js — Task Decomposition Engine for TVMbot
 * Inspired by ruflo's delegation pattern + agentic-flow subtask system
 *
 * Breaks complex multi-step requests into atomic subtasks:
 *   "Give me a full report of all villas: bookings, maintenance, and revenue"
 *   → Subtask 1: Fetch booking data for all 8 villas
 *   → Subtask 2: Fetch maintenance status for all 8 villas
 *   → Subtask 3: Fetch revenue data for all 8 villas
 *   → Subtask 4: Compile and format the report
 *
 * This helps Claude execute complex requests more reliably by giving it
 * a clear step-by-step plan in the system prompt.
 */

'use strict';

// ─── DECOMPOSITION PATTERNS ─────────────────────────────────────────────────

const DECOMPOSITION_RULES = [
  {
    name: 'multi-villa-query',
    description: 'Query about multiple or all villas',
    detect: (msg) => /\b(all\s+villas?|every\s+villa|each\s+villa|semua\s+villa|across\s+villas?)\b/i.test(msg),
    decompose: (msg, context) => {
      const villas = ['ANN', 'DIANE', 'KALA', 'LOUNA', 'NISSA', 'LYMA', 'LIAN', 'LYSA'];
      const action = detectAction(msg);
      return {
        description: `${action} across all 8 villas`,
        steps: [
          ...villas.map(v => ({ action: `${action} for Villa ${v}`, villa: v, parallel: true })),
          { action: 'Compile results into a clear summary table', parallel: false },
        ],
        strategy: 'parallel-then-combine',
      };
    },
  },

  {
    name: 'multi-domain-report',
    description: 'Report spanning multiple business domains',
    detect: (msg) => {
      const domains = ['booking', 'maintenance', 'revenue', 'expense', 'financial', 'occupancy', 'cleaning'];
      const count = domains.filter(d => msg.toLowerCase().includes(d)).length;
      return count >= 2 || /\b(full\s+report|complete\s+report|everything|overview|status\s+report|all\s+data)\b/i.test(msg);
    },
    decompose: (msg, context) => {
      const steps = [];
      const msgLower = msg.toLowerCase();
      if (/booking|occupancy|availability/i.test(msgLower)) steps.push({ action: 'Fetch booking/occupancy data from calendars', domain: 'booking' });
      if (/maintenance|repair|issue/i.test(msgLower)) steps.push({ action: 'Fetch open maintenance tasks from maintenance sheet', domain: 'maintenance' });
      if (/revenue|income|payment/i.test(msgLower)) steps.push({ action: 'Fetch revenue data from Staff Sheet (Income tab)', domain: 'revenue' });
      if (/expense|cost|spending/i.test(msgLower)) steps.push({ action: 'Fetch expense data from Expenses Sheet', domain: 'expense' });
      if (/financial|profit|loss|p&?l/i.test(msgLower)) {
        steps.push({ action: 'Fetch revenue data', domain: 'revenue' });
        steps.push({ action: 'Fetch expense data', domain: 'expense' });
        steps.push({ action: 'Calculate profit/loss (revenue - expenses)', domain: 'calculation' });
      }
      if (steps.length === 0) {
        // "full report" or "everything" — include all
        steps.push({ action: 'Fetch booking/occupancy data', domain: 'booking' });
        steps.push({ action: 'Fetch open maintenance tasks', domain: 'maintenance' });
        steps.push({ action: 'Fetch revenue data', domain: 'revenue' });
        steps.push({ action: 'Fetch expense data', domain: 'expense' });
      }
      steps.push({ action: 'Compile all data into a formatted report', domain: 'output' });
      return {
        description: 'Multi-domain report',
        steps,
        strategy: 'sequential',
      };
    },
  },

  {
    name: 'comparison-query',
    description: 'Comparing metrics between villas, months, or divisions',
    detect: (msg) => /\b(compare|comparison|versus|vs\.?|which\s+(villa|one)\s+(is|has)|rank|ranking|top|best|worst)\b/i.test(msg),
    decompose: (msg) => {
      return {
        description: 'Comparison analysis',
        steps: [
          { action: 'Identify what is being compared (villas? months? divisions?)' },
          { action: 'Fetch data for all comparison subjects' },
          { action: 'Calculate relevant metrics for each subject' },
          { action: 'Rank and compare the results' },
          { action: 'Present findings with clear winner/loser and insights' },
        ],
        strategy: 'sequential',
      };
    },
  },

  {
    name: 'create-and-notify',
    description: 'Creating something then notifying people',
    detect: (msg) => /\b(create|add|log|report|book).*\b(and|then)\b.*(send|email|notify|alert|tell|inform)/i.test(msg),
    decompose: (msg) => {
      return {
        description: 'Create record then notify',
        steps: [
          { action: 'Create/log the requested record (booking, maintenance task, expense, etc.)' },
          { action: 'Verify the record was created successfully' },
          { action: 'Send notification (email, WhatsApp message, or calendar event)' },
          { action: 'Confirm both actions completed' },
        ],
        strategy: 'sequential',
      };
    },
  },

  {
    name: 'find-and-analyze',
    description: 'Finding a document then doing something with it',
    detect: (msg) => /\b(find|search|get)\b.*\b(and|then)\b.*(summarize|read|analyze|send|extract|compare)/i.test(msg),
    decompose: (msg) => {
      return {
        description: 'Find document then analyze',
        steps: [
          { action: 'Search Google Drive for the requested document' },
          { action: 'Read/download the document content' },
          { action: 'Perform the requested analysis (summarize, extract, compare)' },
          { action: 'Present results' },
        ],
        strategy: 'sequential',
      };
    },
  },

  {
    name: 'audit-request',
    description: 'Auditing across multiple systems',
    detect: (msg) => /\b(audit|check\s+everything|scan|verify\s+all|health\s+check|full\s+check)\b/i.test(msg),
    decompose: (msg) => {
      return {
        description: 'Cross-system audit',
        steps: [
          { action: 'Check maintenance sheet for: incomplete records, stale tasks, missing PIC' },
          { action: 'Check calendars for: double bookings, overlapping dates' },
          { action: 'Check financial data for: missing amounts, unreconciled payments' },
          { action: 'Cross-reference: maintenance tasks vs. upcoming bookings (conflicts?)' },
          { action: 'Compile findings by severity: CRITICAL → WARNING → INFO' },
        ],
        strategy: 'sequential',
      };
    },
  },

  {
    name: 'cross-division-query',
    description: 'Query spanning multiple TVM divisions',
    detect: (msg) => {
      const divisions = ['villa', 'agency', 'furniture', 'renovation', 'interior', 'mebel', 'renovasi', 'desain'];
      const count = divisions.filter(d => msg.toLowerCase().includes(d)).length;
      return count >= 2 || /\b(all\s+divisions?|across\s+divisions?|every\s+division|company.wide|total\s+business)\b/i.test(msg);
    },
    decompose: (msg) => {
      return {
        description: 'Cross-division analysis',
        steps: [
          { action: 'Identify which divisions are involved' },
          { action: 'Fetch relevant data from each division\'s systems' },
          { action: 'Analyze inter-division relationships and synergies' },
          { action: 'Present unified view with per-division breakdown' },
        ],
        strategy: 'sequential',
      };
    },
  },
];

// ─── HELPER ──────────────────────────────────────────────────────────────────

function detectAction(msg) {
  const msgLower = msg.toLowerCase();
  if (/\b(booking|occupancy|available|free)\b/.test(msgLower)) return 'Check bookings/availability';
  if (/\b(maintenance|repair|issue|broken)\b/.test(msgLower)) return 'Check maintenance status';
  if (/\b(revenue|income|payment|financial)\b/.test(msgLower)) return 'Fetch revenue data';
  if (/\b(expense|cost|spending)\b/.test(msgLower)) return 'Fetch expense data';
  if (/\b(cleaning|schedule)\b/.test(msgLower)) return 'Check cleaning schedule';
  return 'Fetch data';
}

// ─── TASK DECOMPOSER CLASS ──────────────────────────────────────────────────

class TaskDecomposer {
  constructor() {
    console.log(`[TaskDecomposer] Initialized with ${DECOMPOSITION_RULES.length} decomposition rules`);
  }

  /**
   * Analyze a message and decompose if complex
   * @returns {{ isComplex: boolean, plan: Object|null, promptAddition: string }}
   */
  analyze(message, context = {}) {
    const cleanMsg = message
      .replace(/\[WhatsApp.*?\]/gi, '')
      .replace(/\[Replying to:.*?\]/gi, '')
      .trim();

    for (const rule of DECOMPOSITION_RULES) {
      if (rule.detect(cleanMsg)) {
        const plan = rule.decompose(cleanMsg, context);
        return {
          isComplex: true,
          ruleName: rule.name,
          plan,
          promptAddition: this._buildPrompt(plan),
        };
      }
    }

    return { isComplex: false, plan: null, promptAddition: '' };
  }

  /**
   * Build a system prompt addition from the decomposition plan
   */
  _buildPrompt(plan) {
    if (!plan || !plan.steps || plan.steps.length === 0) return '';

    const parts = ['\n--- TASK PLAN ---'];
    parts.push(`Task: ${plan.description}`);
    parts.push(`Strategy: ${plan.strategy}`);
    parts.push('Steps:');
    plan.steps.forEach((step, i) => {
      const parallel = step.parallel ? ' [can run in parallel]' : '';
      parts.push(`  ${i + 1}. ${step.action}${parallel}`);
    });
    parts.push('Execute these steps IN ORDER. Report progress and results for each step.');
    parts.push('--- END TASK PLAN ---\n');

    return parts.join('\n');
  }
}

const taskDecomposer = new TaskDecomposer();
module.exports = taskDecomposer;
module.exports.TaskDecomposer = TaskDecomposer;
module.exports.DECOMPOSITION_RULES = DECOMPOSITION_RULES;
