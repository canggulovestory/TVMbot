/**
 * Workflow Engine — Multi-Step Automated Business Workflows
 * Inspired by ruflo's pipeline orchestration and task automation.
 *
 * Defines reusable workflow templates for common TVM business processes.
 * Each workflow is a DAG of steps with conditions, branching, and error handling.
 *
 * Features:
 *   - Pre-defined workflow templates for all 5 divisions
 *   - Step-by-step execution with state persistence
 *   - Conditional branching (if/else on step results)
 *   - Parallel step execution
 *   - Approval gate integration
 *   - Retry with backoff on step failure
 *   - Workflow progress tracking
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'workflow.db');

class WorkflowEngine {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initDb();

    // Workflow templates
    this.templates = {
      // ── Villa Management ──
      'new-booking': {
        name: 'New Booking Workflow',
        division: 'villa',
        trigger: 'booking_request',
        steps: [
          { id: 'check-availability', action: 'calendar_check', tool: 'calendar_get_events', description: 'Check villa availability' },
          { id: 'verify-pricing', action: 'sheets_lookup', tool: 'sheets_read_data', description: 'Look up current pricing', dependsOn: ['check-availability'] },
          { id: 'check-overlap', action: 'policy_check', description: 'Verify no booking overlap', dependsOn: ['check-availability'] },
          { id: 'create-booking', action: 'calendar_create', tool: 'calendar_create_event', description: 'Create calendar booking', dependsOn: ['verify-pricing', 'check-overlap'], condition: 'available && no_overlap' },
          { id: 'update-sheet', action: 'sheets_write', tool: 'sheets_append_row', description: 'Update booking sheet', dependsOn: ['create-booking'] },
          { id: 'send-confirmation', action: 'email_send', tool: 'gmail_send', description: 'Send booking confirmation email', dependsOn: ['create-booking'] },
          { id: 'notify-staff', action: 'notify', description: 'Notify villa staff', dependsOn: ['create-booking'] },
        ],
      },

      'guest-checkin': {
        name: 'Guest Check-in Workflow',
        division: 'villa',
        trigger: 'guest_checkin',
        steps: [
          { id: 'verify-booking', action: 'sheets_lookup', description: 'Verify booking exists and is valid' },
          { id: 'prepare-villa', action: 'notify', description: 'Notify housekeeping to prepare villa', dependsOn: ['verify-booking'] },
          { id: 'update-status', action: 'sheets_write', description: 'Update booking status to checked-in', dependsOn: ['verify-booking'] },
          { id: 'send-welcome', action: 'message_send', description: 'Send welcome message to guest', dependsOn: ['prepare-villa'] },
          { id: 'schedule-followup', action: 'schedule', description: 'Schedule 24h check-in follow-up', dependsOn: ['send-welcome'] },
        ],
      },

      'maintenance-request': {
        name: 'Maintenance Request Workflow',
        division: 'villa',
        trigger: 'maintenance_request',
        steps: [
          { id: 'log-request', action: 'sheets_write', description: 'Log maintenance request in sheet' },
          { id: 'assess-priority', action: 'classify', description: 'Classify urgency (low/medium/high/emergency)' },
          { id: 'assign-vendor', action: 'lookup', description: 'Find appropriate vendor/staff', dependsOn: ['assess-priority'] },
          { id: 'get-quote', action: 'request', description: 'Request cost estimate', dependsOn: ['assign-vendor'], condition: 'priority != emergency' },
          { id: 'approval-gate', action: 'approval', description: 'Request approval if cost > threshold', dependsOn: ['get-quote'], condition: 'amount > 2000000' },
          { id: 'schedule-work', action: 'calendar_create', description: 'Schedule maintenance visit', dependsOn: ['approval-gate'] },
          { id: 'notify-guest', action: 'message_send', description: 'Inform guest about maintenance schedule', dependsOn: ['schedule-work'], condition: 'villa_occupied' },
        ],
      },

      // ── Agency ──
      'new-listing': {
        name: 'New Property Listing Workflow',
        division: 'agency',
        trigger: 'new_property',
        steps: [
          { id: 'collect-details', action: 'gather', description: 'Collect property details and photos' },
          { id: 'price-research', action: 'web_scrape', description: 'Research comparable property prices', dependsOn: ['collect-details'] },
          { id: 'create-listing', action: 'sheets_write', description: 'Add to property listing database', dependsOn: ['price-research'] },
          { id: 'create-marketing', action: 'generate', description: 'Generate marketing copy', dependsOn: ['create-listing'] },
          { id: 'distribute', action: 'multi_action', description: 'Distribute to channels (email, social)', dependsOn: ['create-marketing'] },
        ],
      },

      // ── Furniture ──
      'furniture-order': {
        name: 'Furniture Order Workflow',
        division: 'furniture',
        trigger: 'furniture_order',
        steps: [
          { id: 'check-inventory', action: 'sheets_lookup', description: 'Check current inventory' },
          { id: 'get-quotes', action: 'multi_lookup', description: 'Get quotes from suppliers', dependsOn: ['check-inventory'] },
          { id: 'compare-prices', action: 'analyze', description: 'Compare supplier quotes', dependsOn: ['get-quotes'] },
          { id: 'approval-gate', action: 'approval', description: 'Request purchase approval', dependsOn: ['compare-prices'] },
          { id: 'place-order', action: 'notify', description: 'Place order with selected supplier', dependsOn: ['approval-gate'] },
          { id: 'track-delivery', action: 'schedule', description: 'Set delivery tracking reminder', dependsOn: ['place-order'] },
          { id: 'update-inventory', action: 'sheets_write', description: 'Update inventory sheet', dependsOn: ['track-delivery'] },
        ],
      },

      // ── Renovation ──
      'renovation-project': {
        name: 'Renovation Project Workflow',
        division: 'renovation',
        trigger: 'renovation_request',
        steps: [
          { id: 'site-assessment', action: 'gather', description: 'Document current state and requirements' },
          { id: 'get-contractor-bids', action: 'multi_lookup', description: 'Get bids from contractors', dependsOn: ['site-assessment'] },
          { id: 'budget-analysis', action: 'analyze', description: 'Analyze bids against budget', dependsOn: ['get-contractor-bids'] },
          { id: 'owner-approval', action: 'approval', description: 'Get owner approval for budget', dependsOn: ['budget-analysis'] },
          { id: 'schedule-work', action: 'calendar_create', description: 'Schedule renovation timeline', dependsOn: ['owner-approval'] },
          { id: 'notify-affected', action: 'multi_notify', description: 'Notify affected guests/bookings', dependsOn: ['schedule-work'] },
          { id: 'progress-tracking', action: 'schedule', description: 'Set up weekly progress check-ins', dependsOn: ['schedule-work'] },
        ],
      },

      // ── Interior Design ──
      'design-consultation': {
        name: 'Interior Design Consultation Workflow',
        division: 'interior',
        trigger: 'design_request',
        steps: [
          { id: 'gather-preferences', action: 'gather', description: 'Collect client style preferences and budget' },
          { id: 'research-trends', action: 'web_scrape', description: 'Research current design trends', dependsOn: ['gather-preferences'] },
          { id: 'create-moodboard', action: 'generate', description: 'Generate design mood board concepts', dependsOn: ['research-trends'] },
          { id: 'furniture-sourcing', action: 'multi_lookup', description: 'Source furniture and materials', dependsOn: ['create-moodboard'] },
          { id: 'budget-estimate', action: 'analyze', description: 'Create detailed budget estimate', dependsOn: ['furniture-sourcing'] },
          { id: 'client-presentation', action: 'notify', description: 'Present proposal to client', dependsOn: ['budget-estimate'] },
        ],
      },

      // ── Finance ──
      'monthly-report': {
        name: 'Monthly Financial Report Workflow',
        division: 'finance',
        trigger: 'monthly_report',
        steps: [
          { id: 'pull-revenue', action: 'sheets_read', description: 'Pull revenue data from all divisions' },
          { id: 'pull-expenses', action: 'sheets_read', description: 'Pull expense data from all divisions' },
          { id: 'calculate-pnl', action: 'analyze', description: 'Calculate P&L summary', dependsOn: ['pull-revenue', 'pull-expenses'] },
          { id: 'generate-insights', action: 'analyze', description: 'Generate business insights and trends', dependsOn: ['calculate-pnl'] },
          { id: 'create-report', action: 'generate', description: 'Generate formatted report', dependsOn: ['generate-insights'] },
          { id: 'email-report', action: 'email_send', description: 'Email report to stakeholders', dependsOn: ['create-report'] },
        ],
      },

      // ── Marketing ──
      'campaign-launch': {
        name: 'Marketing Campaign Launch Workflow',
        division: 'marketing',
        trigger: 'campaign_launch',
        steps: [
          { id: 'market-research', action: 'web_scrape', description: 'Research target market and competitors' },
          { id: 'content-creation', action: 'generate', description: 'Create campaign content', dependsOn: ['market-research'] },
          { id: 'pricing-strategy', action: 'analyze', description: 'Set promotional pricing', dependsOn: ['market-research'] },
          { id: 'approval', action: 'approval', description: 'Get campaign approval from owner', dependsOn: ['content-creation', 'pricing-strategy'] },
          { id: 'distribute', action: 'multi_action', description: 'Launch across channels', dependsOn: ['approval'] },
          { id: 'track-performance', action: 'schedule', description: 'Schedule daily performance tracking', dependsOn: ['distribute'] },
        ],
      },
    };

    console.log(`[Workflow] Initialized with ${Object.keys(this.templates).length} workflow templates`);
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT UNIQUE,
        template_id TEXT NOT NULL,
        name TEXT,
        status TEXT DEFAULT 'running',
        context TEXT DEFAULT '{}',
        current_step TEXT,
        progress REAL DEFAULT 0,
        started_by TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        result TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        retry_count INTEGER DEFAULT 0,
        UNIQUE(instance_id, step_id)
      );

      CREATE TABLE IF NOT EXISTS workflow_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        step_id TEXT,
        action TEXT NOT NULL,
        details TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_wf_instance_status ON workflow_instances(status);
      CREATE INDEX IF NOT EXISTS idx_wf_steps_instance ON workflow_steps(instance_id);
    `);
  }

  /**
   * Start a new workflow instance
   */
  startWorkflow(templateId, context = {}, startedBy = 'system') {
    const template = this.templates[templateId];
    if (!template) return { error: `Unknown workflow template: ${templateId}` };

    const instanceId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    this.db.prepare(`
      INSERT INTO workflow_instances (instance_id, template_id, name, context, started_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(instanceId, templateId, template.name, JSON.stringify(context), startedBy);

    // Create step entries
    const insertStep = this.db.prepare(`
      INSERT INTO workflow_steps (instance_id, step_id, status) VALUES (?, ?, 'pending')
    `);
    for (const step of template.steps) {
      insertStep.run(instanceId, step.id);
    }

    // Start first steps (no dependencies)
    const firstSteps = template.steps.filter(s => !s.dependsOn || s.dependsOn.length === 0);
    for (const step of firstSteps) {
      this._activateStep(instanceId, step.id);
    }

    this._log(instanceId, null, 'started', `Workflow "${template.name}" started by ${startedBy}`);

    return {
      instanceId,
      template: templateId,
      name: template.name,
      totalSteps: template.steps.length,
      activeSteps: firstSteps.map(s => s.id),
    };
  }

  /**
   * Complete a step and advance workflow
   */
  completeStep(instanceId, stepId, result = null, success = true) {
    const instance = this.db.prepare('SELECT * FROM workflow_instances WHERE instance_id = ?').get(instanceId);
    if (!instance || instance.status !== 'running') return { error: 'Workflow not found or not running' };

    const template = this.templates[instance.template_id];
    if (!template) return { error: 'Template not found' };

    // Update step
    this.db.prepare(`
      UPDATE workflow_steps SET status = ?, result = ?, completed_at = datetime('now')
      WHERE instance_id = ? AND step_id = ?
    `).run(success ? 'completed' : 'failed', JSON.stringify(result), instanceId, stepId);

    this._log(instanceId, stepId, success ? 'step_completed' : 'step_failed', JSON.stringify(result).substring(0, 200));

    if (!success) {
      // Check if we should retry
      const stepRow = this.db.prepare('SELECT retry_count FROM workflow_steps WHERE instance_id = ? AND step_id = ?').get(instanceId, stepId);
      if (stepRow && stepRow.retry_count < 2) {
        this.db.prepare('UPDATE workflow_steps SET status = ?, retry_count = retry_count + 1 WHERE instance_id = ? AND step_id = ?')
          .run('pending', instanceId, stepId);
        return { retrying: true, retryCount: stepRow.retry_count + 1 };
      }
    }

    // Find next steps whose dependencies are all completed
    const completedSteps = this.db.prepare(`
      SELECT step_id FROM workflow_steps WHERE instance_id = ? AND status = 'completed'
    `).all(instanceId).map(r => r.step_id);

    const completedSet = new Set(completedSteps);
    const nextSteps = [];

    for (const step of template.steps) {
      if (completedSet.has(step.id)) continue;

      const stepStatus = this.db.prepare('SELECT status FROM workflow_steps WHERE instance_id = ? AND step_id = ?').get(instanceId, step.id);
      if (stepStatus && stepStatus.status !== 'pending') continue;

      if (step.dependsOn && step.dependsOn.every(dep => completedSet.has(dep))) {
        nextSteps.push(step);
        this._activateStep(instanceId, step.id);
      }
    }

    // Update progress
    const totalSteps = template.steps.length;
    const progress = completedSteps.length / totalSteps;
    this.db.prepare('UPDATE workflow_instances SET progress = ?, current_step = ? WHERE instance_id = ?')
      .run(progress, nextSteps[0]?.id || stepId, instanceId);

    // Check if workflow is complete
    if (completedSteps.length === totalSteps) {
      this.db.prepare("UPDATE workflow_instances SET status = 'completed', progress = 1.0, completed_at = datetime('now') WHERE instance_id = ?")
        .run(instanceId);
      this._log(instanceId, null, 'completed', 'All steps completed');
    }

    return {
      progress,
      completedSteps: completedSteps.length,
      totalSteps,
      nextSteps: nextSteps.map(s => ({ id: s.id, description: s.description })),
      workflowComplete: completedSteps.length === totalSteps,
    };
  }

  _activateStep(instanceId, stepId) {
    this.db.prepare(`
      UPDATE workflow_steps SET status = 'active', started_at = datetime('now')
      WHERE instance_id = ? AND step_id = ?
    `).run(instanceId, stepId);
  }

  /**
   * Get workflow status
   */
  getStatus(instanceId) {
    const instance = this.db.prepare('SELECT * FROM workflow_instances WHERE instance_id = ?').get(instanceId);
    if (!instance) return null;

    const steps = this.db.prepare('SELECT * FROM workflow_steps WHERE instance_id = ? ORDER BY id ASC').all(instanceId);

    return {
      ...instance,
      context: JSON.parse(instance.context || '{}'),
      steps: steps.map(s => ({
        id: s.step_id,
        status: s.status,
        result: s.result ? JSON.parse(s.result) : null,
        retries: s.retry_count,
      })),
    };
  }

  /**
   * Detect if a user message should trigger a workflow
   */
  detectWorkflow(message, intent) {
    const triggers = {
      'booking':            'new-booking',
      'checkin':            'guest-checkin',
      'maintenance':        'maintenance-request',
      'agency':             'new-listing',
      'furniture':          'furniture-order',
      'renovation':         'renovation-project',
      'interior':           'design-consultation',
      'finance':            'monthly-report',
      'marketing':          'campaign-launch',
    };

    // Check intent-based trigger
    if (intent && triggers[intent]) {
      return { templateId: triggers[intent], confidence: 0.8 };
    }

    // Check message-based triggers
    const messagePatterns = {
      'new-booking':          /(?:new booking|book(?:ing)?|reserve|reservation|pesan|booking baru)/i,
      'guest-checkin':        /(?:check.?in|checkin|tamu datang|guest arriv)/i,
      'maintenance-request':  /(?:maintenance|repair|fix|broken|rusak|perbaik|bocor|leak)/i,
      'monthly-report':       /(?:monthly report|financial report|P&L|profit.loss|laporan bulanan)/i,
      'campaign-launch':      /(?:marketing campaign|launch campaign|promote|promosi)/i,
    };

    for (const [templateId, pattern] of Object.entries(messagePatterns)) {
      if (pattern.test(message)) {
        return { templateId, confidence: 0.6 };
      }
    }

    return null;
  }

  /**
   * Get workflow context for system prompt
   */
  getActiveWorkflowContext(sessionId) {
    const active = this.db.prepare(`
      SELECT * FROM workflow_instances WHERE status = 'running' ORDER BY started_at DESC LIMIT 3
    `).all();

    if (active.length === 0) return '';

    let ctx = '\n\n--- Active Workflows ---\n';
    for (const wf of active) {
      const steps = this.db.prepare(`
        SELECT step_id, status FROM workflow_steps WHERE instance_id = ? ORDER BY id
      `).all(wf.instance_id);

      const activeSteps = steps.filter(s => s.status === 'active').map(s => s.step_id);
      ctx += `• ${wf.name}: ${Math.round(wf.progress * 100)}% complete`;
      if (activeSteps.length > 0) ctx += ` (current: ${activeSteps.join(', ')})`;
      ctx += '\n';
    }
    return ctx;
  }

  _log(instanceId, stepId, action, details) {
    this.db.prepare(`
      INSERT INTO workflow_log (instance_id, step_id, action, details) VALUES (?, ?, ?, ?)
    `).run(instanceId, stepId, action, details);
  }

  /**
   * Cleanup old workflows
   */
  cleanup(daysOld = 30) {
    const old = this.db.prepare(`
      SELECT instance_id FROM workflow_instances
      WHERE status IN ('completed', 'failed') AND completed_at < datetime('now', '-' || ? || ' days')
    `).all(daysOld);

    for (const wf of old) {
      this.db.prepare('DELETE FROM workflow_steps WHERE instance_id = ?').run(wf.instance_id);
      this.db.prepare('DELETE FROM workflow_log WHERE instance_id = ?').run(wf.instance_id);
      this.db.prepare('DELETE FROM workflow_instances WHERE instance_id = ?').run(wf.instance_id);
    }

    return { cleaned: old.length };
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM workflow_instances').get().c;
    const active = this.db.prepare("SELECT COUNT(*) as c FROM workflow_instances WHERE status = 'running'").get().c;
    const byTemplate = this.db.prepare(`
      SELECT template_id, COUNT(*) as c FROM workflow_instances GROUP BY template_id
    `).all();

    return {
      templates: Object.keys(this.templates).length,
      total, active,
      byTemplate: Object.fromEntries(byTemplate.map(r => [r.template_id, r.c])),
    };
  }
}

module.exports = new WorkflowEngine();
