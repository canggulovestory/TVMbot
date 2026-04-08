// planner.js — Goal Decomposition Engine for TVMbot PEMS Architecture
// Takes a user request + memory context → returns a structured execution plan
// Model: GPT-4o-mini (primary) | Haiku (fallback if OpenAI unavailable)
// Anthropic is treated as a LIMITED resource — planner uses OpenAI to save Anthropic tokens

const { llm_call, isOpenAIAvailable } = require('./llm-provider');
require('dotenv').config();

// ─── Available Tools Reference (for plan generation) ──────────────────────────
const TOOL_CATALOG = `
Available tools the executor can call:
- gmail_list_messages(maxResults, query) — list/search emails
- gmail_read_message(messageId) — read full email content
- gmail_send_message(to, subject, body) — send email [SENSITIVE]
- gmail_get_flagged() — get starred/important emails
- calendar_get_events(maxResults, timeMin, timeMax) — list calendar events
- calendar_check_availability(startTime, endTime) — check if time slot is free
- calendar_create_event(summary, startTime, endTime, description, attendees) — create event [SENSITIVE]
- drive_search_files(query, maxResults) — search Google Drive
- drive_find_passport(guestName) — find passport files for a guest
- drive_get_recent(maxResults) — list recently modified Drive files
- drive_create_folder(name, parentId) — create folder in Drive [SENSITIVE]
- docs_create_document(title, content) — create a new Google Doc [SENSITIVE]
- docs_read_document(documentId) — read a Google Doc
- docs_update_document(documentId, content) — update a Google Doc [SENSITIVE]
- docs_create_contract(guestName, villaName, checkIn, checkOut, price, extras, guestEmail) — generate rental contract [SENSITIVE]
- sheets_read_data(spreadsheetId, range) — read from Google Sheets
- sheets_write_data(spreadsheetId, range, values) — write to Google Sheets [SENSITIVE]
- sheets_append_row(spreadsheetId, sheetName, values) — append row to Sheets [SENSITIVE]
- cleaning_generate_schedule(checkIns, checkOuts, villaName) — generate cleaning schedule
- marketing_generate_content(villaName, contentType, details) — create marketing post/copy
- get_owner_profile() — retrieve owner/villa profile from memory
- save_note(title, body) — save a note to agent memory
`;

// ─── Plan Schema ───────────────────────────────────────────────────────────────
// A plan is an ordered array of steps:
// { step: 1, action: "tool_name", params: {...}, purpose: "why", depends_on: [], sensitive: bool }
// Plus a "strategy" text summary and "clarification_needed" flag

const PLANNER_SYSTEM_PROMPT = `You are the Planner module of TVMbot, an autonomous villa management AI.

Your job is to analyze the user's request and decompose it into a precise, ordered execution plan.

${TOOL_CATALOG}

RULES:
1. Return ONLY valid JSON — no prose, no markdown fences.
2. Each step must include: step (number), action (tool name or "respond"), params (object), purpose (string), depends_on (array of step numbers), sensitive (boolean).
3. Use "respond" as action when a step is just forming a text reply to user (no tool call needed).
4. Mark steps as sensitive=true if they send emails, create events, create docs, write data, etc.
5. If the request is ambiguous or missing info, set clarification_needed=true and list what's missing.
6. Keep plans minimal — don't add steps that aren't needed.
7. If request is purely conversational, return a single "respond" step.

OUTPUT FORMAT:
{
  "strategy": "brief description of overall approach",
  "clarification_needed": false,
  "missing_info": [],
  "steps": [
    {
      "step": 1,
      "action": "tool_name_here",
      "params": { "param1": "value1" },
      "purpose": "why this step is needed",
      "depends_on": [],
      "sensitive": false
    }
  ]
}`;

// ─── Main Planning Function ────────────────────────────────────────────────────
// choose planning model: GPT-4o-mini first (cheap), fallback to Haiku (Anthropic)
function _plannerModel() {
  return isOpenAIAvailable() ? 'gpt-mini' : 'haiku';
}

async function callWithRetry(callFn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callFn();
    } catch (err) {
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('rate'));
      if (isRateLimit && attempt < maxRetries) {
        const wait = (attempt + 1) * 20;
        console.log(`[Planner] Rate limited, waiting ${wait}s (attempt ${attempt + 1})...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }
}

async function createPlan(userMessage, memoryContext = '', conversationSummary = '') {
  const userContent = `
MEMORY CONTEXT:
${memoryContext || '(no prior context)'}

RECENT CONVERSATION:
${conversationSummary || '(new session)'}

USER REQUEST:
${userMessage}

Generate the execution plan as JSON.`;

  const model = _plannerModel();
  console.log(`[Planner] Using model: ${model}`);

  try {
    const result = await callWithRetry(() =>
      llm_call(model, [{ role: 'user', content: userContent }], {
        max_tokens: 1500,
        system: PLANNER_SYSTEM_PROMPT
      })
    );

    const text = result.text || '{}';

    // Clean JSON (remove any accidental markdown fences)
    const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let plan;
    try {
      plan = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error('[Planner] JSON parse error:', parseErr.message);
      plan = {
        strategy: 'Direct response (plan parse failed)',
        clarification_needed: false,
        missing_info: [],
        steps: [{ step: 1, action: 'respond', params: { message: userMessage }, purpose: 'Fallback direct response', depends_on: [], sensitive: false }]
      };
    }

    if (!plan.steps || !Array.isArray(plan.steps)) {
      plan.steps = [{ step: 1, action: 'respond', params: {}, purpose: 'Direct response', depends_on: [], sensitive: false }];
    }

    console.log(`[Planner] Plan created via ${model}: "${plan.strategy}" | ${plan.steps.length} steps`);
    return plan;

  } catch (err) {
    console.error('[Planner] Error:', err.message);
    return {
      strategy: 'Fallback: direct response due to planner error',
      clarification_needed: false,
      missing_info: [],
      steps: [{ step: 1, action: 'respond', params: {}, purpose: 'Error fallback', depends_on: [], sensitive: false }]
    };
  }
}

// ─── Plan Refinement (when supervisor rejects) ─────────────────────────────────
async function revisePlan(originalPlan, supervisorFeedback, userMessage) {
  const userContent = `
ORIGINAL PLAN:
${JSON.stringify(originalPlan, null, 2)}

SUPERVISOR REJECTION REASON:
${supervisorFeedback}

USER REQUEST:
${userMessage}

Revise the plan to address the supervisor's concerns. Return updated JSON plan.`;

  const model = _plannerModel();
  try {
    const result = await callWithRetry(() =>
      llm_call(model, [{ role: 'user', content: userContent }], {
        max_tokens: 1500,
        system: PLANNER_SYSTEM_PROMPT
      })
    );
    const text = result.text || '{}';
    const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    console.error('[Planner] Revise error:', err.message);
    return originalPlan;
  }
}

// ─── Classify Intent ───────────────────────────────────────────────────────────
function classifyIntent(userMessage) {
  const msg = userMessage.toLowerCase();

  const intents = {
    booking: /book|reservation|check.?in|check.?out|arrival|departure|guest|stay/i.test(msg),
    contract: /contract|agreement|sign|lease|rental agreement/i.test(msg),
    email: /email|gmail|send|reply|message|mail/i.test(msg),
    calendar: /calendar|schedule|event|appointment|availability/i.test(msg),
    drive: /drive|file|document|folder|passport|upload|download/i.test(msg),
    sheets: /sheet|spreadsheet|table|data|row|column/i.test(msg),
    cleaning: /clean|housekeeping|maid|schedule|turnover/i.test(msg),
    marketing: /marketing|post|instagram|content|caption|promotion/i.test(msg),
    financial: /price|revenue|payment|invoice|cost|fee|earning/i.test(msg),
    conversational: /hello|hi|how are|thank|what can|help me/i.test(msg)
  };

  return Object.entries(intents)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

module.exports = { createPlan, revisePlan, classifyIntent };
