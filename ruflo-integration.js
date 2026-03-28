/**
 * Ruflo Integration Layer v3.1 — TVMbot Full Intelligence Pipeline
 * Wires 22 modules into a unified processing pipeline.
 *
 * Phase 1 (5 modules):  SmartRouter, SwarmCoordinator, ReasoningBank, AIDefence, VectorMemory
 * Phase 2 (6 modules):  PolicyEngine, EventStore, HookSystem, TaskDecomposer, DriftDetector, WebScraper
 * Phase 3 (10 modules): GossipProtocol, GuidanceGates, CircuitBreaker, ContextWindowManager,
 *                        EscalationManager, WorkflowEngine, ResponseCache, FeedbackLoop,
 *                        TemplateEngine, MetricAggregator
 * Phase 3b (1 module):  ModelRouter (Haiku + Sonnet multi-model routing)
 *
 * Message Pipeline:
 *   INBOUND:  Hooks:pre → Metrics:count → Cache:check → Defence:screen → Escalation:evaluate →
 *             Router:route → Hooks:pre_route → Swarm:plan → Decomposer:analyze → Policy:inject →
 *             Reasoning:context → Memory:search → Gossip:context → Guidance:check →
 *             Workflow:detect → Template:match → Context:build → Drift:health → CircuitBreaker:check
 *
 *   OUTBOUND: Hooks:post_execute → Reasoning:distill → Router:feedback → Swarm:performance →
 *             Memory:store → Gossip:auto → Events:log → Drift:record → Feedback:analyze →
 *             Metrics:record → Hooks:pre_send → Defence:screenResponse → Cache:store
 */
'use strict';

// ── Module Loading (fail-safe: each module loads independently) ──

const modules = {};
const moduleNames = [
  // Phase 1
  { key: 'smartRouter',       file: './smart-router',       name: 'SmartRouter' },
  { key: 'swarmCoordinator',  file: './swarm-coordinator',  name: 'SwarmCoordinator' },
  { key: 'reasoningBank',     file: './reasoning-bank',     name: 'ReasoningBank' },
  { key: 'aiDefence',         file: './ai-defence',         name: 'AIDefence' },
  { key: 'vectorMemory',      file: './vector-memory',      name: 'VectorMemory' },
  // Phase 2
  { key: 'policyEngine',      file: './policy-engine',      name: 'PolicyEngine' },
  { key: 'eventStore',        file: './event-store',        name: 'EventStore' },
  { key: 'hookSystem',        file: './hooks',              name: 'HookSystem' },
  { key: 'taskDecomposer',    file: './task-decomposer',    name: 'TaskDecomposer' },
  { key: 'driftDetector',     file: './drift-detector',     name: 'DriftDetector' },
  { key: 'webScraper',        file: './web-scraper',        name: 'WebScraper' },
  // Phase 3
  { key: 'gossipProtocol',    file: './gossip-protocol',    name: 'GossipProtocol' },
  { key: 'guidanceGates',     file: './guidance-gates',     name: 'GuidanceGates' },
  { key: 'circuitBreaker',    file: './circuit-breaker',    name: 'CircuitBreaker' },
  { key: 'contextManager',    file: './context-window-manager', name: 'ContextWindowManager' },
  { key: 'escalationManager', file: './escalation-manager', name: 'EscalationManager' },
  { key: 'workflowEngine',    file: './workflow-engine',    name: 'WorkflowEngine' },
  { key: 'responseCache',     file: './response-cache',     name: 'ResponseCache' },
  { key: 'feedbackLoop',      file: './feedback-loop',      name: 'FeedbackLoop' },
  { key: 'templateEngine',    file: './template-engine',    name: 'TemplateEngine' },
  { key: 'metricAggregator',  file: './metric-aggregator',  name: 'MetricAggregator' },
  // Phase 3b
  { key: 'tokenOptimizer',    file: './token-optimizer',    name: 'TokenOptimizer',    init: function(m) { return m.getTokenOptimizer(); } },
  { key: 'backgroundDaemon',  file: './background-daemon',  name: 'BackgroundDaemon',  init: function(m) { return typeof m === 'function' ? m() : (m.getDaemon ? m.getDaemon() : m); } },
  { key: 'sessionManager',    file: './session-manager',     name: 'SessionManager',    init: function(m) { return m.getSessionManager(); } },
  { key: 'auditor',           file: './agents/auditor',      name: 'Auditor' },
  { key: 'conductor',         file: './agents/conductor',    name: 'Conductor' },
  { key: 'rollback',          file: './agents/rollback',     name: 'Rollback' },
  { key: 'validator',         file: './agents/validator',    name: 'Validator' },
  { key: 'modelRouter',       file: './model-router',       name: 'ModelRouter' },
];

let loadedCount = 0;
for (const mod of moduleNames) {
  try {
    modules[mod.key] = require(mod.file);
    loadedCount++;
  } catch (e) {
    console.warn(`[Ruflo] Failed to load ${mod.name}: ${e.message}`);
    modules[mod.key] = null;
  }
}

console.log(`[Ruflo] Loaded ${loadedCount}/${moduleNames.length} modules`);

// ── Convenience references ──
const {
  smartRouter, swarmCoordinator, reasoningBank, aiDefence, vectorMemory,
  policyEngine, eventStore, hookSystem, taskDecomposer, driftDetector, webScraper,
  gossipProtocol, guidanceGates, circuitBreaker, contextManager,
  escalationManager, workflowEngine, responseCache, feedbackLoop,
  templateEngine, metricAggregator,
} = modules;

// ── Helper Functions ──

function _intentToNamespace(intent) {
  const map = {
    booking: 'villa', maintenance: 'villa', guest_comms: 'villa', calendar: 'villa',
    agency: 'agency', furniture: 'furniture', renovation: 'renovation', interior: 'interior',
    finance: 'finance', hr: 'hr', marketing: 'general', scraping: 'general',
  };
  return map[intent] || 'general';
}

function _intentToCategory(intent) {
  const staticIntents = ['greeting', 'identity'];
  const semiStaticIntents = ['advice', 'hr'];
  if (staticIntents.includes(intent)) return 'static';
  if (semiStaticIntents.includes(intent)) return 'semi-static';
  return 'dynamic';
}

/**
 * INBOUND: Process incoming message through the full intelligence pipeline
 * Called BEFORE Claude API is invoked.
 */
function processMessage(message, sender, context) {
  context = context || {};
  const startTime = Date.now();
  const result = {
    blocked: false,
    boosted: false,
    boosterResponse: null,
    blockMessage: null,
    systemPromptAddition: '',
    metadata: {
      intent: null,
      confidence: 0,
      agents: [],
      policyRules: [],
      memoryHits: 0,
      startTime: startTime,
    },
  };

  try {
    // ── 1. Hook: pre_message ──
    var processedMessage = message;
    var hookMeta = {};
    if (hookSystem) {
      try {
        var hookResult = hookSystem.run('pre_message', { message: message, sender: sender, sessionId: context.sessionId, isGroup: context.isGroup });
        if (hookResult.message) processedMessage = hookResult.message;
        hookMeta = hookResult.metadata || {};
        if (hookMeta.language) result.metadata.language = hookMeta.language;
        if (hookMeta.urgency) result.metadata.urgency = hookMeta.urgency;
      } catch (e) { /* hooks are non-critical */ }
    }

    // ── 2. Metrics: count incoming ──
    if (metricAggregator) {
      try {
        metricAggregator.increment('messages.received', 1, { sender: sender });
      } catch (e) { /* non-critical */ }
    }

    // ── 3. Event Store: log incoming ──
    if (eventStore) {
      try { eventStore.messageReceived(sender, processedMessage, context); } catch (e) {}
    }

    // ── 4. Response Cache: check for cached response ──
    if (responseCache) {
      try {
        var cached = responseCache.get(processedMessage, { sender: sender });
        if (cached) {
          result.boosted = true;
          result.boosterResponse = cached.response;
          result.metadata.intent = 'cache_hit';
          result.metadata.cacheSource = cached.source;
          if (metricAggregator) metricAggregator.increment('messages.cached');
          return result;
        }
      } catch (e) { /* cache miss is fine */ }
    }

    // ── 5. AI Defence: screen message ──
    if (aiDefence) {
      try {
        var defenceResult = aiDefence.screenMessage(processedMessage, sender);
        if (defenceResult.blocked) {
          result.blocked = true;
          result.blockMessage = defenceResult.reason || 'Message blocked by security filter.';
          if (eventStore) eventStore.securityEvent('blocked', sender, defenceResult);
          if (metricAggregator) metricAggregator.increment('security.threats_blocked');
          return result;
        }
        if (defenceResult.sanitized) processedMessage = defenceResult.sanitized;
      } catch (e) { /* defence failure = allow through */ }
    }

    // ── 6. Escalation Manager: check if needs human ──
    if (escalationManager) {
      try {
        var escResult = escalationManager.evaluate(processedMessage, {
          sessionId: context.sessionId,
          sender: sender,
          routingConfidence: 1.0,
          messageCount: context.messageCount || 0,
        });
        if (escResult.shouldEscalate) {
          result.metadata.escalation = escResult;
          result.systemPromptAddition += '\n\nESCALATION TRIGGERED (' + escResult.tierName + '): ' + escResult.signals.map(function(s) { return s.detail; }).join(', ') + '. Respond with extra care and offer human handoff.\n';
          if (metricAggregator) metricAggregator.increment('messages.escalated');
        }
        var escCtx = escalationManager.getEscalationContext(context.sessionId);
        if (escCtx) result.systemPromptAddition += escCtx;
      } catch (e) {}
    }

    // ── 7. Smart Router: route message ──
    var routeResult = { intent: 'general', confidence: 0.5, skills: [], boosted: false };
    if (smartRouter) {
      try {
        routeResult = smartRouter.route(processedMessage, { sender: sender, sessionId: context.sessionId, isGroup: context.isGroup });

        if (routeResult.boosted && routeResult.boosterResponse) {
          result.boosted = true;
          result.boosterResponse = routeResult.boosterResponse;
          result.metadata.intent = 'booster:' + (routeResult.boosterPattern || 'match');
          if (metricAggregator) metricAggregator.increment('messages.boosted');

          // Check template for boosted response
          if (templateEngine && routeResult.intent === 'greeting') {
            var lang = hookMeta.language || 'en';
            var tmpl = templateEngine.render('greeting:' + lang);
            if (tmpl) result.boosterResponse = tmpl;
          }

          return result;
        }

        result.metadata.intent = routeResult.intent;
        result.metadata.confidence = routeResult.confidence;
        result.metadata.requiredTools = routeResult.requiredTools || [];
      } catch (e) {}
    }

    // ── 8. Hook: pre_route ──
    if (hookSystem) {
      try { hookSystem.run('pre_route', { message: processedMessage, routeResult: routeResult, language: hookMeta.language, urgency: hookMeta.urgency }); } catch (e) {}
    }

    // Update escalation with actual routing confidence
    if (escalationManager && routeResult.confidence < 0.4) {
      try {
        var recheck = escalationManager.evaluate(processedMessage, {
          sessionId: context.sessionId,
          sender: sender,
          routingConfidence: routeResult.confidence,
        });
        if (recheck.shouldEscalate && !result.metadata.escalation) {
          result.metadata.escalation = recheck;
          result.systemPromptAddition += '\n\nLOW CONFIDENCE ESCALATION: Routing confidence is ' + routeResult.confidence.toFixed(2) + '. Consider asking for clarification.\n';
        }
      } catch (e) {}
    }

    // ── 9. Division metrics ──
    if (metricAggregator && routeResult.intent) {
      try {
        var divisionMap = {
          booking: 'villa', maintenance: 'villa', guest_comms: 'villa',
          agency: 'agency', furniture: 'furniture', renovation: 'renovation',
          interior: 'interior', finance: 'villa', marketing: 'villa',
        };
        var div = divisionMap[routeResult.intent];
        if (div) metricAggregator.increment('division.' + div);
      } catch (e) {}
    }

    // ── 10. Swarm Coordinator: plan agent involvement ──
    if (swarmCoordinator) {
      try {
        var swarmPlan = swarmCoordinator.plan(processedMessage, routeResult);
        result.metadata.agents = swarmPlan.agents || [];
        if (swarmPlan.systemPromptAddition) {
          result.systemPromptAddition += swarmPlan.systemPromptAddition;
        }
      } catch (e) {}
    }

    // ── 11. Task Decomposer: analyze complexity ──
    if (taskDecomposer) {
      try {
        var decomposition = taskDecomposer.analyze(processedMessage, routeResult);
        if (decomposition.decomposed) {
          result.systemPromptAddition += decomposition.systemPromptAddition || '';
          result.metadata.decomposed = true;
          result.metadata.steps = decomposition.steps;
        }
      } catch (e) {}
    }

    // ── 12. Policy Engine: inject rules ──
    if (policyEngine) {
      try {
        var policies = policyEngine.inject(routeResult.intent, { sender: sender, isGroup: context.isGroup });
        if (policies.rules && policies.rules.length > 0) {
          result.systemPromptAddition += '\n\n--- Active Policies ---\n' + policies.rules.join('\n') + '\n';
          result.metadata.policyRules = policies.rules;
        }
      } catch (e) {}
    }

    // ── 13. Guidance Gates: check if action needs approval ──
    if (guidanceGates) {
      try {
        var approvalCtx = guidanceGates.getApprovalContext(sender);
        if (approvalCtx) result.systemPromptAddition += approvalCtx;

        var approveMatch = processedMessage.match(/^approve\s+(apr_\w+)/i);
        var rejectMatch = processedMessage.match(/^reject\s+(apr_\w+)/i);
        if (approveMatch) {
          var res = guidanceGates.approve(approveMatch[1], sender, 'Approved via WhatsApp');
          if (res.success) {
            result.boosted = true;
            result.boosterResponse = 'Approved: ' + approveMatch[1];
            return result;
          }
        }
        if (rejectMatch) {
          var res2 = guidanceGates.reject(rejectMatch[1], sender, 'Rejected via WhatsApp');
          if (res2.success) {
            result.boosted = true;
            result.boosterResponse = 'Rejected: ' + rejectMatch[1];
            return result;
          }
        }
      } catch (e) {}
    }

    // ── 14. Reasoning Bank: add learned context ──
    if (reasoningBank) {
      try {
        var reasoning = reasoningBank.getContext(processedMessage, routeResult.intent);
        if (reasoning.context) {
          result.systemPromptAddition += reasoning.context;
        }
      } catch (e) {}
    }

    // ── 15. Vector Memory: semantic search ──
    if (vectorMemory) {
      try {
        var namespace = _intentToNamespace(routeResult.intent);
        var memories = vectorMemory.search(processedMessage, namespace, 3);
        if (memories.length > 0) {
          result.systemPromptAddition += '\n\n--- Relevant Memory ---\n';
          for (var i = 0; i < memories.length; i++) {
            result.systemPromptAddition += '- [' + memories[i].namespace + '] ' + memories[i].content.substring(0, 150) + '\n';
          }
          result.metadata.memoryHits = memories.length;
        }
      } catch (e) {}
    }

    // ── 16. Gossip Protocol: inter-agent intel ──
    if (gossipProtocol) {
      try {
        var primaryAgent = result.metadata.agents[0] || 'strategic-advisor';
        var gossipCtx = gossipProtocol.getContextForAgent(primaryAgent, routeResult.intent);
        if (gossipCtx) result.systemPromptAddition += gossipCtx;
      } catch (e) {}
    }

    // ── 17. Workflow Engine: detect and show active workflows ──
    if (workflowEngine) {
      try {
        var wfDetect = workflowEngine.detectWorkflow(processedMessage, routeResult.intent);
        if (wfDetect) {
          result.metadata.suggestedWorkflow = wfDetect;
          result.systemPromptAddition += '\n\n--- Suggested Workflow ---\nDetected workflow: "' + wfDetect.templateId + '" (confidence: ' + wfDetect.confidence.toFixed(2) + '). Consider following the structured workflow steps.\n';
        }
        var activeWfCtx = workflowEngine.getActiveWorkflowContext(context.sessionId);
        if (activeWfCtx) result.systemPromptAddition += activeWfCtx;
      } catch (e) {}
    }

    // ── 18. Context Window Manager: entity persistence ──
    if (contextManager) {
      try {
        var entityCtx = contextManager.getEntityContext(context.sessionId || sender);
        if (entityCtx) result.systemPromptAddition += entityCtx;
      } catch (e) {}
    }

    // ── 19. Circuit Breaker: health context ──
    if (circuitBreaker) {
      try {
        var healthCtx = circuitBreaker.getHealthContext();
        if (healthCtx) result.systemPromptAddition += healthCtx;
      } catch (e) {}
    }

    // ── 19b. Swarm: tag expert agents for this message ──
    if (swarmCoordinator && swarmCoordinator.tagExperts) {
      try {
        var expertCtx = swarmCoordinator.tagExperts(processedMessage, result.metadata.intent);
        if (expertCtx) result.systemPromptAddition += expertCtx;
      } catch (e) {}
    }

    // ── 20. Drift Detector: add health warning ──
    if (driftDetector) {
      try {
        var health = driftDetector.getHealth();
        if (health.warnings && health.warnings.length > 0) {
          result.metadata.driftWarnings = health.warnings;
        }
      } catch (e) {}
    }

    // ── 21. Feedback Loop: quality context ──
    if (feedbackLoop) {
      try {
        var qualCtx = feedbackLoop.getQualityContext();
        if (qualCtx) result.systemPromptAddition += qualCtx;
      } catch (e) {}
    }

    // ── 22. Metrics: today's context ──
    if (metricAggregator) {
      try {
        var metCtx = metricAggregator.getMetricContext();
        if (metCtx) result.systemPromptAddition += metCtx;
      } catch (e) {}
    }

    // ── 23. Template Engine: check for template match ──
    if (templateEngine) {
      try {
        var tmplKey = templateEngine.matchTemplate(routeResult.intent, 'default', hookMeta.language || 'en');
        if (tmplKey) {
          result.metadata.templateAvailable = tmplKey;
        }
      } catch (e) {}
    }

    // ── 24. Web Scraper: add tool definitions ──
    if (webScraper) {
      result.metadata.scraperTools = webScraper.SCRAPER_TOOLS || [];
    }

    // ── 24b. Model Router: choose Haiku vs Sonnet ──

    // Step 24c: Token Optimizer — compress context (32% reduction)
    if (modules.tokenOptimizer) {
      try {
        var contextSections = {
          memoryContext: result.metadata.memoryContext || '',
          monitorContext: result.metadata.monitorContext || '',
          reasoningPatterns: result.metadata.reasoningContext || '',
          toolResults: JSON.stringify(result.metadata.scraperTools || [])
        };
        var compressed = modules.tokenOptimizer.getCompactContext(contextSections);
        result.metadata.tokenOptimization = {
          before: compressed.tokensBefore,
          after: compressed.tokensAfter,
          savings: compressed.savingsPercent + '%',
          cacheHitRate: compressed.cacheHitRate + '%'
        };
        // Replace with compressed versions
        if (compressed.sections.memoryContext) result.metadata.memoryContext = compressed.sections.memoryContext;
        if (compressed.sections.monitorContext) result.metadata.monitorContext = compressed.sections.monitorContext;
      } catch(e) { /* token optimizer error, continue uncompressed */ }
    }

    if (modules.modelRouter) {
      try {
        var modelDecision = modules.modelRouter.chooseModel(processedMessage, {
          intent: routeResult.intent,
          confidence: routeResult.confidence,
          toolCount: (routeResult.requiredTools || []).length,
          isEscalated: !!(result.metadata.escalation),
          isVIP: !!(hookMeta.vip),
          decomposed: !!(result.metadata.decomposed),
          agentCount: (result.metadata.agents || []).length,
        });
        result.metadata.modelDecision = modelDecision;
        result.modelId = modelDecision.modelId;
        result.modelName = modelDecision.model;
      } catch (e) { /* fallback: server.js uses its default model */ }
    }

    // ── 25. Hook: pre_execute ──
    if (hookSystem) {
      try { hookSystem.run('pre_execute', { message: processedMessage, routeResult: routeResult, metadata: result.metadata }); } catch (e) {}
    }

    result.metadata.preprocessTimeMs = Date.now() - startTime;

  } catch (e) {
    console.warn('[Ruflo] processMessage error:', e.message);
  }

  return result;
}

/**
 * OUTBOUND: Post-process after Claude API response
 * Called AFTER Claude responds, before sending to user.
 */
function postProcess(originalMessage, response, metadata, responseContext) {
  metadata = metadata || {};
  responseContext = responseContext || {};
  var result = {
    cleanedResponse: null,
    learningRecorded: false,
    memoryStored: false,
    cached: false,
  };

  try {
    var success = responseContext.success !== undefined ? responseContext.success : true;
    var responseTimeMs = responseContext.responseTimeMs || 0;
    var tokenCount = responseContext.tokenCount || 0;
    var toolsUsed = responseContext.toolsUsed || [];

    // ── 1. Hook: post_execute ──
    if (hookSystem) {
      try {
        var hookResult = hookSystem.run('post_execute', { response: response, metadata: metadata, success: success });
        if (hookResult.response) result.cleanedResponse = hookResult.response;
      } catch (e) {}
    }

    var cleanResponse = result.cleanedResponse || response;

    // ── 2. Reasoning Bank: distill learning ──
    if (reasoningBank) {
      try {
        reasoningBank.recordOutcome(originalMessage, metadata.intent, {
          success: success,
          responseTimeMs: responseTimeMs,
          toolsUsed: toolsUsed,
          confidence: metadata.confidence,
        });
        result.learningRecorded = true;
      } catch (e) {}
    }

    // ── 3. Smart Router: Q-Learning feedback ──
    if (smartRouter && metadata.intent) {
      try {
        var reward = success ? (metadata.confidence > 0.7 ? 1.0 : 0.5) : -0.5;
        smartRouter.feedback(metadata.intent, reward, { responseTimeMs: responseTimeMs, tokenCount: tokenCount });
      } catch (e) {}
    }

    // ── 4. Swarm Coordinator: agent performance ──
    if (swarmCoordinator && metadata.agents) {
      try {
        for (var a = 0; a < metadata.agents.length; a++) {
          swarmCoordinator.recordPerformance(metadata.agents[a], {
            success: success,
            responseTimeMs: responseTimeMs,
            intent: metadata.intent,
          });
        }
      } catch (e) {}
    }

    // ── 5. Vector Memory: store interaction ──
    if (vectorMemory) {
      try {
        var namespace = _intentToNamespace(metadata.intent);
        vectorMemory.store(
          'Q: ' + originalMessage.substring(0, 200) + '\nA: ' + (cleanResponse || '').substring(0, 300),
          namespace,
          { intent: metadata.intent, sender: metadata.sender }
        );
        result.memoryStored = true;
      } catch (e) {}
    }

    // ── 6. Gossip Protocol: auto-generate gossip from response ──
    if (gossipProtocol) {
      try {
        if (toolsUsed.indexOf('calendar_create_event') >= 0) {
          gossipProtocol.autoGossipFromEvent('booking_created', metadata);
        }
        if (toolsUsed.some(function(t) { return t.startsWith('web_scrape'); })) {
          gossipProtocol.autoGossipFromEvent('price_found', { source: 'web_scrape' });
        }
        if (!success) {
          gossipProtocol.autoGossipFromEvent('tool_error', {
            tool: toolsUsed[0] || 'unknown',
            error: 'Tool execution failed',
          });
        }
      } catch (e) {}
    }

    // ── 7. Event Store: log outbound ──
    if (eventStore) {
      try {
        eventStore.messageSent(metadata.sender || 'unknown', (cleanResponse || '').substring(0, 200), {
          intent: metadata.intent,
          responseTimeMs: responseTimeMs,
          toolsUsed: toolsUsed,
        });
      } catch (e) {}
    }

    // ── 8. Drift Detector: record metrics ──
    if (driftDetector) {
      try {
        driftDetector.record('response_time_ms', responseTimeMs);
        driftDetector.record('avg_token_count', tokenCount);
        driftDetector.record('routing_confidence', metadata.confidence || 0.5);
        if (!success) driftDetector.record('error_rate', 1);
      } catch (e) {}
    }

    // ── 9. Metrics: record performance ──
    if (metricAggregator) {
      try {
        metricAggregator.increment('messages.processed');
        metricAggregator.increment('performance.api_calls');
        metricAggregator.timing('performance.response_time', responseTimeMs);
        metricAggregator.increment('performance.api_cost', 0.003);
        if (tokenCount) metricAggregator.record('performance.tokens', tokenCount);

        for (var t = 0; t < toolsUsed.length; t++) {
          if (toolsUsed[t] === 'calendar_create_event') metricAggregator.increment('business.bookings_created');
          if (toolsUsed[t] === 'gmail_send') metricAggregator.increment('business.emails_sent');
          if (toolsUsed[t].indexOf('web_scrape') === 0) metricAggregator.increment('business.web_scrapes');
        }
      } catch (e) {}
    }

    // ── 10. Hook: pre_send ──
    if (hookSystem) {
      try {
        var hookResult2 = hookSystem.run('pre_send', { response: cleanResponse, metadata: metadata });
        if (hookResult2.response) cleanResponse = hookResult2.response;
      } catch (e) {}
    }

    // ── 11. AI Defence: screen response ──
    if (aiDefence) {
      try {
        var screened = aiDefence.screenResponse(cleanResponse);
        if (screened.cleaned) cleanResponse = screened.cleaned;
      } catch (e) {}
    }

    // ── 12. Response Cache: store response ──
    if (responseCache && success) {
      try {
        responseCache.set(originalMessage, cleanResponse, {
          category: _intentToCategory(metadata.intent),
          metadata: { intent: metadata.intent },
        });
        result.cached = true;
      } catch (e) {}
    }

    // ── 12b. Model Router: record usage for cost tracking ──
    if (modules.modelRouter && metadata.modelDecision) {
      try {
        modules.modelRouter.recordUsage(
          metadata.modelDecision.model || 'sonnet',
          metadata.intent,
          responseContext.inputTokens || 0,
          responseContext.outputTokens || tokenCount || 0,
          metadata.modelDecision.complexity || 0.5,
          responseContext.fallbackUsed || false
        );
      } catch (e) {}
    }

    // ── 13. Context Window Manager: extract entities ──
    if (contextManager) {
      try {
        contextManager.compressConversation(metadata.sessionId || 'default', [
          { content: originalMessage, role: 'user' },
          { content: cleanResponse, role: 'assistant' },
        ]);
      } catch (e) {}
    }

    result.cleanedResponse = cleanResponse;
    result.postProcessTimeMs = Date.now() - (metadata.startTime || Date.now());

  } catch (e) {
    console.warn('[Ruflo] postProcess error:', e.message);
  }

  return result;
}

/**
 * MAINTENANCE: Periodic cleanup and optimization
 * Called every 6 hours.
 */
function runMaintenance() {
  var results = {};

  if (reasoningBank) { try { results.reasoning = reasoningBank.consolidate(); } catch (e) {} }
  if (vectorMemory) { try { results.memory = vectorMemory.cleanup(); } catch (e) {} }
  if (gossipProtocol) { try { results.gossip = gossipProtocol.cleanup(); } catch (e) {} }
  if (guidanceGates) { try { results.approvals = { expired: guidanceGates.expireOld() }; } catch (e) {} }
  if (circuitBreaker) { try { results.circuits = circuitBreaker.cleanup(); } catch (e) {} }
  if (contextManager) { try { results.context = contextManager.cleanup(); } catch (e) {} }
  if (responseCache) { try { results.cache = responseCache.cleanup(); } catch (e) {} }
  if (feedbackLoop) {
    try {
      results.feedback = {
        suggestions: feedbackLoop.generateSuggestions(),
        cleanup: feedbackLoop.cleanup(),
      };
    } catch (e) {}
  }
  if (metricAggregator) {
    try {
      results.metrics = {
        aggregated: metricAggregator.aggregate('hour'),
        cleanup: metricAggregator.cleanup(7),
      };
    } catch (e) {}
  }
  if (eventStore) { try { results.events = eventStore.cleanup(); } catch (e) {} }
  if (driftDetector) {
    try {
      results.drift = { health: driftDetector.getHealth(), checkpoint: driftDetector.checkpoint() };
    } catch (e) {}
  }
  if (workflowEngine) { try { results.workflows = workflowEngine.cleanup(); } catch (e) {} }

  return results;
}

/**
 * Execute a web scraper tool call
 */
function executeScraperTool(toolName, toolInput) {
  if (!webScraper) throw new Error('WebScraper not loaded');

  if (circuitBreaker) {
    return circuitBreaker.execute('web-scraper', function() {
      return webScraper.executeTool(toolName, toolInput);
    });
  }

  return webScraper.executeTool(toolName, toolInput);
}

/**
 * Analyze user feedback (triggered by next message)
 */
function analyzeFeedback(message, context) {
  if (!feedbackLoop) return null;
  try { return feedbackLoop.analyzeMessage(message, context); } catch (e) { return null; }
}

/**
 * Check approval gates for an action
 */
function checkApproval(actionContext) {
  if (!guidanceGates) return { approved: true };
  try { return guidanceGates.checkGate(actionContext); } catch (e) { return { approved: true }; }
}

/**
 * Start a business workflow
 */
function startWorkflow(templateId, context, startedBy) {
  if (!workflowEngine) return { error: 'WorkflowEngine not loaded' };
  try { return workflowEngine.startWorkflow(templateId, context || {}, startedBy || 'system'); } catch (e) { return { error: e.message }; }
}

/**
 * Get full system stats across all modules
 */
function getStats() {
  var stats = { modulesLoaded: loadedCount + '/' + moduleNames.length };

  for (var i = 0; i < moduleNames.length; i++) {
    var mod = moduleNames[i];
    if (modules[mod.key] && typeof modules[mod.key].getStats === 'function') {
      try { stats[mod.key] = modules[mod.key].getStats(); } catch (e) { stats[mod.key] = { error: e.message }; }
    } else {
      stats[mod.key] = modules[mod.key] ? true : false;
    }
  }

  return stats;
}

/**
 * Get dashboard data
 */
function getDashboard(timeRange) {
  if (!metricAggregator) return { error: 'MetricAggregator not loaded' };
  try {
    var dashboard = metricAggregator.getDashboard(timeRange || '24h');
    if (circuitBreaker) dashboard.serviceHealth = circuitBreaker.getHealth();
    if (responseCache) dashboard.cache = responseCache.getStats();
    if (feedbackLoop) dashboard.satisfaction = feedbackLoop.getStats();
    if (gossipProtocol) dashboard.gossip = gossipProtocol.getStats();
    if (workflowEngine) dashboard.workflows = workflowEngine.getStats();
    if (escalationManager) dashboard.escalations = escalationManager.getStats();
    if (driftDetector) dashboard.drift = driftDetector.getHealth();
    return dashboard;
  } catch (e) { return { error: e.message }; }
}

// ── Module Exports ──

module.exports = {
  // Core pipeline
  processMessage: processMessage,
  postProcess: postProcess,
  runMaintenance: runMaintenance,
  executeScraperTool: executeScraperTool,

  // Specific capabilities
  analyzeFeedback: analyzeFeedback,
  checkApproval: checkApproval,
  startWorkflow: startWorkflow,
  getDashboard: getDashboard,
  getStats: getStats,

  // Direct module access
  smartRouter: modules.smartRouter,
  swarmCoordinator: modules.swarmCoordinator,
  reasoningBank: modules.reasoningBank,
  aiDefence: modules.aiDefence,
  vectorMemory: modules.vectorMemory,
  policyEngine: modules.policyEngine,
  eventStore: modules.eventStore,
  hookSystem: modules.hookSystem,
  taskDecomposer: modules.taskDecomposer,
  driftDetector: modules.driftDetector,
  webScraper: modules.webScraper,
  gossipProtocol: modules.gossipProtocol,
  guidanceGates: modules.guidanceGates,
  circuitBreaker: modules.circuitBreaker,
  contextManager: modules.contextManager,
  escalationManager: modules.escalationManager,
  workflowEngine: modules.workflowEngine,
  responseCache: modules.responseCache,
  feedbackLoop: modules.feedbackLoop,
  templateEngine: modules.templateEngine,
  metricAggregator: modules.metricAggregator,
  modelRouter: modules.modelRouter,
  tokenOptimizer: modules.tokenOptimizer,
  backgroundDaemon: modules.backgroundDaemon,
  sessionManager: modules.sessionManager,
  auditor: modules.auditor,
  conductor: modules.conductor,
  rollback: modules.rollback,
  validator: modules.validator,
};
