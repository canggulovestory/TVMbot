// supervisor.js — Quality Control & Risk Validation Layer for TVMbot PEMS
// Validates plans and results before/after execution to prevent costly mistakes

const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Risk Levels ───────────────────────────────────────────────────────────────
const RISK = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// ─── Tool Risk Map ─────────────────────────────────────────────────────────────
const TOOL_RISK = {
  gmail_list_messages:      RISK.LOW,
  gmail_read_message:       RISK.LOW,
  gmail_get_flagged:        RISK.LOW,
  calendar_get_events:      RISK.LOW,
  calendar_check_availability: RISK.LOW,
  drive_search_files:       RISK.LOW,
  drive_get_recent:         RISK.LOW,
  drive_find_passport:      RISK.LOW,
  drive_create_folder:      RISK.LOW,
  docs_read_document:       RISK.LOW,
  sheets_read_data:         RISK.LOW,
  get_owner_profile:        RISK.LOW,
  cleaning_generate_schedule: RISK.LOW,
  marketing_generate_content: RISK.LOW,
  save_note:                RISK.LOW,

  docs_create_document:     RISK.MEDIUM,
  sheets_append_row:        RISK.MEDIUM,

  gmail_send_message:       RISK.HIGH,
  calendar_create_event:    RISK.HIGH,
  docs_create_contract:     RISK.HIGH,
  docs_update_document:     RISK.HIGH,
  sheets_write_data:        RISK.HIGH,
};

// ─── Plan Pre-Validation ───────────────────────────────────────────────────────
// Checks the plan BEFORE execution starts
function validatePlan(plan, memoryContext = '') {
  const issues = [];
  const warnings = [];
  let overallRisk = RISK.LOW;

  if (!plan || !plan.steps || plan.steps.length === 0) {
    issues.push('Plan has no executable steps');
    return { approved: false, issues, warnings, risk: RISK.HIGH };
  }

  for (const step of plan.steps) {
    if (!step.action) {
      issues.push(`Step ${step.step}: missing action`);
      continue;
    }

    if (step.action === 'respond') continue;

    const risk = TOOL_RISK[step.action] || RISK.LOW;

    // Escalate overall risk
    if (risk === RISK.CRITICAL) overallRisk = RISK.CRITICAL;
    else if (risk === RISK.HIGH && overallRisk !== RISK.CRITICAL) overallRisk = RISK.HIGH;
    else if (risk === RISK.MEDIUM && overallRisk === RISK.LOW) overallRisk = RISK.MEDIUM;

    // Check email sends for recipient validity
    if (step.action === 'gmail_send_message') {
      const { to, subject, body } = step.params || {};
      if (!to) issues.push(`Step ${step.step}: gmail_send_message missing 'to' address`);
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) issues.push(`Step ${step.step}: invalid email address: ${to}`);
      if (!subject) warnings.push(`Step ${step.step}: email has no subject`);
      if (!body || body.length < 10) issues.push(`Step ${step.step}: email body is too short`);
    }

    // Check contract creation
    if (step.action === 'docs_create_contract') {
      const { guestName, villaName, checkIn, checkOut, price } = step.params || {};
      if (!guestName) issues.push(`Step ${step.step}: contract missing guestName`);
      if (!villaName) issues.push(`Step ${step.step}: contract missing villaName`);
      if (!checkIn || !checkOut) issues.push(`Step ${step.step}: contract missing check-in or check-out dates`);
      if (!price) warnings.push(`Step ${step.step}: contract has no price specified`);

      // Date validation
      if (checkIn && checkOut) {
        const inDate = new Date(checkIn);
        const outDate = new Date(checkOut);
        if (isNaN(inDate.getTime())) issues.push(`Step ${step.step}: invalid checkIn date: ${checkIn}`);
        if (isNaN(outDate.getTime())) issues.push(`Step ${step.step}: invalid checkOut date: ${checkOut}`);
        if (inDate >= outDate) issues.push(`Step ${step.step}: check-out must be after check-in`);
        if (inDate < new Date()) warnings.push(`Step ${step.step}: check-in date is in the past`);
      }
    }

    // Check calendar events
    if (step.action === 'calendar_create_event') {
      const { summary, startTime, endTime } = step.params || {};
      if (!summary) warnings.push(`Step ${step.step}: calendar event has no title`);
      if (!startTime || !endTime) issues.push(`Step ${step.step}: calendar event missing start or end time`);
      if (startTime && endTime) {
        const start = new Date(startTime);
        const end = new Date(endTime);
        if (start >= end) issues.push(`Step ${step.step}: event end time must be after start time`);
      }
    }

    // Check sheets writes
    if (step.action === 'sheets_write_data' || step.action === 'sheets_append_row') {
      const { spreadsheetId } = step.params || {};
      if (!spreadsheetId) issues.push(`Step ${step.step}: sheets operation missing spreadsheetId`);
    }
  }

  // Check for clarification needed
  if (plan.clarification_needed && plan.missing_info?.length > 0) {
    warnings.push(`Plan flags missing info: ${plan.missing_info.join(', ')}`);
  }

  const approved = issues.length === 0;

  return {
    approved,
    risk: overallRisk,
    issues,
    warnings,
    requiresConfirmation: overallRisk === RISK.HIGH || overallRisk === RISK.CRITICAL,
    summary: approved
      ? `Plan approved [${overallRisk} risk]: ${plan.steps.length} steps`
      : `Plan REJECTED: ${issues.join('; ')}`
  };
}

// ─── Result Post-Validation ───────────────────────────────────────────────────
// Validates the final response AFTER all tools have run
function validateResult(toolsUsed, finalResponse, userMessage) {
  const issues = [];
  const warnings = [];

  // Check response exists and is meaningful
  if (!finalResponse || finalResponse.trim().length < 5) {
    issues.push('Final response is empty or too short');
  }

  // Check for hallucinated data patterns in response
  const hallucinations = [
    { pattern: /\$[0-9,]+/g, label: 'financial figures' },
    { pattern: /\d{4}-\d{2}-\d{2}/g, label: 'dates' },
    { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: 'email addresses' }
  ];

  for (const { pattern, label } of hallucinations) {
    const matches = finalResponse.match(pattern);
    if (matches && matches.length > 0 && toolsUsed.length === 0) {
      warnings.push(`Response contains ${label} but no data tools were called — verify accuracy`);
    }
  }

  // Check that sensitive operations are acknowledged
  const sensitiveOps = toolsUsed.filter(t =>
    ['gmail_send_message', 'calendar_create_event', 'docs_create_contract', 'sheets_write_data'].includes(t)
  );
  if (sensitiveOps.length > 0) {
    const mentions = sensitiveOps.filter(op => {
      const opName = op.replace(/_/g, ' ').toLowerCase();
      return !finalResponse.toLowerCase().includes('sent') &&
             !finalResponse.toLowerCase().includes('created') &&
             !finalResponse.toLowerCase().includes('saved') &&
             !finalResponse.toLowerCase().includes('done');
    });
    if (mentions.length > 0) {
      warnings.push(`Sensitive operations completed but confirmation not clearly stated`);
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    note: issues.length > 0 ? `Result validation issues: ${issues.join('; ')}` : 'Result validated'
  };
}

// ─── AI-Powered Deep Validation (for critical operations) ─────────────────────
async function deepValidate(plan, memoryContext, userMessage) {
  const prompt = `You are the Supervisor module of TVMbot, a villa management AI.

Your job is to check if this execution plan is SAFE and CORRECT before it runs.

USER REQUEST: ${userMessage}

MEMORY CONTEXT:
${memoryContext || '(none)'}

PLAN TO VALIDATE:
${JSON.stringify(plan, null, 2)}

Check for:
1. Does the plan actually fulfill what the user asked?
2. Are there any dangerous or unintended side-effects?
3. Are email addresses, dates, villa names correct and realistic?
4. Would this plan embarrass the owner if something went wrong?
5. Is any step missing that would make the plan incomplete?

Respond with JSON only:
{
  "approved": true/false,
  "confidence": 0-100,
  "issues": ["list of blocking problems"],
  "warnings": ["list of non-blocking concerns"],
  "suggested_changes": "optional string with improvements"
}`;

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.find(b => b.type === 'text')?.text || '{}';
    const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    return JSON.parse(cleanJson);
  } catch (err) {
    console.error('[Supervisor] deepValidate error:', err.message);
    return { approved: true, confidence: 60, issues: [], warnings: ['Deep validation unavailable'], suggested_changes: '' };
  }
}

// ─── Approval Gate (for HIGH risk ops) ────────────────────────────────────────
function formatApprovalRequest(plan, validation) {
  const sensSteps = plan.steps.filter(s => s.sensitive);

  let msg = `⚠️ **Approval Required** — This action requires your confirmation:\n\n`;
  msg += `**Plan:** ${plan.strategy}\n\n`;

  if (sensSteps.length > 0) {
    msg += `**Actions that will be taken:**\n`;
    for (const step of sensSteps) {
      msg += `• ${step.action}: ${step.purpose}\n`;
      if (step.params && Object.keys(step.params).length > 0) {
        const keyParams = Object.entries(step.params)
          .filter(([k]) => ['to', 'subject', 'guestName', 'villaName', 'checkIn', 'checkOut', 'price'].includes(k))
          .map(([k, v]) => `${k}="${v}"`)
          .join(', ');
        if (keyParams) msg += `  Details: ${keyParams}\n`;
      }
    }
  }

  if (validation.warnings.length > 0) {
    msg += `\n**Warnings:**\n`;
    for (const w of validation.warnings) msg += `• ${w}\n`;
  }

  msg += `\nReply **"yes"** or **"confirm"** to proceed, or **"cancel"** to abort.`;

  return msg;
}

module.exports = {
  validatePlan,
  validateResult,
  deepValidate,
  formatApprovalRequest,
  RISK,
  TOOL_RISK
};
