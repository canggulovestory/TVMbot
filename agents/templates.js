/**
 * TVMbot Template Command Agent
 *
 * Adapted from wshobson/agents "Agent Teams Preset System".
 * They have pre-configured team setups (Review Team, Debug Team, Feature Team)
 * with defined roles and ordered steps.
 *
 * We apply the same concept to WhatsApp conversation flows.
 * Instead of dev team presets, ours are villa management presets:
 * - "Log Income" template with structured questions
 * - "Report Maintenance" template with required fields
 * - "Update Status" template with validation
 *
 * Each template defines: trigger words, ordered steps, validation rules,
 * and which executor function to call at the end.
 */

class TemplateEngine {
  constructor() {
    // Active conversations using templates (WhatsApp number → state)
    this.activeSessions = new Map();

    // ── TEMPLATE DEFINITIONS ──

    this.templates = {

      // ─────────────────────────────────────────────
      // Template 1: Log Income Entry
      // ─────────────────────────────────────────────
      log_income: {
        name: 'Log Income',
        description: 'Record a new income entry to Staff Sheet',
        triggers: ['log income', 'new income', 'add income', 'record income', 'new booking'],
        steps: [
          {
            id: 'villa',
            prompt: 'Which villa is this for?',
            field: 'villa',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please enter a villa name'
          },
          {
            id: 'checkin',
            prompt: 'What is the check-in date? (DD/MM/YYYY)',
            field: 'checkinDate',
            type: 'date',
            required: true,
            validate: (val) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(val),
            errorMessage: 'Please use DD/MM/YYYY format'
          },
          {
            id: 'checkout',
            prompt: 'What is the check-out date? (DD/MM/YYYY)',
            field: 'checkoutDate',
            type: 'date',
            required: true,
            validate: (val) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(val),
            errorMessage: 'Please use DD/MM/YYYY format'
          },
          {
            id: 'guest',
            prompt: 'Guest name?',
            field: 'guestName',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please enter the guest name'
          },
          {
            id: 'platform',
            prompt: 'Which platform? (Booking.com / Airbnb / Direct / Other)',
            field: 'platform',
            type: 'choice',
            options: ['Booking.com', 'Airbnb', 'Direct', 'Other'],
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please specify the booking platform'
          },
          {
            id: 'amount',
            prompt: 'Total booking amount? (number only, in IDR)',
            field: 'amount',
            type: 'number',
            required: true,
            validate: (val) => !isNaN(Number(val.replace(/[,.\s]/g, ''))) && Number(val.replace(/[,.\s]/g, '')) > 0,
            errorMessage: 'Please enter a valid amount (numbers only)'
          },
          {
            id: 'confirm',
            prompt: null, // Auto-generated confirmation message
            field: '_confirm',
            type: 'confirm',
            required: true,
            validate: (val) => ['yes', 'y', 'ok', 'confirm', 'correct'].includes(val.toLowerCase().trim()),
            errorMessage: 'Reply YES to confirm or NO to cancel'
          }
        ],
        executor: 'finance.addIncome',
        buildConfirmation: (data) => {
          return `Please confirm this income entry:\n\n` +
            `Villa: ${data.villa}\n` +
            `Check-in: ${data.checkinDate}\n` +
            `Check-out: ${data.checkoutDate}\n` +
            `Guest: ${data.guestName}\n` +
            `Platform: ${data.platform}\n` +
            `Amount: IDR ${Number(data.amount.replace(/[,.\s]/g, '')).toLocaleString()}\n\n` +
            `Reply YES to confirm or NO to cancel.`;
        }
      },

      // ─────────────────────────────────────────────
      // Template 2: Report Maintenance Issue
      // ─────────────────────────────────────────────
      report_maintenance: {
        name: 'Report Maintenance',
        description: 'Report a new maintenance issue',
        triggers: ['report maintenance', 'new maintenance', 'maintenance issue', 'something broken', 'needs repair', 'needs fixing'],
        steps: [
          {
            id: 'villa',
            prompt: 'Which villa has the issue?',
            field: 'villa',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please enter the villa name'
          },
          {
            id: 'location',
            prompt: 'Where in the villa? (e.g., bedroom 1, pool, kitchen)',
            field: 'location',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please describe the location'
          },
          {
            id: 'issue',
            prompt: 'Describe the issue:',
            field: 'issue',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length >= 5,
            errorMessage: 'Please provide a description (at least 5 characters)'
          },
          {
            id: 'priority',
            prompt: 'Priority level?\n1. Low\n2. Medium\n3. High\n4. Urgent',
            field: 'priority',
            type: 'choice',
            options: ['Low', 'Medium', 'High', 'Urgent'],
            required: true,
            validate: (val) => {
              const lower = val.toLowerCase().trim();
              return ['low', 'medium', 'high', 'urgent', '1', '2', '3', '4'].includes(lower);
            },
            transform: (val) => {
              const map = { '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Urgent' };
              return map[val.trim()] || val.trim().charAt(0).toUpperCase() + val.trim().slice(1).toLowerCase();
            },
            errorMessage: 'Please choose: Low, Medium, High, or Urgent'
          },
          {
            id: 'photo',
            prompt: 'Please send a photo of the issue (or type SKIP if no photo available):',
            field: 'photo',
            type: 'image',
            required: false,
            validate: () => true, // Always passes — photo is optional
            errorMessage: ''
          },
          {
            id: 'confirm',
            prompt: null,
            field: '_confirm',
            type: 'confirm',
            required: true,
            validate: (val) => ['yes', 'y', 'ok', 'confirm', 'correct'].includes(val.toLowerCase().trim()),
            errorMessage: 'Reply YES to confirm or NO to cancel'
          }
        ],
        executor: 'maintenance.createItem',
        buildConfirmation: (data) => {
          return `Please confirm this maintenance report:\n\n` +
            `Villa: ${data.villa}\n` +
            `Location: ${data.location}\n` +
            `Issue: ${data.issue}\n` +
            `Priority: ${data.priority}\n` +
            `Photo: ${data.photo && data.photo !== 'skip' ? 'Attached' : 'None'}\n\n` +
            `Reply YES to confirm or NO to cancel.`;
        }
      },

      // ─────────────────────────────────────────────
      // Template 3: Update Maintenance Status
      // ─────────────────────────────────────────────
      update_maintenance: {
        name: 'Update Maintenance Status',
        description: 'Update status of an existing maintenance item',
        triggers: ['update maintenance', 'maintenance done', 'maintenance complete', 'fix done', 'repair done', 'mark done'],
        steps: [
          {
            id: 'villa',
            prompt: 'Which villa?',
            field: 'villa',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please enter the villa name'
          },
          {
            id: 'item',
            prompt: 'Which maintenance item? (describe it or give the row number)',
            field: 'item',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please describe the item or give the row number'
          },
          {
            id: 'status',
            prompt: 'New status?\n1. In Progress\n2. Done\n3. Cancelled',
            field: 'status',
            type: 'choice',
            options: ['In Progress', 'Done', 'Cancelled'],
            required: true,
            validate: (val) => {
              const lower = val.toLowerCase().trim();
              return ['in progress', 'done', 'cancelled', '1', '2', '3'].includes(lower);
            },
            transform: (val) => {
              const map = { '1': 'In Progress', '2': 'Done', '3': 'Cancelled' };
              return map[val.trim()] || val.trim();
            },
            errorMessage: 'Please choose: In Progress, Done, or Cancelled'
          },
          {
            id: 'photo_after',
            prompt: 'Send an "after" photo to confirm the fix (or type SKIP):',
            field: 'photoAfter',
            type: 'image',
            required: false,
            validate: () => true,
            errorMessage: ''
          },
          {
            id: 'confirm',
            prompt: null,
            field: '_confirm',
            type: 'confirm',
            required: true,
            validate: (val) => ['yes', 'y', 'ok', 'confirm', 'correct'].includes(val.toLowerCase().trim()),
            errorMessage: 'Reply YES to confirm or NO to cancel'
          }
        ],
        executor: 'maintenance.updateStatus',
        buildConfirmation: (data) => {
          return `Please confirm this status update:\n\n` +
            `Villa: ${data.villa}\n` +
            `Item: ${data.item}\n` +
            `New Status: ${data.status}\n` +
            `After Photo: ${data.photoAfter && data.photoAfter !== 'skip' ? 'Attached' : 'None'}\n\n` +
            `Reply YES to confirm or NO to cancel.`;
        }
      },

      // ─────────────────────────────────────────────
      // Template 4: Log Expense
      // ─────────────────────────────────────────────
      log_expense: {
        name: 'Log Expense',
        description: 'Record a new variable or recurring expense',
        triggers: ['log expense', 'new expense', 'add expense', 'record expense', 'cost', 'spent'],
        steps: [
          {
            id: 'type',
            prompt: 'Expense type?\n1. Variable (one-time)\n2. Recurring (monthly)',
            field: 'expenseType',
            type: 'choice',
            options: ['Variable', 'Recurring'],
            required: true,
            validate: (val) => ['variable', 'recurring', '1', '2'].includes(val.toLowerCase().trim()),
            transform: (val) => {
              const map = { '1': 'Variable', '2': 'Recurring' };
              return map[val.trim()] || val.trim();
            },
            errorMessage: 'Please choose: Variable or Recurring'
          },
          {
            id: 'description',
            prompt: 'What is this expense for?',
            field: 'description',
            type: 'text',
            required: true,
            validate: (val) => val.trim().length > 0,
            errorMessage: 'Please describe the expense'
          },
          {
            id: 'amount',
            prompt: 'Amount? (number only, in IDR)',
            field: 'amount',
            type: 'number',
            required: true,
            validate: (val) => !isNaN(Number(val.replace(/[,.\s]/g, ''))) && Number(val.replace(/[,.\s]/g, '')) > 0,
            errorMessage: 'Please enter a valid amount'
          },
          {
            id: 'date',
            prompt: 'Date of expense? (DD/MM/YYYY or type TODAY)',
            field: 'date',
            type: 'date',
            required: true,
            validate: (val) => val.toLowerCase() === 'today' || /\d{1,2}\/\d{1,2}\/\d{4}/.test(val),
            transform: (val) => val.toLowerCase() === 'today' ? new Date().toLocaleDateString('en-GB') : val,
            errorMessage: 'Please use DD/MM/YYYY format or type TODAY'
          },
          {
            id: 'confirm',
            prompt: null,
            field: '_confirm',
            type: 'confirm',
            required: true,
            validate: (val) => ['yes', 'y', 'ok', 'confirm', 'correct'].includes(val.toLowerCase().trim()),
            errorMessage: 'Reply YES to confirm or NO to cancel'
          }
        ],
        executor: 'finance.addExpense',
        buildConfirmation: (data) => {
          return `Please confirm this expense:\n\n` +
            `Type: ${data.expenseType}\n` +
            `Description: ${data.description}\n` +
            `Amount: IDR ${Number(data.amount.replace(/[,.\s]/g, '')).toLocaleString()}\n` +
            `Date: ${data.date}\n\n` +
            `Reply YES to confirm or NO to cancel.`;
        }
      },

      // ─────────────────────────────────────────────
      // Template 5: Check Status (read-only)
      // ─────────────────────────────────────────────
      check_status: {
        name: 'Check Status',
        description: 'Quick status check across all systems',
        triggers: ['check status', 'system status', 'bot status', 'whatsapp status', 'how is everything'],
        steps: [], // No input needed — immediate execution
        executor: 'system.getFullStatus',
        buildConfirmation: null
      }
    };

    console.log('[Templates] Initialized with', Object.keys(this.templates).length, 'templates');
  }

  /**
   * Check if a message matches any template trigger
   * Returns the template ID or null
   */
  detectTemplate(message) {
    if (!message) return null;
    const lower = message.toLowerCase().trim();

    for (const [id, template] of Object.entries(this.templates)) {
      for (const trigger of template.triggers) {
        if (lower.includes(trigger)) {
          return id;
        }
      }
    }
    return null;
  }

  /**
   * Start a template session for a user
   */
  startSession(userId, templateId) {
    const template = this.templates[templateId];
    if (!template) return { success: false, error: 'Template not found' };

    // If no steps, execute immediately
    if (template.steps.length === 0) {
      return {
        success: true,
        immediate: true,
        executor: template.executor,
        data: {}
      };
    }

    const session = {
      templateId,
      templateName: template.name,
      currentStep: 0,
      data: {},
      startedAt: new Date().toISOString()
    };

    this.activeSessions.set(userId, session);

    const firstStep = template.steps[0];
    return {
      success: true,
      immediate: false,
      message: `Starting: *${template.name}*\n\n${firstStep.prompt}`,
      stepId: firstStep.id
    };
  }

  /**
   * Process a user's response within an active template session
   */
  processResponse(userId, message) {
    const session = this.activeSessions.get(userId);
    if (!session) return { active: false };

    const template = this.templates[session.templateId];
    const step = template.steps[session.currentStep];

    // Check for cancel
    if (['cancel', 'stop', 'quit', 'exit', 'no'].includes(message.toLowerCase().trim())) {
      this.activeSessions.delete(userId);
      return {
        active: true,
        cancelled: true,
        message: `Cancelled: ${template.name}`
      };
    }

    // Handle SKIP for optional fields
    if (!step.required && message.toLowerCase().trim() === 'skip') {
      session.data[step.field] = null;
    } else {
      // Validate the input
      if (!step.validate(message)) {
        return {
          active: true,
          valid: false,
          message: `${step.errorMessage}\n\n${step.prompt}`
        };
      }

      // Transform if needed, then store
      const value = step.transform ? step.transform(message) : message.trim();
      session.data[step.field] = value;
    }

    // Move to next step
    session.currentStep++;

    // Check if we're at the confirmation step
    if (session.currentStep < template.steps.length) {
      const nextStep = template.steps[session.currentStep];

      // If this is the confirmation step, build the confirmation message
      if (nextStep.type === 'confirm' && template.buildConfirmation) {
        const confirmMsg = template.buildConfirmation(session.data);
        return {
          active: true,
          valid: true,
          message: confirmMsg,
          stepId: nextStep.id
        };
      }

      return {
        active: true,
        valid: true,
        message: nextStep.prompt,
        stepId: nextStep.id
      };
    }

    // All steps complete — ready to execute
    const finalData = { ...session.data };
    delete finalData._confirm;

    this.activeSessions.delete(userId);

    return {
      active: true,
      complete: true,
      executor: template.executor,
      data: finalData,
      message: `Got it! Processing your ${template.name} request...`
    };
  }

  /**
   * Check if a user has an active template session
   */
  hasActiveSession(userId) {
    return this.activeSessions.has(userId);
  }

  /**
   * Get current session status for a user
   */
  getSessionStatus(userId) {
    const session = this.activeSessions.get(userId);
    if (!session) return null;

    const template = this.templates[session.templateId];
    return {
      template: template.name,
      progress: `Step ${session.currentStep + 1} of ${template.steps.length}`,
      currentField: template.steps[session.currentStep]?.field || 'done',
      collectedData: Object.keys(session.data).length
    };
  }

  /**
   * Force-end a session (timeout, etc.)
   */
  endSession(userId) {
    this.activeSessions.delete(userId);
  }

  /**
   * List all available templates (for help messages)
   */
  getAvailableTemplates() {
    return Object.entries(this.templates).map(([id, t]) => ({
      id,
      name: t.name,
      description: t.description,
      triggers: t.triggers.slice(0, 2) // show first 2 triggers as examples
    }));
  }

  /**
   * Clean up stale sessions (older than 30 minutes)
   */
  cleanStaleSessions() {
    const cutoff = Date.now() - (30 * 60 * 1000);
    let cleaned = 0;

    for (const [userId, session] of this.activeSessions) {
      if (new Date(session.startedAt).getTime() < cutoff) {
        this.activeSessions.delete(userId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[Templates] Cleaned ${cleaned} stale sessions`);
    }
  }
}

// Export singleton instance
const templates = new TemplateEngine();
module.exports = templates;
