/**
 * llm-provider.js — Unified Multi-Model LLM Provider for TVMbot
 *
 * Architecture inspired by AutoGPT (Significant-Gravitas/AutoGPT):
 *   - LlmModel enum with ModelMetadata (provider, price_tier, display_name)
 *   - Unified llm_call() dispatcher that routes by provider
 *   - Price tiers: 1=cheap (Haiku, GPT-4o-mini), 2=standard (Sonnet), 3=expensive (Opus — BANNED)
 *   - Automatic fallback: Anthropic → OpenAI on rate limit / error
 *
 * Models in use:
 *   TIER 1 (cheap/fast) : claude-haiku-4-5-20251001   → classify, route, simple replies
 *   TIER 2 (standard)   : claude-sonnet-4-5-20250929  → reasoning, tool use, complex tasks
 *   TIER 2 (standard)   : gpt-4o-mini                 → content gen, marketing, general Q&A
 *   TIER 3 (BANNED)     : claude-opus-*               → ❌ Do not use
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
let OpenAI;
try { OpenAI = require('openai'); } catch(e) { /* optional */ }

// ── Clients ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let openaiClient = null;
if (OpenAI && process.env.OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ── Model Registry (AutoGPT-style ModelMetadata) ────────────────────────────
// price_tier: 1=cheap, 2=standard, 3=expensive/banned
const MODEL_REGISTRY = {
  // Anthropic — Haiku (Tier 1: cheap + fast)
  'haiku': {
    id:           'claude-haiku-4-5-20251001',
    provider:     'anthropic',
    displayName:  'Claude Haiku 4.5',
    priceTier:    1,
    costPer1K:    { input: 0.0008, output: 0.004 },
    contextWindow: 200000,
  },
  // Anthropic — Sonnet (Tier 2: standard)
  'sonnet': {
    id:           'claude-sonnet-4-5-20250929',
    provider:     'anthropic',
    displayName:  'Claude Sonnet 4.5',
    priceTier:    2,
    costPer1K:    { input: 0.003, output: 0.015 },
    contextWindow: 200000,
  },
  // OpenAI — GPT-4o mini (Tier 1: cheap for content/general)
  'gpt-mini': {
    id:           'gpt-4o-mini',
    provider:     'openai',
    displayName:  'GPT-4o Mini',
    priceTier:    1,
    costPer1K:    { input: 0.00015, output: 0.0006 },
    contextWindow: 128000,
  },
  // OpenAI — GPT-4o (Tier 2: standard, used as Sonnet fallback)
  'gpt': {
    id:           'gpt-4o',
    provider:     'openai',
    displayName:  'GPT-4o',
    priceTier:    2,
    costPer1K:    { input: 0.0025, output: 0.01 },
    contextWindow: 128000,
  },
  // ❌ Opus — BANNED. Listed only for detection/guardrail purposes.
  '_opus_banned': {
    id:           'claude-opus-4-5-20251101',
    provider:     'anthropic',
    displayName:  'Claude Opus (BANNED)',
    priceTier:    3,
    banned:       true,
  },
};

// ── Intent → Model Routing Table ───────────────────────────────────────────
// Anthropic = LIMITED RESOURCE — only use when native tool_use is required
// ChatGPT   = PRIMARY for everything that doesn’t need tool_use
// Haiku     = ultra-light Anthropic calls when OpenAI is unavailable

const INTENT_ROUTING = {
  // ── ZERO COST: Agent Booster handles these in smart-router.js (no LLM) ──
  // greeting, thanks, acknowledgment, villa_list, identity, status → booster

  // ── CHATGPT: Everything where tool_use is NOT needed ──────────────────
  marketing:         'gpt-mini',   // Instagram, Airbnb captions (was Opus)
  general_assistant: 'gpt-mini',   // general Q&A, advice, suggestions
  translation:       'gpt-mini',   // language translation (EN ↔ ID)
  content_gen:       'gpt-mini',   // any creative writing
  guest_comms:       'gpt-mini',   // welcome letters, review requests
  advice:            'gpt-mini',   // strategic advice, recommendations
  interior:          'gpt-mini',   // design concept suggestions
  faq:               'gpt-mini',   // FAQ answering
  hr:                'gpt-mini',   // HR questions (no data writes)

  // ── HAIKU: Ultra-light Anthropic classification (when must stay in ecosystem) ──
  classify:          'haiku',     // internal classification decisions
  route:             'haiku',     // routing decisions

  // ── SONNET: ONLY when Anthropic native tool_use is required ─────────────
  // These intents require calling Google APIs via Claude tool_use
  booking:              'sonnet',  // calendar + sheets tool chains
  finance:              'sonnet',  // sheets + finance tool chains
  calendar:             'sonnet',  // calendar API tool use
  email:                'sonnet',  // gmail tool use (read/send)
  data_analysis:        'sonnet',  // sheets data analysis with tools
  document_intelligence:'sonnet',  // drive + docs tool use
  audit:                'sonnet',  // multi-tool audit chains
  renovation:           'sonnet',  // project tracking via sheets
  maintenance:          'sonnet',  // maintenance logging via sheets
  data_ops:             'sonnet',  // direct sheet read/write
  agency:               'sonnet',  // client tracking via sheets
  scraping:             'sonnet',  // web scraping tool use
  file_search:          'sonnet',  // drive search tool use
  error_recovery:       'sonnet',  // error fix (was Opus)
  multi_write:          'sonnet',  // multi-sheet writes
};

// ── Default model per task type (for non-intent calls) ───────────────────────
const TASK_MODELS = {
  plan:        'haiku',   // planner classification
  supervise:   'haiku',   // supervisor pre-check (low risk simple queries)
  supervise_high: 'sonnet', // supervisor for high/critical risk tools
  agent_loop:  'sonnet',  // main PEMS tool-use loop
  marketing:   'gpt-mini',
  fallback:    'gpt',     // when Anthropic fails/rate-limits
};

// ── Core unified provider call (AutoGPT-inspired llm_call pattern) ────────────

/**
 * llm_call(modelKey, messages, opts)
 * Unified dispatcher — routes to Anthropic or OpenAI based on model registry.
 *
 * @param {string} modelKey - key from MODEL_REGISTRY (e.g. 'haiku', 'sonnet', 'gpt-mini')
 * @param {Array}  messages - array of {role, content} messages
 * @param {Object} opts     - { max_tokens, tools, system, temperature }
 * @returns {Promise<{text, usage, model, provider}>}
 */
async function llm_call(modelKey, messages, opts = {}) {
  const meta = MODEL_REGISTRY[modelKey];
  if (!meta) throw new Error(`[LLMProvider] Unknown model key: ${modelKey}`);
  if (meta.banned) throw new Error(`[LLMProvider] ❌ Model ${meta.displayName} is BANNED. Use 'sonnet' or 'gpt-mini' instead.`);

  const { max_tokens = 1024, tools, system, temperature = 0.7 } = opts;

  // ── Anthropic dispatch ───────────────────────────────────────────────────
  if (meta.provider === 'anthropic') {
    const reqParams = {
      model: meta.id,
      max_tokens,
      messages,
    };
    if (system) reqParams.system = system;
    if (tools && tools.length > 0) reqParams.tools = tools;

    try {
      const response = await anthropic.messages.create(reqParams);
      const textBlock = response.content.find(b => b.type === 'text');
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
      return {
        text:       textBlock?.text || null,
        toolUses:   toolBlocks,
        stopReason: response.stop_reason,
        usage:      response.usage,
        model:      modelKey,
        modelId:    meta.id,
        provider:   'anthropic',
        content:    response.content,
      };
    } catch (err) {
      // Rate limit or overload → try OpenAI fallback
      if ((err.status === 429 || err.status === 529 || err.status === 503) && openaiClient) {
        console.warn(`[LLMProvider] Anthropic ${err.status} — falling back to GPT-4o`);
        return llm_call('gpt', messages, opts);
      }
      throw err;
    }
  }

  // ── OpenAI dispatch ──────────────────────────────────────────────────────
  if (meta.provider === 'openai') {
    if (!openaiClient) throw new Error('[LLMProvider] OpenAI client not available. Set OPENAI_API_KEY.');

    const oaiMessages = [];
    if (system) oaiMessages.push({ role: 'system', content: system });
    oaiMessages.push(...messages.map(m => ({ role: m.role, content: m.content })));

    const reqParams = {
      model: meta.id,
      messages: oaiMessages,
      max_tokens,
      temperature,
    };

    const response = await openaiClient.chat.completions.create(reqParams);
    const choice = response.choices[0];
    return {
      text:       choice.message.content || null,
      toolUses:   [],
      stopReason: choice.finish_reason,
      usage:      response.usage,
      model:      modelKey,
      modelId:    meta.id,
      provider:   'openai',
      content:    [{ type: 'text', text: choice.message.content || '' }],
    };
  }

  throw new Error(`[LLMProvider] Unknown provider: ${meta.provider}`);
}

// ── Convenience helpers ──────────────────────────────────────────────────────

/** Quick text completion — no tool use */
async function complete(modelKey, prompt, opts = {}) {
  const result = await llm_call(modelKey, [{ role: 'user', content: prompt }], opts);
  return result.text || '';
}

/** Route by intent → pick the right model key */
function modelForIntent(intent) {
  return INTENT_ROUTING[intent] || 'sonnet'; // default to sonnet for unknown
}

/** Route by task type */
function modelForTask(task) {
  return TASK_MODELS[task] || 'sonnet';
}

/** Guard against Opus usage (for migration safety) */
function assertNotOpus(modelId) {
  if (modelId && modelId.includes('opus')) {
    throw new Error(`[LLMProvider] ❌ Opus model blocked: ${modelId}. Update your code to use 'sonnet' or 'gpt-mini'.`);
  }
}

/** Get model metadata */
function getModelMeta(modelKey) {
  return MODEL_REGISTRY[modelKey] || null;
}

/** Check if OpenAI is available */
function isOpenAIAvailable() {
  return !!openaiClient;
}

module.exports = {
  llm_call,
  complete,
  modelForIntent,
  modelForTask,
  assertNotOpus,
  getModelMeta,
  isOpenAIAvailable,
  MODEL_REGISTRY,
  INTENT_ROUTING,
  TASK_MODELS,
};
