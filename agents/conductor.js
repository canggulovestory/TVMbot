/**
 * TVMbot Multi-Step Workflow Conductor
 *
 * Adapted from TWO sources:
 *
 * 1. Edict's State Machine — enforces strict state transitions.
 *    Illegal transitions are blocked. Every step must complete before
 *    the next one starts.
 *
 * 2. wshobson/agents Conductor Plugin — manages multi-step workflows
 *    with pause, resume, retry, and revert capability.
 *
 * Use cases for TVMbot:
 * - New villa onboarding (create income rows + maintenance tab + periodic schedule)
 * - Month-end financial close (sync all sheets + calculate totals + archive)
 * - Maintenance escalation (overdue detection + notify PIC + notify manager)
 * - Bulk status updates across multiple sheets
 */

const fs = require('fs');
const path = require('path');
const auditor = require('./auditor');
const rollback = require('./rollback');

// Valid state transitions — illegal jumps are blocked
const STATE_MACHINE = {
  'pending':       ['in_progress', 'cancelled'],
  'in_progress':   ['awaiting_input', 'step_complete', 'failed', 'paused', 'cancelled'],
  'awaiting_input': ['in_progress', 'cancelled'],
  'step_complete': ['in_progress', 'completed', 'cancelled'],  // moves to next step or finishes
  'paused':        ['in_progress', 'cancelled'],
  'failed':        ['in_progress', 'cancelled'],  // can retry
  'completed':     [],  // terminal state
  'cancelled':     []   // terminal state
};

class WorkflowConductor {
  constructor() {
    this.workflowDir = path.join(__dirname, '..', 'logs', 'workflows');
    this.activeWorkflows = new Map();

    // Ensure workflow log directory exists
    if (!fs.existsSync(this.workflowDir)) {
      fs.mkdirSync(this.workflowDir, { recursive: true });
    }

    // Pre-defined workflow templates for TVMbot
    this.templates = {

      // Workflow 1: Onboard a new villa across all sheets
      new_villa_onboarding: {
        name: 'New Villa Onboarding',
        description: 'Add a new villa to all Google Sheets (income, maintenance, periodic schedule)',
        steps: [
          {
            id: 'create_income_rows',
            name: 'Create income rows in Staff Sheet',
            integration: 'finance',
            action: 'createIncomeRow',
            rollbackable: true
          },
          {
            id: 'add_maintenance_tab',
            name: 'Add maintenance tab for villa',
            integration: 'maintenance',
            action: 'createVillaTab',
            rollbackable: true
          },
          {
            id: 'setup_periodic_schedule',
            name: 'Setup periodic cleaning schedule',
            integration: 'periodic-schedule',
            action: 'createVillaSchedule',
            rollbackable: true
          },
          {
            id: 'confirm_setup',
            name: 'Verify all sheets updated correctly',
            integration: 'system',
            action: 'verifyOnboarding',
            rollbackable: false
          }
        ]
      },

      // Workflow 2: Month-end financial reconciliation
      month_end_close: {
        name: 'Month-End Financial Close',
        description: 'Sync income data from Staff Sheet to Internal Sheet and verify totals',
        steps: [
          {
            id: 'read_staff_totals',
            name: 'Read monthly totals from Staff Sheet',
            integration: 'finance',
            action: 'readMonthlyTotals',
            rollbackable: false
          },
          {
            id: 'sync_to_internal',
            name: 'Write totals to Internal Sheet (EzyPlanners)',
            integration: 'finance',
            action: 'syncToInternal',
            rollbackable: true
          },
          {
            id: 'verify_sync',
            name: 'Verify Staff Sheet totals match Internal Sheet',
            integration: 'finance',
            action: 'verifySyncTotals',
            rollbackable: false
          },
          {
            id: 'generate_summary',
            name: 'Generate monthly summary for WhatsApp',
            integration: 'system',
            action: 'generateMonthlySummary',
            rollbackable: false
          }
        ]
      },

      // Workflow 3: Maintenance escalation chain
      maintenance_escalation: {
        name: 'Maintenance Escalation',
        description: 'Escalate overdue maintenance items through notification chain',
        steps: [
          {
            id: 'detect_overdue',
            name: 'Scan all tabs for overdue items (7+ days)',
            integration: 'maintenance',
            action: 'findOverdueItems',
            rollbackable: false
          },
          {
            id: 'notify_pic',
            name: 'Send WhatsApp reminder to Person In Charge',
            integration: 'whatsapp',
            action: 'sendReminder',
            rollbackable: false
          },
          {
            id: 'update_status',
            name: 'Mark items as escalated in sheet',
            integration: 'maintenance',
            action: 'markEscalated',
            rollbackable: true
          },
          {
            id: 'notify_manager',
            name: 'Send escalation report to manager',
            integration: 'whatsapp',
            action: 'sendEscalationReport',
            rollbackable: false
          }
        ]
      },

      // Workflow 4: Bulk periodic schedule update
      bulk_schedule_update: {
        name: 'Bulk Periodic Schedule Update',
        description: 'Update due dates and statuses across all villa periodic schedule tabs',
        steps: [
          {
            id: 'scan_all_tabs',
            name: 'Read all villa tabs in periodic schedule',
            integration: 'periodic-schedule',
            action: 'scanAllTabs',
            rollbackable: false
          },
          {
            id: 'calculate_due_dates',
            name: 'Calculate new due dates for each item',
            integration: 'periodic-schedule',
            action: 'calculateDueDates',
            rollbackable: false
          },
          {
            id: 'write_updates',
            name: 'Write due dates and statuses (skip formula cells)',
            integration: 'periodic-schedule',
            action: 'writeDueDates',
            rollbackable: true
          },
          {
            id: 'verify_no_formulas_overwritten',
            name: 'Verify no formulas were overwritten',
            integration: 'system',
            action: 'verifyFormulasIntact',
            rollbackable: false
          }
        ]
      }
    };

    console.log('[Conductor] Initialized with', Object.keys(this.templates).length, 'workflow templates');
  }

  /**
   * Start a new workflow from a template
   */
  startWorkflow(templateId, params = {}, triggeredBy = 'unknown') {
    const template = this.templates[templateId];
    if (!template) {
      return { success: false, error: `Unknown workflow template: ${templateId}` };
    }

    const workflowId = `wf_${templateId}_${Date.now()}`;

    const workflow = {
      id: workflowId,
      templateId,
      name: template.name,
      description: template.description,
      params,
      triggeredBy,
      status: 'pending',
      currentStepIndex: 0,
      steps: template.steps.map(step => ({
        ...step,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        result: null,
        error: null
      })),
      transactionId: null,  // linked rollback transaction
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null
    };

    this.activeWorkflows.set(workflowId, workflow);
    this._saveWorkflow(workflow);

    auditor.logSystem({
      event: 'workflow_started',
      details: { workflowId, name: template.name, stepCount: template.steps.length },
      status: 'info'
    });

    console.log(`[Conductor] Workflow started: ${template.name} (${workflowId})`);
    return { success: true, workflowId, name: template.name, totalSteps: template.steps.length };
  }

  /**
   * Execute the next step in a workflow
   * Returns the step details so executor.js can run the actual integration call
   */
  getNextStep(workflowId) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };

    if (workflow.status === 'completed' || workflow.status === 'cancelled') {
      return { success: false, error: `Workflow is ${workflow.status}` };
    }

    const step = workflow.steps[workflow.currentStepIndex];
    if (!step) {
      return { success: false, error: 'No more steps' };
    }

    // Transition workflow to in_progress
    this._transition(workflow, 'in_progress');
    step.status = 'in_progress';
    step.startedAt = new Date().toISOString();

    // Start a rollback transaction if this step is rollbackable
    if (step.rollbackable && !workflow.transactionId) {
      workflow.transactionId = rollback.beginTransaction(workflow.name, workflow.triggeredBy);
    }

    this._saveWorkflow(workflow);

    return {
      success: true,
      step: {
        id: step.id,
        name: step.name,
        integration: step.integration,
        action: step.action,
        rollbackable: step.rollbackable,
        stepNumber: workflow.currentStepIndex + 1,
        totalSteps: workflow.steps.length
      },
      params: workflow.params,
      transactionId: workflow.transactionId
    };
  }

  /**
   * Mark the current step as complete and advance
   */
  completeStep(workflowId, result = null) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };

    const step = workflow.steps[workflow.currentStepIndex];
    step.status = 'completed';
    step.completedAt = new Date().toISOString();
    step.result = result;

    this._transition(workflow, 'step_complete');

    // Move to next step
    workflow.currentStepIndex++;

    if (workflow.currentStepIndex >= workflow.steps.length) {
      // All steps done
      this._transition(workflow, 'completed');
      workflow.completedAt = new Date().toISOString();

      // Commit the rollback transaction
      if (workflow.transactionId) {
        rollback.commitTransaction(workflow.transactionId);
      }

      auditor.logSystem({
        event: 'workflow_completed',
        details: { workflowId, name: workflow.name },
        status: 'success'
      });

      console.log(`[Conductor] Workflow COMPLETED: ${workflow.name}`);
    }

    this._saveWorkflow(workflow);

    return {
      success: true,
      isComplete: workflow.status === 'completed',
      nextStep: workflow.currentStepIndex < workflow.steps.length
        ? workflow.steps[workflow.currentStepIndex].name
        : null
    };
  }

  /**
   * Mark the current step as failed
   * Option to retry or rollback the entire workflow
   */
  async failStep(workflowId, error) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };

    const step = workflow.steps[workflow.currentStepIndex];
    step.status = 'failed';
    step.error = error;

    this._transition(workflow, 'failed');

    auditor.logSystem({
      event: 'workflow_step_failed',
      details: { workflowId, step: step.name, error },
      status: 'failed'
    });

    console.log(`[Conductor] Step FAILED in ${workflow.name}: ${step.name} — ${error}`);

    this._saveWorkflow(workflow);

    return {
      success: true,
      failedStep: step.name,
      canRetry: true,
      canRollback: workflow.transactionId !== null,
      transactionId: workflow.transactionId
    };
  }

  /**
   * Retry a failed step
   */
  retryStep(workflowId) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };

    if (workflow.status !== 'failed') {
      return { success: false, error: 'Workflow is not in failed state' };
    }

    const step = workflow.steps[workflow.currentStepIndex];
    step.status = 'pending';
    step.error = null;

    console.log(`[Conductor] Retrying step: ${step.name}`);
    return this.getNextStep(workflowId);
  }

  /**
   * Pause a workflow (can be resumed later)
   */
  pauseWorkflow(workflowId) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };

    this._transition(workflow, 'paused');
    this._saveWorkflow(workflow);

    console.log(`[Conductor] Workflow PAUSED: ${workflow.name}`);
    return { success: true };
  }

  /**
   * Resume a paused workflow
   */
  resumeWorkflow(workflowId) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };

    if (workflow.status !== 'paused') {
      return { success: false, error: 'Workflow is not paused' };
    }

    return this.getNextStep(workflowId);
  }

  /**
   * Cancel a workflow and rollback all completed writes
   */
  async cancelWorkflow(workflowId) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };

    let rollbackResult = null;

    // Rollback if there's an active transaction
    if (workflow.transactionId) {
      rollbackResult = await rollback.rollbackTransaction(workflow.transactionId);
    }

    this._transition(workflow, 'cancelled');
    workflow.completedAt = new Date().toISOString();
    workflow.error = 'Cancelled by user';

    this._saveWorkflow(workflow);

    auditor.logSystem({
      event: 'workflow_cancelled',
      details: { workflowId, name: workflow.name, rollbackResult },
      status: 'cancelled'
    });

    console.log(`[Conductor] Workflow CANCELLED: ${workflow.name}`);
    return { success: true, rollbackResult };
  }

  /**
   * Get status of a workflow
   */
  getWorkflowStatus(workflowId) {
    const workflow = this.activeWorkflows.get(workflowId);
    if (!workflow) return null;

    return {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      progress: `${workflow.currentStepIndex}/${workflow.steps.length}`,
      currentStep: workflow.steps[workflow.currentStepIndex]?.name || 'Done',
      steps: workflow.steps.map(s => ({
        name: s.name,
        status: s.status,
        error: s.error
      })),
      startedAt: workflow.startedAt,
      triggeredBy: workflow.triggeredBy
    };
  }

  /**
   * Get all active workflows
   */
  getActiveWorkflows() {
    const active = [];
    for (const [id, wf] of this.activeWorkflows) {
      if (!['completed', 'cancelled'].includes(wf.status)) {
        active.push(this.getWorkflowStatus(id));
      }
    }
    return active;
  }

  /**
   * List available workflow templates
   */
  getTemplates() {
    return Object.entries(this.templates).map(([id, t]) => ({
      id,
      name: t.name,
      description: t.description,
      steps: t.steps.length
    }));
  }

  // ── Internal helpers ──

  /**
   * Validate and apply state transition
   */
  _transition(workflow, newStatus) {
    const allowed = STATE_MACHINE[workflow.status];
    if (!allowed || !allowed.includes(newStatus)) {
      console.error(`[Conductor] Illegal transition: ${workflow.status} → ${newStatus}`);
      return false;
    }
    workflow.status = newStatus;
    return true;
  }

  /**
   * Save workflow state to file (for crash recovery)
   */
  _saveWorkflow(workflow) {
    try {
      const filepath = path.join(this.workflowDir, `${workflow.id}.json`);
      fs.writeFileSync(filepath, JSON.stringify(workflow, null, 2));
    } catch (err) {
      console.error('[Conductor] Failed to save workflow:', err.message);
    }
  }

  /**
   * Load persisted workflows on startup
   */
  loadPersistedWorkflows() {
    try {
      const files = fs.readdirSync(this.workflowDir);
      let loaded = 0;
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.workflowDir, file), 'utf8'));
          if (data.status && !['completed', 'cancelled'].includes(data.status)) {
            this.activeWorkflows.set(data.id, data);
            loaded++;
          }
        } catch { /* skip corrupt files */ }
      }
      if (loaded > 0) {
        console.log(`[Conductor] Loaded ${loaded} persisted workflows`);
      }
    } catch (err) {
      console.error('[Conductor] Failed to load workflows:', err.message);
    }
  }
}

// Export singleton instance
const conductor = new WorkflowConductor();

  


WorkflowConductor.prototype.detectWorkflow = function(message) {
  var msg = (message || '').toLowerCase();
  var triggers = [
    { patterns: ['new villa', 'onboard villa', 'add villa', 'setup villa', 'register villa'],
      templateId: 'new_villa_onboarding', confidence: 0.8 },
    { patterns: ['month end', 'monthly close', 'reconcil', 'financial close', 'month-end'],
      templateId: 'month_end_close', confidence: 0.7 },
    { patterns: ['overdue maintenance', 'escalat', 'stuck maintenance', 'pending too long'],
      templateId: 'maintenance_escalation', confidence: 0.7 },
    { patterns: ['guest check', 'checkin', 'check-in', 'arriving today', 'guest arrival'],
      templateId: 'guest_checkin', confidence: 0.8 },
  ];

  for (var t = 0; t < triggers.length; t++) {
    var trigger = triggers[t];
    for (var p = 0; p < trigger.patterns.length; p++) {
      if (msg.indexOf(trigger.patterns[p]) >= 0) {
        return {
          templateId: trigger.templateId,
          template: this.templates[trigger.templateId],
          confidence: trigger.confidence,
          matchedPattern: trigger.patterns[p]
        };
      }
    }
  }
  return null;
};

module.exports = conductor;
