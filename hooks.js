/**
 * hooks.js — Pre/Post Processing Hook System for TVMbot
 * Inspired by ruflo's 17 hooks + 12 workers architecture
 *
 * Hooks run automatically at specific lifecycle points:
 *   - pre_message: Before any processing (sanitize, detect language, extract metadata)
 *   - pre_route: Before routing (enrich context, detect urgency)
 *   - pre_execute: Before Claude API call (inject time, inject villa context)
 *   - post_execute: After Claude responds (format, log, learn)
 *   - pre_send: Before sending to WhatsApp (final formatting, length check)
 *   - on_error: When something fails (log, notify, fallback)
 *   - on_schedule: Periodic hooks (cleanup, health check)
 */

'use strict';

// ─── HOOK REGISTRY ──────────────────────────────────────────────────────────

const hooks = {
  pre_message: [],
  pre_route: [],
  pre_execute: [],
  post_execute: [],
  pre_send: [],
  on_error: [],
  on_schedule: [],
};

// ─── BUILT-IN HOOKS ─────────────────────────────────────────────────────────

// 1. Language Detection Hook
hooks.pre_message.push({
  name: 'language-detector',
  priority: 10,
  fn: (ctx) => {
    const msg = ctx.message || '';
    const idPatterns = /\b(tolong|bisa|apa|siapa|bagaimana|berapa|dimana|kapan|sudah|belum|tidak|ada|ini|itu|saya|kami|villa\s+mana|yang|untuk|dengan|dari)\b/gi;
    const idMatches = (msg.match(idPatterns) || []).length;
    const totalWords = msg.split(/\s+/).length;
    ctx.language = idMatches / totalWords > 0.2 ? 'id' : 'en';
    ctx.languageConfidence = idMatches / totalWords;
    return ctx;
  },
});

// 2. Urgency Detection Hook
hooks.pre_message.push({
  name: 'urgency-detector',
  priority: 20,
  fn: (ctx) => {
    const msg = (ctx.message || '').toLowerCase();
    const urgentPatterns = [
      /\b(urgent|emergency|asap|immediately|critical|darurat|segera|penting)\b/i,
      /\b(flood|fire|broken.*guest|leak.*check.?in|no.*water|no.*power|no.*electricity)\b/i,
      /!{2,}/, // Multiple exclamation marks
    ];
    ctx.urgency = 'normal';
    for (const pattern of urgentPatterns) {
      if (pattern.test(msg)) {
        ctx.urgency = 'urgent';
        break;
      }
    }
    return ctx;
  },
});

// 3. Metadata Extraction Hook
hooks.pre_message.push({
  name: 'metadata-extractor',
  priority: 30,
  fn: (ctx) => {
    const msg = ctx.message || '';
    ctx.metadata = ctx.metadata || {};

    // Extract villa mentions
    const villas = ['ANN', 'DIANE', 'KALA', 'LOUNA', 'NISSA', 'LYMA', 'LIAN', 'LYSA'];
    ctx.metadata.mentionedVillas = villas.filter(v =>
      new RegExp(`\\b${v}\\b`, 'i').test(msg)
    );

    // Extract amounts
    const amountMatch = msg.match(/(?:IDR|Rp|USD|\$)\s*[\d,.]+|[\d,.]+\s*(?:IDR|juta|ribu|rb|jt)/gi);
    ctx.metadata.amounts = amountMatch || [];

    // Extract dates
    const dateMatch = msg.match(/\b\d{1,2}[\/\-\.]\d{1,2}(?:[\/\-\.]\d{2,4})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/gi);
    ctx.metadata.dates = dateMatch || [];

    // Extract phone numbers
    const phoneMatch = msg.match(/(?:\+62|62|08)\d{8,12}/g);
    ctx.metadata.phones = phoneMatch || [];

    // Message length category
    ctx.metadata.lengthCategory = msg.length < 20 ? 'short' : msg.length < 100 ? 'medium' : 'long';

    return ctx;
  },
});

// 4. Time Context Hook (injects current time into execution)
hooks.pre_execute.push({
  name: 'time-injector',
  priority: 10,
  fn: (ctx) => {
    const now = new Date();
    const baliTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8 (WITA)
    ctx.timeContext = `Current date/time: ${baliTime.toISOString().replace('T', ' ').substring(0, 19)} WITA (Bali time, UTC+8)`;

    // Business hours check
    const hour = baliTime.getUTCHours();
    ctx.isBusinessHours = hour >= 8 && hour < 20;
    ctx.isDayTime = hour >= 6 && hour < 22;

    return ctx;
  },
});

// 5. Villa Context Enrichment Hook
hooks.pre_execute.push({
  name: 'villa-context-enricher',
  priority: 20,
  fn: (ctx) => {
    if (ctx.metadata?.mentionedVillas?.length > 0) {
      ctx.villaContext = ctx.metadata.mentionedVillas.map(v =>
        `Villa ${v}: check calendar for availability, maintenance sheet for open issues`
      ).join('. ');
    }
    return ctx;
  },
});

// 6. Urgency Escalation Hook
hooks.pre_execute.push({
  name: 'urgency-escalator',
  priority: 30,
  fn: (ctx) => {
    if (ctx.urgency === 'urgent') {
      ctx.urgencyPrompt = 'URGENT REQUEST: This message is flagged as urgent. Prioritize immediate action. If it involves guest safety or property damage, suggest alerting management immediately.';
    }
    return ctx;
  },
});

// 7. Response Formatter Hook
hooks.post_execute.push({
  name: 'response-formatter',
  priority: 10,
  fn: (ctx) => {
    if (ctx.response) {
      // Fix double asterisks for WhatsApp
      ctx.response = ctx.response.replace(/\*\*/g, '*');
      // Fix markdown headers (not useful in WhatsApp)
      ctx.response = ctx.response.replace(/^#{1,3}\s+/gm, '*');
      // Trim excessive whitespace
      ctx.response = ctx.response.replace(/\n{3,}/g, '\n\n');
    }
    return ctx;
  },
});

// 8. Length Guard Hook
hooks.pre_send.push({
  name: 'length-guard',
  priority: 10,
  fn: (ctx) => {
    if (ctx.response && ctx.response.length > 4000) {
      // Truncate at a natural break point
      const truncated = ctx.response.substring(0, 3800);
      const lastBreak = truncated.lastIndexOf('\n\n');
      ctx.response = (lastBreak > 2000 ? truncated.substring(0, lastBreak) : truncated) +
        '\n\n_(Message truncated. Ask for more details if needed.)_';
    }
    return ctx;
  },
});

// 9. Error Handler Hook
hooks.on_error.push({
  name: 'error-logger',
  priority: 10,
  fn: (ctx) => {
    console.error(`[Hook:Error] ${ctx.error?.message || 'Unknown error'}`, {
      session: ctx.sessionId,
      intent: ctx.intent,
    });
    return ctx;
  },
});

// 10. Error Fallback Response Hook
hooks.on_error.push({
  name: 'error-fallback',
  priority: 20,
  fn: (ctx) => {
    if (!ctx.response) {
      ctx.response = ctx.language === 'id'
        ? 'Maaf, terjadi kesalahan. Silakan coba lagi.'
        : 'Sorry, something went wrong. Please try again.';
    }
    return ctx;
  },
});

// ─── HOOK RUNNER ─────────────────────────────────────────────────────────────

class HookSystem {
  constructor() {
    // Sort all hooks by priority
    for (const stage of Object.keys(hooks)) {
      hooks[stage].sort((a, b) => a.priority - b.priority);
    }
    const totalHooks = Object.values(hooks).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`[Hooks] Initialized with ${totalHooks} hooks across ${Object.keys(hooks).length} stages`);
  }

  /**
   * Run all hooks for a given stage
   */
  async run(stage, ctx) {
    const stageHooks = hooks[stage] || [];
    for (const hook of stageHooks) {
      try {
        const result = hook.fn(ctx);
        if (result && typeof result.then === 'function') {
          ctx = await result; // Support async hooks
        } else if (result) {
          ctx = result;
        }
      } catch (e) {
        console.warn(`[Hook:${hook.name}] Error:`, e.message);
      }
    }
    return ctx;
  }

  /**
   * Run hooks synchronously (for performance-critical paths)
   */
  runSync(stage, ctx) {
    const stageHooks = hooks[stage] || [];
    for (const hook of stageHooks) {
      try {
        const result = hook.fn(ctx);
        if (result) ctx = result;
      } catch (e) {
        console.warn(`[Hook:${hook.name}] Error:`, e.message);
      }
    }
    return ctx;
  }

  /**
   * Register a custom hook
   */
  register(stage, name, fn, priority = 50) {
    if (!hooks[stage]) {
      console.warn(`[Hooks] Unknown stage: ${stage}`);
      return;
    }
    hooks[stage].push({ name, priority, fn });
    hooks[stage].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get all registered hooks
   */
  list() {
    const result = {};
    for (const [stage, stageHooks] of Object.entries(hooks)) {
      result[stage] = stageHooks.map(h => ({ name: h.name, priority: h.priority }));
    }
    return result;
  }
}

const hookSystem = new HookSystem();
module.exports = hookSystem;
module.exports.HookSystem = HookSystem;
module.exports.hooks = hooks;
