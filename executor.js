
// ── Resilience: Retry wrapper with exponential backoff ───────────────────────
// Wraps any async function with retry logic + circuit breaker awareness
async function _withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const baseDelay   = opts.baseDelay   || 1000;
  const label       = opts.label       || 'operation';
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) console.log(`[Executor] ${label} succeeded on attempt ${attempt}`);
      return result;
    } catch (err) {
      lastError = err;
      const isRetryable = !['invalid_request', 'auth', 'permission', 'not_found'].some(k => 
        err.message && err.message.toLowerCase().includes(k)
      );
      if (!isRetryable || attempt === maxAttempts) break;
      const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.warn(`[Executor] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// executor.js — Tool Execution Layer for TVMbot PEMS Architecture
// Dispatches all tool calls from Planner/Claude to actual Google API integrations

const path = require('path');
const fs = require('fs');
const audit = require('./audit');
const memory = require('./memory');

// ─── PDF / DOCX Parsers ────────────────────────────────────────────────────────
let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch(e) { console.warn('[Executor] pdf-parse not available'); }
try { mammoth  = require('mammoth');   } catch(e) { console.warn('[Executor] mammoth not available'); }

// Helper: download a Drive file as a Buffer and detect its type
async function driveDownloadBuffer(fileId) {
  if (!drive) throw new Error('Drive integration not loaded');

  // Get file metadata first to know mimeType
  const meta = await drive.getFileMeta(fileId);
  const mimeType = meta.mimeType || '';

  let buffer;

  if (mimeType === 'application/vnd.google-apps.document') {
    // Google Doc → export as plain text
    buffer = await drive.exportAsText(fileId);
    return { buffer, mimeType: 'text/plain', name: meta.name };
  } else {
    buffer = await drive.downloadFile(fileId);
    return { buffer, mimeType, name: meta.name };
  }
}

// Helper: extract text from Buffer based on mimeType
async function extractText(buffer, mimeType, fileName = '') {
  const name = (fileName || '').toLowerCase();

  if (mimeType === 'text/plain') {
    return buffer.toString('utf8');
  }

  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) {
    if (!pdfParse) throw new Error('pdf-parse not installed');
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    if (!mammoth) throw new Error('mammoth not installed');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === 'application/msword' || name.endsWith('.doc')) {
    throw new Error('.doc (old Word format) is not supported — please convert to .docx or PDF first');
  }

  throw new Error(`Unsupported file type: ${mimeType || name}. Supported: PDF, DOCX, Google Docs`);
}

// ─── Integration Imports ───────────────────────────────────────────────────────
let gmail, calendar, drive, docs, sheets, cleaning, notion, finance, search, sandbox;

try { gmail    = require('./integrations/gmail');    } catch(e) { console.warn('[Executor] Gmail not available:', e.message); }
try { calendar = require('./integrations/calendar'); } catch(e) { console.warn('[Executor] Calendar not available:', e.message); }
try { drive    = require('./integrations/drive');    } catch(e) { console.warn('[Executor] Drive not available:', e.message); }
try { docs     = require('./integrations/docs');     } catch(e) { console.warn('[Executor] Docs not available:', e.message); }
try { sheets   = require('./integrations/sheets');   } catch(e) { console.warn('[Executor] Sheets not available:', e.message); }
try { cleaning = require('./integrations/cleaning'); } catch(e) { console.warn('[Executor] Cleaning not available:', e.message); }
try { notion   = require('./integrations/notion');   } catch(e) { console.warn('[Executor] Notion not available:', e.message); }
let notionTodo;
try { notionTodo = require('./integrations/notion-todo'); } catch(e) { console.warn('[Executor] NotionTodo not available:', e.message); }
try { finance  = require('./integrations/finance');  } catch(e) { console.warn('[Executor] Finance not available:', e.message); }
try { search   = require('./integrations/search');   } catch(e) { console.warn('[Executor] Search not available:', e.message); }
try { sandbox  = require('./integrations/sandbox');  } catch(e) { console.warn('[Executor] Sandbox not available:', e.message); }

// ─── Sensitive Tools (require supervisor approval) ─────────────────────────────
const SENSITIVE_TOOLS = [
  'drive_delete_file',
  'drive_merge_pdfs',
  'gmail_send_message',
  'calendar_create_event',
  'calendar_delete_event',
  'calendar_update_event',
  'docs_create_contract',
  'docs_create_document',
  'docs_update_document',
  'sheets_write_data',
  'sheets_append_row',
  'villa_update_utility',
  'villa_get_utilities'
];

// ─── Main Tool Executor ────────────────────────────────────────────────────────
// Validator pre-write gate
let validator;
try { validator = require('./agents/validator'); } catch(e) {}
let rollback;
try { rollback = require('./agents/rollback'); } catch(e) {}


// ── Doc Token Store (for /download/:token endpoint) ──────────────────────────
const _docTokenStore = new Map();
global._docTokenStore = _docTokenStore;


// ── EventBus bridge (lazy-loaded to avoid circular dependency) ────────────────
let _execEventBus = null;
function _getEventBus() {
  if (!_execEventBus) {
    try { _execEventBus = require('./event-bus'); } catch(e) {}
  }
  return _execEventBus;
}

// ── Group Action → Tool Mapping (hard enforcement) ──────────────────────────
const ACTION_TOOL_MAP = {
  sheet_write: ['sheets_write_data','sheets_append_row','finance_log_payment','finance_log_expense',
                'finance_log_variable','finance_log_recurring','finance_log_income','finance_mark_invoice_paid',
                'finance_generate_invoice','finance_update_bank_balance','finance_sync_expenses'],
  inquiry_search: ['sheets_read_data','drive_search_files','drive_find_passport','drive_scan_folder'],
  reminder: ['calendar_create_event','calendar_update_event','calendar_delete_event'],
  automation: ['gmail_send_message','docs_create_document','docs_update_document','docs_create_contract',
               'drive_create_folder','drive_delete_file','notion_create_page']
};

function isToolBlockedByGroup(toolName) {
  const grpCfg = global.__tvmbot_current_group_cfg;
  if (!grpCfg || !grpCfg.allowed_actions) return null; // no restrictions
  for (const [action, tools] of Object.entries(ACTION_TOOL_MAP)) {
    if (tools.includes(toolName) && !grpCfg.allowed_actions.includes(action)) {
      return action; // blocked — return the action category name
    }
  }
  return null; // allowed
}

async function executeTool(toolName, toolInput, userEmail = 'unknown') {
  const startTime = Date.now();
  let result;
  let status = 'SUCCESS';

  try {
    // ── Hard group action enforcement ──────────────────────────────────────
    const blockedAction = isToolBlockedByGroup(toolName);
    if (blockedAction) {
      console.log(`[Executor] BLOCKED: ${toolName} — action "${blockedAction}" not allowed in this group`);
      return { success: false, error: `Action "${blockedAction}" is not enabled for this group. Ask a group admin to enable it with: @bot allow ${blockedAction}` };
    }

    console.log(`[Executor] Running: ${toolName}`, JSON.stringify(toolInput).slice(0, 120));

    switch (toolName) {

      // ── Gmail ──────────────────────────────────────────────────────────────
      case 'gmail_list_messages': {
        if (!gmail) throw new Error('Gmail integration not loaded');
        const maxResults = toolInput.maxResults || 10;
        const query = toolInput.query || '';
        const emails = await gmail.getEmails(maxResults, query);
        result = {
          count: emails.length,
          emails: emails.map(e => ({
            id: e.id,
            from: e.from,
            subject: e.subject,
            date: e.date,
            snippet: e.snippet,
            isUnread: e.isUnread
          }))
        };
        break;
      }

      case 'gmail_read_message': {
        if (!gmail) throw new Error('Gmail integration not loaded');
        const email = await gmail.readEmail(toolInput.messageId);
        result = email;
        break;
      }

      case 'gmail_send_message': {
        // Validator gate: check email before sending
        if (validator && validator.validateEmail) {
          const emailCheck = validator.validateEmail(toolInput.to, toolInput.subject, toolInput.body);
          if (!emailCheck.approved) {
            console.warn('[Validator] Email blocked:', emailCheck.errors.join(', '));
            result = { error: 'Email validation failed: ' + emailCheck.errors.join(', '), blocked: true };
            break;
          }
        }
        if (!gmail) throw new Error('Gmail integration not loaded');
        const sent = await gmail.sendEmail(toolInput.to, toolInput.subject, toolInput.body);
        // POST-SEND VERIFICATION: confirm messageId was returned
        const emailVerified = !!(sent && sent.id);
        result = {
          success: true,
          message: `Email sent to ${toolInput.to}`,
          messageId: sent?.id,
          verified: emailVerified,
          verificationDetail: emailVerified
            ? `Verified: message ${sent.id} delivered to Gmail outbox`
            : 'Email sent but no messageId returned — delivery unconfirmed'
        };

        // Log to memory
        memory.setFact('email_activity', `last_sent_${Date.now()}`,
          `Sent to ${toolInput.to}: ${toolInput.subject}`, userEmail);
        break;
      }

      case 'gmail_get_flagged': {
        if (!gmail) throw new Error('Gmail integration not loaded');
        const flagged = await gmail.getFlaggedEmails();
        result = { count: flagged.length, emails: flagged };
        break;
      }

      // ── Google Calendar ────────────────────────────────────────────────────
      case 'calendar_get_events': {
        if (!calendar) throw new Error('Calendar integration not loaded');
        const events = await calendar.getEvents(
          toolInput.maxResults || 10,
          toolInput.timeMin,
          toolInput.timeMax
        );
        result = { count: events.length, events };
        break;
      }

      case 'calendar_check_availability': {
        if (!calendar) throw new Error('Calendar integration not loaded');
        const available = await calendar.checkAvailability(toolInput.startTime, toolInput.endTime);
        result = { available, startTime: toolInput.startTime, endTime: toolInput.endTime };
        break;
      }

      case 'calendar_create_event': {
        // Validator gate: check calendar event
        if (validator && validator.validateCalendarEvent) {
          const calCheck = validator.validateCalendarEvent(toolInput);
          if (!calCheck.approved) {
            console.warn('[Validator] Calendar event blocked:', calCheck.errors.join(', '));
            result = { error: 'Calendar validation failed: ' + calCheck.errors.join(', '), blocked: true };
            break;
          }
        }
        if (!calendar) throw new Error('Calendar integration not loaded');
        const event = await calendar.createEvent(
          toolInput.summary,
          toolInput.startTime,
          toolInput.endTime,
          toolInput.description || '',
          toolInput.attendees || []
        );
        // POST-CREATE VERIFICATION: confirm event was actually created
        let calVerified = false;
        let calVerifyDetail = '';
        if (event && event.id) {
          try {
            const verifyResponse = await calendar.calendar.events.get({
              calendarId: calendar.config.calendar_id,
              eventId: event.id
            });
            if (verifyResponse.data && verifyResponse.data.id === event.id) {
              calVerified = true;
              calVerifyDetail = `Verified: event ${event.id} confirmed on calendar (${verifyResponse.data.summary})`;
              console.log(`[Calendar] Post-create verify OK: ${event.id}`);
            }
          } catch (calVerifyErr) {
            calVerifyDetail = `Event created but verification read failed: ${calVerifyErr.message}`;
            console.warn(`[Calendar] Post-create verify error: ${calVerifyErr.message}`);
          }
        }
        result = {
          success: true,
          eventId: event.id,
          link: event.htmlLink,
          message: `Event "${toolInput.summary}" created`,
          verified: calVerified,
          verificationDetail: calVerifyDetail
        };

        // Store in memory
        memory.setFact('calendar', `event_${Date.now()}`,
          `Created: ${toolInput.summary} at ${toolInput.startTime}`, userEmail);

        // ── EventBus bridge: emit booking event ──────────────────────────────
        if (result.success && /check.?in|booking|reservation|villa|guest/i.test(toolInput.summary || '')) {
          const eb = _getEventBus();
          if (eb) {
            let guestName = '', villaName = '';
            const atMatch   = (toolInput.summary || '').match(/^(.+?)\s+@\s+(.+)$/i);
            const dashMatch = (toolInput.summary || '').match(/^(.+?)\s+-\s+(.+)$/i);
            if (atMatch)        { guestName = atMatch[1].trim();   villaName = atMatch[2].trim(); }
            else if (dashMatch) { guestName = dashMatch[2].trim(); villaName = dashMatch[1].trim(); }
            else                { guestName = toolInput.summary || ''; }
            eb.emitBooking({
              guest_name:    guestName,
              villa_name:    villaName,
              check_in:      toolInput.startTime ? new Date(toolInput.startTime).toISOString().slice(0,10) : '',
              check_out:     toolInput.endTime   ? new Date(toolInput.endTime).toISOString().slice(0,10)   : '',
              notes:         toolInput.description || '',
              fromExecutor:  true
            }, 'executor');
            console.log('[Executor→EventBus] booking.received emitted');
          }
        }
        break;
      }


      case 'calendar_delete_event': {
        if (!calendar) throw new Error('Calendar integration not loaded');
        let eventId = toolInput.eventId;
        // If no ID provided, search by title
        if (!eventId && toolInput.title) {
          const matches = await calendar.findEventByTitle(toolInput.title);
          if (matches.length === 0) {
            result = { success: false, error: `No event found matching "${toolInput.title}"` };
            break;
          }
          if (matches.length > 1) {
            result = {
              success: false,
              error: `Multiple events found matching "${toolInput.title}". Please specify which one.`,
              matches: matches.map(m => ({ id: m.id, title: m.title, start: m.start, end: m.end }))
            };
            break;
          }
          eventId = matches[0].id;
        }
        if (!eventId) {
          result = { success: false, error: 'Please provide an eventId or title to search for.' };
          break;
        }
        const delResult = await calendar.deleteEvent(eventId);
        result = delResult;
        if (delResult.success) {
          memory.setFact('calendar', `deleted_${Date.now()}`,
            `Deleted event: ${toolInput.title || eventId}`, userEmail);
        }
        break;
      }

      case 'calendar_update_event': {
        if (!calendar) throw new Error('Calendar integration not loaded');
        const updates = {};
        if (toolInput.title) updates.title = toolInput.title;
        if (toolInput.startTime) updates.startTime = toolInput.startTime;
        if (toolInput.endTime) updates.endTime = toolInput.endTime;
        if (toolInput.description !== undefined) updates.description = toolInput.description;
        if (toolInput.location !== undefined) updates.location = toolInput.location;
        if (toolInput.attendees) updates.attendees = toolInput.attendees;
        const updResult = await calendar.updateEvent(toolInput.eventId, updates);
        // POST-UPDATE VERIFICATION: confirm event reflects the changes
        let updVerified = false;
        let updVerifyDetail = '';
        if (updResult && updResult.id) {
          try {
            const verifyUpd = await calendar.calendar.events.get({
              calendarId: calendar.config.calendar_id,
              eventId: updResult.id
            });
            if (verifyUpd.data && verifyUpd.data.id === updResult.id) {
              updVerified = true;
              updVerifyDetail = `Verified: event ${updResult.id} updated (${Object.keys(updates).join(', ')})`;
              console.log(`[Calendar] Post-update verify OK: ${updResult.id}`);
            }
          } catch (updVerifyErr) {
            updVerifyDetail = `Event updated but verification read failed: ${updVerifyErr.message}`;
            console.warn(`[Calendar] Post-update verify error: ${updVerifyErr.message}`);
          }
        }
        result = { success: true, ...updResult, message: `Event updated: ${Object.keys(updates).join(', ')}`, verified: updVerified, verificationDetail: updVerifyDetail };
        memory.setFact('calendar', `updated_${Date.now()}`,
          `Updated event ${toolInput.eventId}: ${Object.keys(updates).join(', ')}`, userEmail);
        break;
      }

      // ── Google Drive ───────────────────────────────────────────────────────
      case 'drive_search_files': {
        if (!drive) throw new Error('Drive integration not loaded');
        const files = await drive.searchFiles(toolInput.query || '', toolInput.maxResults || 10);
        result = { count: files.length, files };
        break;
      }

      case 'drive_find_passport': {
        if (!drive) throw new Error('Drive integration not loaded');
        const passports = await drive.findPassports(toolInput.guestName);
        result = { count: passports.length, files: passports };
        break;
      }

      case 'drive_get_recent': {
        if (!drive) throw new Error('Drive integration not loaded');
        const recent = await drive.getRecentFiles(toolInput.maxResults || 10);
        result = { count: recent.length, files: recent };
        break;
      }

      case 'drive_create_folder': {
        if (!drive) throw new Error('Drive integration not loaded');
        const folder = await drive.createFolder(toolInput.name, toolInput.parentId);
        result = { success: true, folderId: folder.id, name: toolInput.name, link: folder.webViewLink };
        break;
      }

      // ── Finance ────────────────────────────────────────────────────────────
      case 'finance_log_payment': {
        // Validator gate: check financial amounts
        if (validator && validator.validateFinancial) {
          const finCheck = validator.validateFinancial('payment', toolInput.amount, toolInput.currency);
          if (!finCheck.approved) {
            console.warn('[Validator] Payment blocked:', finCheck.errors.join(', '));
            result = { error: 'Financial validation failed: ' + finCheck.errors.join(', '), blocked: true };
            break;
          }
        }
        const txId = memory.logTransaction({
          type: 'income',
          category: toolInput.category || toolInput.villa_name || 'booking',
          description: toolInput.description,
          amount: toolInput.amount,
          currency: toolInput.currency || 'IDR',
          villa_name: toolInput.villa_name || null,
          guest_name: toolInput.guest_name || null,
          booking_id: toolInput.booking_id || null,
          payment_method: toolInput.payment_method || toolInput.account || null,
          reference: toolInput.reference || null,
          status: toolInput.status || 'paid',
          date: toolInput.date || new Date().toISOString().slice(0, 10)
        });
        // Auto-log to Google Sheets via finance.logIncome()
        let sheetsResult = { skipped: true };
        if (finance) {
          try {
            sheetsResult = await finance.logIncome({
              date: toolInput.date || new Date().toISOString().slice(0, 10),
              category: toolInput.category || 'Rental',
              guestName: toolInput.guest_name || '',
              property: toolInput.villa_name || '',
              checkIn: toolInput.check_in || '',
              checkOut: toolInput.check_out || '',
              nights: toolInput.nights || '',
              rentalIncome: toolInput.amount,
              otherFees: toolInput.other_fees || 0,
              notes: toolInput.description || ''
            });
            console.log('[Executor] finance.logIncome() OK:', sheetsResult.message);
          } catch (shErr) {
            console.error('[Executor] finance.logIncome() FAILED:', shErr.message);
            sheetsResult = { error: shErr.message };
          }
        }
        result = {
          success: true, transactionId: txId,
          message: `Payment of ${toolInput.currency || 'IDR'} ${toolInput.amount} recorded`,
          sheets: sheetsResult
        };

        // ── EventBus bridge: emit payment event ──────────────────────────────
        if (result.success) {
          const eb = _getEventBus();
          if (eb) {
            eb.emitPayment({
              amount:         toolInput.amount,
              currency:       toolInput.currency || 'IDR',
              guest_name:     toolInput.guest_name || '',
              villa_name:     toolInput.villa_name || '',
              description:    toolInput.description || '',
              category:       toolInput.category || 'booking',
              payment_method: toolInput.payment_method || toolInput.account || '',
              date:           toolInput.date || new Date().toISOString().slice(0,10),
              reference:      toolInput.reference || '',
              fromExecutor:   true
            }, 'executor');
            console.log('[Executor→EventBus] payment.received emitted (log_payment)');
          }
        }
        break;
      }

      case 'finance_log_expense': {
        const txId = memory.logTransaction({
          type: 'expense',
          category: toolInput.category || 'other',
          description: toolInput.description,
          amount: toolInput.amount,
          currency: toolInput.currency || 'IDR',
          villa_name: toolInput.villa_name || null,
          payment_method: toolInput.payment_method || toolInput.account || null,
          reference: toolInput.reference || null,
          status: 'paid',
          date: toolInput.date || new Date().toISOString().slice(0, 10)
        });
        let sheetsResult = { skipped: true };
        if (finance) {
          try {
            // Map expense category to sheet category names
            const expenseCategoryMap = {
              cleaning: 'Villa Expense', maintenance: 'Villa Expense',
              staff: 'Salary', utilities: toolInput.villa_name ? `${toolInput.villa_name} Electricity` : 'Villa Expense',
              supplies: 'Villa Expense', other: 'Villa Expense'
            };
            const sheetCategory = expenseCategoryMap[toolInput.category] || toolInput.category || 'Villa Expense';
            sheetsResult = await finance.logVariableExpense({
              date: toolInput.date || new Date().toISOString().slice(0, 10),
              property: toolInput.villa_name || '',
              category: sheetCategory,
              description: toolInput.description || `${toolInput.category || 'expense'}`,
              amount: toolInput.amount,
              notes: toolInput.reference || toolInput.payment_method || ''
            });
            console.log('[Executor] finance.logVariableExpense() OK:', sheetsResult.message);
          } catch (shErr) {
            console.error('[Executor] finance.logVariableExpense() FAILED:', shErr.message);
            sheetsResult = { error: shErr.message };
          }
        }
        result = {
          success: true, transactionId: txId,
          message: `Expense of ${toolInput.currency || 'IDR'} ${toolInput.amount} recorded (${toolInput.category})`,
          sheets: sheetsResult
        };
        break;
      }

      case 'finance_get_report': {
        const today = new Date();
        let startDate, endDate;
        const pad = n => String(n).padStart(2, '0');
        const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

        switch (toolInput.period) {
          case 'this_month':
            startDate = `${today.getFullYear()}-${pad(today.getMonth()+1)}-01`;
            endDate   = todayStr; break;
          case 'last_month': {
            const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const lme = new Date(today.getFullYear(), today.getMonth(), 0);
            startDate = `${lm.getFullYear()}-${pad(lm.getMonth()+1)}-01`;
            endDate   = `${lme.getFullYear()}-${pad(lme.getMonth()+1)}-${pad(lme.getDate())}`; break;
          }
          case 'this_year':
            startDate = `${today.getFullYear()}-01-01`; endDate = todayStr; break;
          case 'last_30_days': {
            const d30 = new Date(today); d30.setDate(d30.getDate() - 30);
            startDate = `${d30.getFullYear()}-${pad(d30.getMonth()+1)}-${pad(d30.getDate())}`;
            endDate   = todayStr; break;
          }
          case 'last_90_days': {
            const d90 = new Date(today); d90.setDate(d90.getDate() - 90);
            startDate = `${d90.getFullYear()}-${pad(d90.getMonth()+1)}-${pad(d90.getDate())}`;
            endDate   = todayStr; break;
          }
          default:
            startDate = toolInput.start_date || todayStr;
            endDate   = toolInput.end_date   || todayStr;
        }

        const report = memory.getPLReport(startDate, endDate);
        result = report;
        break;
      }

      // ── WhatsApp Direct Send (operator-initiated, requires confirmation) ────
      case 'whatsapp_send_direct': {
        const rawPhone = String(toolInput.phone_number || '').trim();
        const messageText = String(toolInput.message || '').trim();
        if (!rawPhone) { result = { success: false, error: 'phone_number is required' }; break; }
        if (!messageText) { result = { success: false, error: 'message is required' }; break; }

        // Normalize phone → E.164-ish digits + leading +
        let digits = rawPhone.replace(/\D/g, '');
        // Indonesian convention: leading 0 → 62
        if (digits.startsWith('0')) digits = '62' + digits.slice(1);
        // Strip any leading 00 international prefix
        if (digits.startsWith('00')) digits = digits.slice(2);
        if (digits.length < 8 || digits.length > 15) {
          result = { success: false, error: `Phone number "${rawPhone}" looks invalid after normalization (${digits}).` };
          break;
        }
        const normalized = '+' + digits;

        // Stash pending send keyed by current session — server intercepts on next message.
        const sid = global.__tvmbot_current_session || null;
        const pending = global.__tvmbot_pendingDirectSends;
        if (sid && pending) {
          pending.set(sid, { phone: normalized, message: messageText, createdAt: Date.now() });
        }

        const previewText =
          '📤 *WhatsApp send preview*\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '*To:* ' + normalized + '\n' +
          '*Message:*\n' + messageText + '\n' +
          '━━━━━━━━━━━━━━━━━━━\n\n' +
          '⚠️ *Nothing is sent yet.* Confirm below:\n\n' +
          '✅ Reply *`yes`* to send now\n' +
          '❌ Reply *`no`* to cancel\n\n' +
          '_(Must be exactly the word `yes` or `no` — anything else will be treated as a new question.)_';

        result = {
          pending_direct_send: true,
          phone: normalized,
          message: messageText,
          preview: previewText,
          // The agent loop reads this field and short-circuits — see runPEMSAgent.
          stop_and_reply: previewText
        };
        break;
      }

      // ── WhatsApp Document Sending ───────────────────────────────────────────
      case 'whatsapp_send_document': {
        const whatsapp = global.__tvmbot_whatsapp;
        const replyJid = global.__tvmbot_current_jid;
        const displayName = toolInput.fileName || 'document';

        if (toolInput.sendFile) {
          // Send actual file attachment (user explicitly asked for it)
          if (!drive) throw new Error('Drive integration not loaded');
          if (!whatsapp) throw new Error('WhatsApp not available');
          if (!replyJid) throw new Error('No WhatsApp chat context');

          const { buffer, mimeType, name } = await driveDownloadBuffer(toolInput.fileId);
          await whatsapp.sendDocument(replyJid, buffer, mimeType, displayName || name, toolInput.caption || '');
          result = {
            success: true, mode: 'file_attachment',
            fileName: displayName || name, mimeType,
            message: `Sent ${displayName || name} as attachment`
          };
        } else {
          // Default: send Google Drive link (low cost, preferred)
          let link = toolInput.webViewLink;
          if (!link && toolInput.fileId) {
            // Build link from file ID
            link = `https://drive.google.com/file/d/${toolInput.fileId}/view`;
          }
          result = {
            success: true, mode: 'drive_link',
            fileName: displayName,
            link: link,
            message: `Found: ${displayName}. Link: ${link}`
          };
        }
        break;
      }

      case 'finance_get_outstanding': {
        const outstanding = memory.getOutstandingPayments();
        const unpaidInvoices = memory.getInvoices({ status: 'sent' });
        result = {
          outstanding_payments: outstanding,
          unpaid_invoices: unpaidInvoices,
          total_outstanding: outstanding.reduce((s, t) => s + (t.amount || 0), 0)
        };
        break;
      }

      case 'finance_generate_invoice': {
        if (!finance) throw new Error('Finance integration not loaded');
        const lineItems = toolInput.line_items || [];
        const subtotal  = finance.calcLineItems(lineItems);
        const taxRate   = parseFloat(toolInput.tax_rate || 0);
        const taxAmount = subtotal * (taxRate / 100);
        const total     = subtotal + taxAmount;

        // Save invoice record
        const { id: invoiceId, invoice_number } = memory.saveInvoice({
          guest_name: toolInput.guest_name,
          guest_email: toolInput.guest_email || null,
          villa_name: toolInput.villa_name || null,
          booking_id: toolInput.booking_id || null,
          line_items: lineItems,
          subtotal, tax_rate: taxRate, tax_amount: taxAmount, total,
          currency: toolInput.currency || 'USD',
          status: 'draft',
          due_date: toolInput.due_date || null,
          notes: toolInput.notes || null
        });

        const profile = memory.getOwnerProfile();
        const invoiceData = {
          invoice_number,
          guest_name: toolInput.guest_name,
          guest_email: toolInput.guest_email,
          villa_name: toolInput.villa_name,
          line_items: lineItems,
          subtotal, tax_rate: taxRate, tax_amount: taxAmount, total,
          currency: toolInput.currency || 'USD',
          due_date: toolInput.due_date,
          notes: toolInput.notes,
          created_at: new Date().toISOString()
        };

        const { filePath, fileName } = await finance.generateInvoicePDF(invoiceData, profile);
        memory.updateInvoiceStatus(invoice_number, 'draft', filePath);

        result = {
          success: true, invoice_number, invoiceId,
          subtotal, tax_amount: taxAmount, total,
          currency: toolInput.currency || 'USD',
          pdf_path: filePath,
          message: `Invoice ${invoice_number} generated for ${toolInput.guest_name} — ${toolInput.currency || 'USD'} ${total.toFixed(2)}`
        };

        // Send via email if requested
        if (toolInput.send_email && toolInput.guest_email && gmail) {
          const fs = require('fs');
          const emailBody = `Dear ${toolInput.guest_name},\n\nPlease find your invoice ${invoice_number} attached.\n\nTotal: ${toolInput.currency || 'USD'} ${total.toFixed(2)}\nDue: ${toolInput.due_date || 'Upon receipt'}\n\n${toolInput.notes || ''}\n\nThank you,\n${profile.company || 'The Villa Managers'}`;
          await gmail.sendEmail(toolInput.guest_email, `Invoice ${invoice_number} — ${toolInput.villa_name || profile.company || 'Villa Rental'}`, emailBody);
          memory.updateInvoiceStatus(invoice_number, 'sent');
          result.email_sent = true;
          result.message += ' — emailed to ' + toolInput.guest_email;
        }
        break;
      }

      case 'finance_update_bank_balance': {
        memory.upsertBankAccount({
          name: toolInput.account_name,
          bank: toolInput.bank || null,
          account_number: toolInput.account_number || null,
          currency: toolInput.currency || 'IDR',
          balance: toolInput.balance,
          notes: toolInput.notes || null
        });
        // Sync to Rekening sheet if configured
        const profileRek = memory.getOwnerProfile();
        const sheetsIdRek = profileRek.sheets_booking_id;
        let rekeningResult = { skipped: true };
        if (sheetsIdRek && finance && finance.updateRekeningSheet) {
          rekeningResult = await finance.updateRekeningSheet(sheetsIdRek, [{
            name: toolInput.account_name,
            balance: toolInput.balance
          }]);
        }
        result = {
          success: true,
          message: `Bank account "${toolInput.account_name}" updated — balance: ${toolInput.currency || 'IDR'} ${parseFloat(toolInput.balance).toLocaleString()}`,
          rekening_sheet: rekeningResult
        };
        break;
      }

      case 'finance_get_bank_balances': {
        const accounts = memory.getAllBankAccounts();
        const totals   = memory.getTotalBankBalance();
        result = {
          accounts,
          totals_by_currency: totals,
          count: accounts.length,
          last_updated: accounts.map(a => a.updated_at).sort().pop() || null
        };
        break;
      }

      case 'finance_get_transactions': {
        const filter = {};
        if (toolInput.type && toolInput.type !== 'all') filter.type = toolInput.type;
        if (toolInput.villa_name) filter.villa = toolInput.villa_name;
        if (toolInput.month)      filter.month = toolInput.month;
        const txs = memory.getTransactions(filter);
        result = {
          count: txs.length,
          transactions: txs.slice(0, toolInput.limit || 20),
          total_income:  txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
          total_expenses: txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
        };
        break;
      }

      case 'finance_mark_invoice_paid': {
        memory.updateInvoiceStatus(toolInput.invoice_number, 'paid');
        // Also log the income transaction
        const inv = memory.getInvoices({}).find(i => i.invoice_number === toolInput.invoice_number);
        if (inv) {
          memory.logTransaction({
            type: 'income',
            category: inv.villa_name || 'booking',
            description: `Invoice ${toolInput.invoice_number} paid — ${inv.guest_name}`,
            amount: inv.total,
            currency: inv.currency || 'IDR',
            villa_name: inv.villa_name || null,
            guest_name: inv.guest_name,
            payment_method: toolInput.payment_method || toolInput.account || null,
            reference: toolInput.reference || null,
            status: 'paid',
            date: new Date().toISOString().slice(0, 10)
          });
          // Log to Google Sheets via finance.logIncome()
          if (finance) {
            try {
              await finance.logIncome({
                date: new Date().toISOString().slice(0, 10),
                category: 'Rental',
                guestName: inv.guest_name || '',
                property: inv.villa_name || '',
                rentalIncome: inv.total,
                notes: `Invoice ${toolInput.invoice_number} — ${inv.guest_name}`
              });
              console.log('[Executor] invoice→logIncome() OK');
            } catch (shErr) {
              console.error('[Executor] invoice→logIncome() FAILED:', shErr.message);
            }
          }
        }
        result = {
          success: true,
          message: `Invoice ${toolInput.invoice_number} marked as PAID`,
          invoice_number: toolInput.invoice_number
        };
        break;
      }

      case 'drive_read_contract': {
        if (!drive) throw new Error('Drive integration not loaded');
        const { buffer, mimeType, name } = await driveDownloadBuffer(toolInput.fileId);
        const displayName = toolInput.fileName || name || toolInput.fileId;
        const text = await extractText(buffer, mimeType, name);
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        result = {
          fileId: toolInput.fileId,
          fileName: displayName,
          mimeType,
          wordCount,
          // Truncate at 15 000 chars to stay inside Claude's context comfortably
          text: text.length > 15000 ? text.slice(0, 15000) + '\n\n[...document truncated at 15 000 chars...]' : text
        };
        break;
      }

      case 'drive_scan_folder': {
        if (!drive) throw new Error('Drive integration not loaded');
        const maxFiles = Math.min(toolInput.maxFiles || 10, 20);
        const typeFilter = (toolInput.fileTypes || 'all').toLowerCase();

        // List files in folder
        let mimeQuery = "trashed = false";
        if (typeFilter === 'pdf') {
          mimeQuery += " and mimeType = 'application/pdf'";
        } else if (typeFilter === 'docx') {
          mimeQuery += " and mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'";
        } else {
          mimeQuery += " and (mimeType = 'application/pdf' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType = 'application/vnd.google-apps.document')";
        }

        const files = await drive.listFolderFiles(toolInput.folderId, maxFiles, mimeQuery);
        const results = [];

        for (const file of files) {
          try {
            const { buffer, mimeType, name } = await driveDownloadBuffer(file.id);
            const text = await extractText(buffer, mimeType, name);
            results.push({
              fileId: file.id,
              fileName: file.name,
              mimeType,
              wordCount: text.split(/\s+/).filter(Boolean).length,
              text: text.length > 6000 ? text.slice(0, 6000) + '\n[truncated]' : text
            });
          } catch (parseErr) {
            results.push({ fileId: file.id, fileName: file.name, error: parseErr.message });
          }
        }

        result = { folderId: toolInput.folderId, totalFiles: results.length, documents: results };
        break;
      }

      // ── Drive Management (new) ──────────────────────────────────────────────
      case 'drive_list_folder': {
        if (!drive) throw new Error('Drive integration not loaded');
        const files = await drive.listFolder(toolInput.folderId || 'root', toolInput.maxResults || 30);
        result = { count: files.length, files };
        break;
      }

      case 'drive_rename_file': {
        if (!drive) throw new Error('Drive integration not loaded');
        const renamed = await drive.renameFile(toolInput.fileId, toolInput.newName);
        result = { success: true, ...renamed, message: `Renamed to "${toolInput.newName}"` };
        break;
      }

      case 'drive_move_file': {
        if (!drive) throw new Error('Drive integration not loaded');
        const moved = await drive.moveFile(toolInput.fileId, toolInput.newParentId);
        result = { success: true, ...moved, message: `Moved to folder ${toolInput.newParentId}` };
        break;
      }

      case 'drive_copy_file': {
        if (!drive) throw new Error('Drive integration not loaded');
        const copied = await drive.copyFile(toolInput.fileId, toolInput.newName, toolInput.parentId);
        result = { success: true, ...copied, message: `Copy created: ${copied.name}` };
        break;
      }

      case 'drive_delete_file': {
        if (!drive) throw new Error('Drive integration not loaded');
        if (toolInput.permanent) {
          const del = await drive.deleteFile(toolInput.fileId);
          result = { success: true, message: 'File permanently deleted', ...del };
        } else {
          const trashed = await drive.trashFile(toolInput.fileId);
          result = { success: true, message: `"${trashed.name}" moved to trash`, ...trashed };
        }
        break;
      }

      case 'drive_restore_file': {
        if (!drive) throw new Error('Drive integration not loaded');
        const restored = await drive.restoreFile(toolInput.fileId);
        result = { success: true, message: `"${restored.name}" restored from trash`, ...restored };
        break;
      }

      case 'drive_convert_file': {
        if (!drive) throw new Error('Drive integration not loaded');
        const formatMap = {
          'pdf': 'application/pdf',
          'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'csv': 'text/csv',
          'txt': 'text/plain',
          'html': 'text/html'
        };
        const targetMime = formatMap[toolInput.targetFormat] || toolInput.targetFormat;
        const converted = await drive.convertFile(toolInput.fileId, targetMime);
        result = { success: true, ...converted, message: `Converted to ${toolInput.targetFormat.toUpperCase()}` };
        break;
      }

      case 'drive_merge_pdfs': {
        if (!drive) throw new Error('Drive integration not loaded');
        const merged = await drive.mergeFiles(toolInput.fileIds, toolInput.mergedName || 'Merged Document');
        result = { success: true, ...merged, message: `Merged ${toolInput.fileIds.length} files into "${merged.merged}"` };
        break;
      }

      case 'drive_get_file_info': {
        if (!drive) throw new Error('Drive integration not loaded');
        const info = await drive.getFileMeta(toolInput.fileId);
        result = info;
        break;
      }

    // ─── Maintenance Tools ───────────────────────────────────────────────
    case 'maintenance_get_pending': {
      const maintenance = require('./integrations/maintenance');
      const items = await maintenance.getPendingItems();
      let filtered = items;
      if (input.villa) {
        filtered = items.filter(i => i.villa.toUpperCase().includes(input.villa.toUpperCase()));
      }
      return { success: true, total: filtered.length, items: filtered };
    }

    case 'maintenance_update_status': {
      const maintenance = require('./integrations/maintenance');
      const ok = await maintenance.updateStatus(
        input.tab,
        input.row,
        input.status || null,
        input.notes || null,
        input.photoAfterUrl || null
      );
      return ok
        ? { success: true, message: `Updated row ${input.row} in "${input.tab}"${input.status ? ' → ' + input.status : ''}` }
        : { success: false, error: 'Failed to update maintenance sheet' };
    }

      // ── Google Docs ────────────────────────────────────────────────────────
      case 'docs_create_document': {
        if (!docs) throw new Error('Docs integration not loaded');
        const doc = await docs.createDoc(toolInput.title, toolInput.content || '');
        result = { success: true, documentId: doc.documentId, title: toolInput.title, link: `https://docs.google.com/document/d/${doc.documentId}` };
        break;
      }

      case 'docs_read_document': {
        if (!docs) throw new Error('Docs integration not loaded');
        const content = await docs.readDoc(toolInput.documentId);
        result = { documentId: toolInput.documentId, content };
        break;
      }

      case 'docs_update_document': {
        if (!docs) throw new Error('Docs integration not loaded');
        await docs.updateDoc(toolInput.documentId, toolInput.content);
        result = { success: true, documentId: toolInput.documentId, message: 'Document updated' };
        break;
      }

      case 'docs_create_contract': {
        if (!docs) throw new Error('Docs integration not loaded');
        const contract = await docs.createContract({
          guestName: toolInput.guestName,
          villaName: toolInput.villaName,
          checkIn: toolInput.checkIn,
          checkOut: toolInput.checkOut,
          price: toolInput.price,
          extras: toolInput.extras || '',
          guestEmail: toolInput.guestEmail || ''
        });

        // Auto-save booking to memory
        if (contract.success) {
          const bookingId = memory.saveBooking({
            guest_name: toolInput.guestName,
            guest_email: toolInput.guestEmail || null,
            villa_name: toolInput.villaName,
            check_in: toolInput.checkIn,
            check_out: toolInput.checkOut,
            price: toolInput.price,
            status: 'contract_created',
            contract_doc_id: contract.documentId || null,
            calendar_event_id: null,
            notes: toolInput.extras || null
          });
          result = { ...contract, bookingId, message: `Contract created for ${toolInput.guestName} at ${toolInput.villaName}` };

          // Upsert guest record
          if (toolInput.guestEmail) {
            memory.upsertGuest({
              name: toolInput.guestName,
              email: toolInput.guestEmail,
              phone: null, nationality: null,
              passport_file_id: null,
              notes: `Guest at ${toolInput.villaName}`
            });
          }
        } else {
          result = contract;
        }
        break;
      }

      // ── Google Sheets ──────────────────────────────────────────────────────
      case 'sheets_read_data': {
        if (!sheets) throw new Error('Sheets integration not loaded');
        const data = await sheets.readSheet(toolInput.spreadsheetId, toolInput.range || 'Sheet1');
        result = { spreadsheetId: toolInput.spreadsheetId, range: toolInput.range, data };
        break;
      }

      case 'sheets_write_data': {
        if (!sheets) throw new Error('Sheets integration not loaded');
        // Defensive parse: Claude sometimes sends values as a JSON string instead of an array
        if (typeof toolInput.values === 'string') {
          try { toolInput.values = JSON.parse(toolInput.values); } catch(e) { /* leave as-is */ }
        }
        // UPGRADE #1: Validator pre-write gate — protect formulas
        if (validator) {
          try {
            const check = await validator.validateWrite(toolInput.spreadsheetId, toolInput.range, toolInput.values);
            if (!check.approved) {
              result = { success: false, error: 'Write blocked by Validator: ' + check.errors.join('; '), skippedCells: check.skippedCells };
              console.log('[Validator] BLOCKED write to ' + toolInput.range + ': ' + check.errors.join('; '));
              break;
            }
            if (check.skippedCells.length > 0) {
              console.log('[Validator] Protected ' + check.skippedCells.length + ' formula cells in ' + toolInput.range);
              toolInput.values = check.safeValues;
            }
          } catch(e) { console.warn('[Validator] Check failed, proceeding:', e.message); }
        }
        // UPGRADE #3: Track write for rollback
        if (rollback && toolInput._txId) {
          try {
            const prev = await sheets.readSheet(toolInput.spreadsheetId, toolInput.range);
            await rollback.addWrite(toolInput._txId, {
              spreadsheetId: toolInput.spreadsheetId,
              range: toolInput.range,
              previousValues: prev || [],
              newValues: toolInput.values
            });
          } catch(e) { /* rollback tracking failed, proceed anyway */ }
        }
        const writeResult = await sheets.writeSheet(toolInput.spreadsheetId, toolInput.range, toolInput.values);
        if (writeResult && writeResult.success) {
          // POST-WRITE VERIFICATION
          let wVerify = false;
          try {
            const wReadBack = await sheets.readSheet(toolInput.spreadsheetId, writeResult.updatedRange || toolInput.range);
            if (wReadBack && wReadBack.length > 0) { wVerify = true; console.log('[Sheets] Write verify OK:', writeResult.updatedRange); }
          } catch(wvErr) { console.warn('[Sheets] Write verify error:', wvErr.message); }
          result = { success: true, message: `Data written to ${toolInput.range}`, updatedRange: writeResult.updatedRange, updatedRows: writeResult.updatedRows, verified: wVerify };
        } else {
          result = { success: false, error: writeResult ? writeResult.error : 'Sheets write returned no response', message: `FAILED to write to ${toolInput.range}` };
        }
        break;
      }

      case 'sheets_append_row': {
        if (!sheets) throw new Error('Sheets integration not loaded');
        // UPGRADE #1: Validator — check appended row format
        if (validator && toolInput.values) {
          try {
            var appendCheck = await validator.validateWrite(toolInput.spreadsheetId, (toolInput.sheetName || 'Sheet1') + '!A1:Z1', [toolInput.values]);
            if (appendCheck.skippedCells.length > 0) {
              console.log('[Validator] Cleaned append row: ' + appendCheck.skippedCells.length + ' cells adjusted');
              toolInput.values = appendCheck.safeValues[0] || toolInput.values;
            }
          } catch(e) { /* append is low-risk, proceed */ }
        }
        const appendResult = await sheets.appendSheet(toolInput.spreadsheetId, toolInput.sheetName || 'Sheet1', toolInput.values);
        if (appendResult && appendResult.success) {
          // POST-WRITE VERIFICATION: read back the written range to confirm
          let verifyOk = false;
          let verifyMsg = '';
          try {
            if (appendResult.updatedRange) {
              const readBack = await sheets.readSheet(toolInput.spreadsheetId, appendResult.updatedRange);
              if (readBack && readBack.length > 0) {
                verifyOk = true;
                verifyMsg = `Verified: ${readBack.length} row(s) confirmed at ${appendResult.updatedRange}`;
                console.log(`[Sheets] Post-write verify OK: ${readBack.length} rows at ${appendResult.updatedRange}`);
              } else {
                verifyMsg = `Warning: append reported success but read-back returned empty for ${appendResult.updatedRange}`;
                console.warn(`[Sheets] Post-write verify EMPTY: ${appendResult.updatedRange}`);
              }
            }
          } catch (verifyErr) {
            verifyMsg = `Append succeeded but verification read failed: ${verifyErr.message}`;
            console.warn(`[Sheets] Post-write verify error: ${verifyErr.message}`);
          }
          result = {
            success: true,
            message: `Row appended to ${toolInput.sheetName || 'Sheet1'}`,
            updatedRange: appendResult.updatedRange,
            updatedRows: appendResult.updatedRows,
            sheetName: appendResult.sheetName,
            verified: verifyOk,
            verificationDetail: verifyMsg
          };
        } else {
          result = {
            success: false,
            error: appendResult ? appendResult.error : 'Sheets append returned no response',
            message: `FAILED to append row to ${toolInput.sheetName || 'Sheet1'}. Error: ${appendResult ? appendResult.error : 'unknown'}`
          };
        }
        break;
      }

      // ── Cleaning ───────────────────────────────────────────────────────────
      case 'cleaning_generate_schedule': {
        if (!cleaning) throw new Error('Cleaning integration not loaded');
        const schedule = await cleaning.generateWeeklySchedule(
          toolInput.checkIns || [],
          toolInput.checkOuts || [],
          toolInput.villaName || ''
        );
        result = { schedule, formatted: cleaning.formatScheduleText(schedule) };
        break;
      }

      // ── Marketing ──────────────────────────────────────────────────────────
      case 'marketing_generate_content': {
        const { generateMarketingContent } = require('./integrations/marketing');
        const content = await generateMarketingContent(
          toolInput.villaName,
          toolInput.contentType || 'instagram',
          toolInput.details || {}
        );
        result = { villaName: toolInput.villaName, contentType: toolInput.contentType, content };
        break;
      }

      // ── Memory Operations ──────────────────────────────────────────────────
      case 'get_owner_profile': {
        const profile = memory.getOwnerProfile();
        const villas = memory.getAllVillas();
        const upcoming = memory.getUpcomingBookings(30);
        result = { profile, villas, upcomingBookings: upcoming };
        break;
      }

      case 'save_note': {
        const noteNamespace = toolInput.namespace || toolInput.business || 'general';
        const noteTitle = toolInput.title || 'Agent Note';
        const noteBody = toolInput.body || toolInput.content || '';
        const noteTags = [toolInput.tags || '', noteNamespace].filter(Boolean).join(',');
        memory.saveNote(noteTitle, noteBody, noteTags);
        result = { success: true, message: `Note saved: "${noteTitle}" [${noteNamespace}]` };
        break;
      }

      case 'villa_update_utility': {
        // Updates villa utility/security facts: lock code, electricity meter, electricity kwh, wifi
        // toolInput: { villa_name, field, value }
        // field options: lock_code | electricity_meter | electricity_kwh | wifi_name | wifi_password | wifi_mbps
        if (!toolInput.villa_name || !toolInput.field || toolInput.value === undefined) {
          result = { success: false, error: 'villa_name, field, and value are required' };
          break;
        }
        const key = toolInput.villa_name.replace(/^Villa /i, '').toLowerCase().replace(/ /g, '_');
        const fieldMap = {
          lock_code:          { category: 'villa', factKey: `lock_${key}` },
          electricity_meter:  { category: 'villa', factKey: `meter_${key}` },
          electricity_kwh:    { category: 'villa', factKey: `kwh_${key}` },
          wifi_name:          { category: 'wifi',  factKey: `wifi_name_${key}` },
          wifi_password:      { category: 'wifi',  factKey: `wifi_pass_${key}` },
          wifi_mbps:          { category: 'wifi',  factKey: `wifi_mbps_${key}` },
          daya_listrik:       { category: 'villa', factKey: `daya_${key}` },
        };
        const mapping = fieldMap[toolInput.field];
        if (!mapping) {
          result = { success: false, error: `Unknown field "${toolInput.field}". Valid: ${Object.keys(fieldMap).join(', ')}` };
          break;
        }
        memory.setFact(mapping.category, mapping.factKey, String(toolInput.value), 'user');
        const readBack = memory.getFact(mapping.factKey);
        console.log(`[Executor] villa_update_utility: ${mapping.factKey} = ${readBack}`);
        result = {
          success: true,
          villa: toolInput.villa_name,
          field: toolInput.field,
          factKey: mapping.factKey,
          newValue: readBack,
          verified: readBack === String(toolInput.value),
          message: `Updated ${toolInput.field} for ${toolInput.villa_name}: ${readBack}`
        };
        break;
      }

      case 'villa_get_utilities': {
        // Read all utility facts for a villa
        if (!toolInput.villa_name) { result = { success: false, error: 'villa_name required' }; break; }
        const vKey = toolInput.villa_name.replace(/^Villa /i, '').toLowerCase().replace(/ /g, '_');
        result = {
          success: true,
          villa: toolInput.villa_name,
          lock_code:         memory.getFact(`lock_${vKey}`) || null,
          electricity_meter: memory.getFact(`meter_${vKey}`) || null,
          electricity_kwh:   memory.getFact(`kwh_${vKey}`) || null,
          wifi_name:         memory.getFact(`wifi_name_${vKey}`) || null,
          wifi_password:     memory.getFact(`wifi_pass_${vKey}`) || null,
          wifi_mbps:         memory.getFact(`wifi_mbps_${vKey}`) || null,
        };
        break;
      }

      case 'get_notes': {
        const getNsFilter = toolInput.namespace || toolInput.business || null;
        const getLimit = toolInput.limit || 20;
        let notes = memory.getNotes ? memory.getNotes(getLimit * 3) : [];
        if (!notes.length) {
          // fallback: read from DB directly
          try {
            notes = memory.db.prepare(
              'SELECT title, body, tags, created_at FROM notes ORDER BY created_at DESC LIMIT ?'
            ).all(getLimit * 3);
          } catch(e) { notes = []; }
        }
        if (getNsFilter) {
          notes = notes.filter(n => (n.tags || '').toLowerCase().includes(getNsFilter.toLowerCase()));
        }
        notes = notes.slice(0, getLimit);
        result = { namespace: getNsFilter || 'all', count: notes.length, notes };
        break;
      }

      case 'list_businesses': {
        // Return distinct namespaces from notes tags
        let bizNotes = [];
        try {
          bizNotes = memory.db.prepare("SELECT DISTINCT tags FROM notes WHERE tags IS NOT NULL AND tags != ''").all();
        } catch(e) {}
        const namespaces = new Set(['villa-ops']);
        bizNotes.forEach(n => {
          (n.tags || '').split(',').forEach(t => {
            const trimmed = t.trim();
            if (trimmed && trimmed !== 'general') namespaces.add(trimmed);
          });
        });
        result = { businesses: Array.from(namespaces), count: namespaces.size };
        break;
      }

      // ── Notion (optional) ──────────────────────────────────────────────────
      case 'notion_get_pages': {
        if (!notion) throw new Error('Notion integration not loaded');
        const pages = await notion.getPages();
        result = { count: pages.length, pages };
        break;
      }

      case 'notion_create_page': {
        if (!notion) throw new Error('Notion integration not loaded');
        const page = await notion.createPage(toolInput.databaseId, toolInput.properties, toolInput.content);
        result = { success: true, pageId: page.id, url: page.url };
        break;
      }

      // ── Maintenance ────────────────────────────────────────────────────────
      case 'maintenance_add_task': {
        // UPGRADE #2: Write to Google Sheets (single source of truth), not SQLite
        if (!sheets) throw new Error('Sheets integration not loaded');
        const MAINT_SID = '1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE';
        const today = new Date();
        const day = String(today.getDate());
        const month = today.toLocaleString('en', { month: 'short' });
        const desc = `${day} ${month} ${toolInput.reported_by || 'Bot'} ${toolInput.villa_name} ${toolInput.title}`;
        const row = [
          '',                                           // A: empty
          desc,                                         // B: DESCRIPTION
          day,                                          // C: DAY
          month,                                        // D: MONTH
          toolInput.assigned_to || toolInput.reported_by || '',  // E: PIC
          toolInput.villa_name || '',                    // F: VILLA
          '',                                           // G: LOCATION
          toolInput.title || '',                         // H: ISSUE
          '',                                           // I: PHOTOS BEFORE
          toolInput.notes || toolInput.description || '', // J: NOTES
          toolInput.priority === 'urgent' ? 'URGENT' : 'PENDING',  // K: STATUS
          ''                                            // L: PHOTOS AFTER
        ];
        await sheets.appendSheet(MAINT_SID, 'Sheet1', row);
        // Also store in SQLite for local queries
        let taskId = null;
        try { taskId = memory.addMaintenanceTask({
          villa_name: toolInput.villa_name, title: toolInput.title,
          description: toolInput.description || null, category: toolInput.category || 'general',
          priority: toolInput.priority || 'medium', reported_by: toolInput.reported_by || null,
          assigned_to: toolInput.assigned_to || null, notes: toolInput.notes || null
        }); } catch(e) {}
        result = {
          success: true,
          task_id: taskId,
          written_to: 'Google Sheets + SQLite',
          message: `Maintenance task added to sheet for ${toolInput.villa_name}: "${toolInput.title}" [${toolInput.priority || 'medium'}]`
        };

        // ── EventBus bridge: emit maintenance event ───────────────────────────
        {
          const eb = _getEventBus();
          if (eb) {
            eb.emitMaintenance({
              title:        toolInput.title       || 'Maintenance Request',
              description:  toolInput.description || toolInput.notes || '',
              villa_name:   toolInput.villa_name  || '',
              severity:     toolInput.priority === 'urgent' ? 'high' : (toolInput.priority || 'medium'),
              reported_by:  toolInput.reported_by || userEmail,
              assigned_to:  toolInput.assigned_to || '',
              fromExecutor: true
            }, 'executor');
            console.log('[Executor→EventBus] maintenance.issue emitted');
          }
        }
        break;
      }

      case 'maintenance_update_task': {
        const updated = memory.updateMaintenanceTask(toolInput.task_id, {
          status: toolInput.status,
          assigned_to: toolInput.assigned_to,
          actual_cost: toolInput.actual_cost,
          cost_account: toolInput.cost_account,
          completed_date: toolInput.completed_date || (toolInput.status === 'completed' ? new Date().toISOString().slice(0, 10) : undefined),
          notes: toolInput.notes,
          priority: toolInput.priority
        });
        // If completed with actual cost, also log the expense
        if (toolInput.status === 'completed' && toolInput.actual_cost) {
          const tasks = memory.getMaintenanceTasks({ limit: 1 });
          const task = memory.db.prepare('SELECT * FROM maintenance_tasks WHERE id=?').get(toolInput.task_id);
          if (task) {
            memory.logTransaction({
              type: 'expense',
              category: 'maintenance',
              description: `Maintenance: ${task.title} — ${task.villa_name}`,
              amount: toolInput.actual_cost,
              currency: 'IDR',
              villa_name: task.villa_name,
              payment_method: toolInput.cost_account || null,
              status: 'paid',
              date: toolInput.completed_date || new Date().toISOString().slice(0, 10)
            });
            // Log to Google Sheets via finance.logVariableExpense()
            if (finance) {
              try {
                await finance.logVariableExpense({
                  date: toolInput.completed_date || new Date().toISOString().slice(0, 10),
                  property: task.villa_name || '',
                  category: 'Villa Expense',
                  description: `Maintenance: ${task.title} — ${task.villa_name}`,
                  amount: toolInput.actual_cost,
                  notes: toolInput.cost_account || ''
                });
                console.log('[Executor] maintenance→logVariableExpense() OK');
              } catch (shErr) {
                console.error('[Executor] maintenance→logVariableExpense() FAILED:', shErr.message);
              }
            }
          }
        }
        result = { success: updated, task_id: toolInput.task_id, message: updated ? `Task #${toolInput.task_id} updated` : 'Task not found' };
        break;
      }

      case 'maintenance_get_tasks': {
        const tasks = memory.getMaintenanceTasks({
          villa_name: toolInput.villa_name,
          status: toolInput.status,
          priority: toolInput.priority,
          category: toolInput.category,
          limit: toolInput.limit || 30
        });
        result = {
          count: tasks.length,
          tasks,
          open_count: tasks.filter(t => t.status === 'open').length,
          urgent_count: tasks.filter(t => t.priority === 'urgent').length,
          total_estimated_cost: tasks.reduce((s, t) => s + (t.estimated_cost || 0), 0)
        };
        break;
      }

      case 'maintenance_get_summary': {
        const summary = memory.getMaintenanceSummary();
        const allOpen = memory.getMaintenanceTasks({ status: 'open' });
        const allUrgent = memory.getMaintenanceTasks({ priority: 'urgent' });
        result = {
          by_villa: summary,
          total_open: allOpen.length,
          total_urgent: allUrgent.length,
          urgent_tasks: allUrgent.slice(0, 5)
        };
        break;
      }

      case 'web_search': {
        if (!search) throw new Error('Search integration not loaded');
        const result_search = await search.webSearch(toolInput.query, toolInput.num_results || 5);
        result = result_search;
        break;
      }

      case 'fetch_webpage': {
        if (!search) throw new Error('Search integration not loaded');
        const result_fetch = await search.fetchWebpage(toolInput.url, toolInput.max_length || 5000);
        result = result_fetch;
        break;
      }

      case 'run_code': {
        if (!sandbox) throw new Error('Sandbox integration not loaded');
        const result_code = await sandbox.runCode(toolInput.code, toolInput.timeout || 5000);
        result = result_code;
        break;
      }

      // ── Image Generation (DALL-E 3 via OpenAI) ─────────────────────────────
      case 'generate_image': {
        let OpenAI_img;
        try { OpenAI_img = require('openai'); } catch(e) { throw new Error('OpenAI package not installed'); }
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
        const oai_img = new OpenAI_img({ apiKey: process.env.OPENAI_API_KEY });
        const imgSize = toolInput.size || '1024x1024';
        const imgQuality = toolInput.quality || 'standard';
        const imgStyle = toolInput.style || 'natural';
        const imgN = 1;
        const imgResponse = await oai_img.images.generate({
          model: 'dall-e-3',
          prompt: toolInput.prompt,
          n: imgN,
          size: imgSize,
          quality: imgQuality,
          style: imgStyle,
          response_format: 'url'
        });
        const imgUrl = imgResponse.data[0].url;
        const revisedPrompt = imgResponse.data[0].revised_prompt;
        result = {
          success: true,
          url: imgUrl,
          revised_prompt: revisedPrompt,
          size: imgSize,
          model: 'dall-e-3',
          message: `Image generated successfully`,
          display_url: imgUrl
        };
        break;
      }


      // ─── NEW FINANCE TOOLS (Dual-Sheet) ─────────────────────────────────────
      case 'finance_log_variable': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.logVariableExpense({
          date: toolInput.date,
          property: toolInput.property || '',
          category: toolInput.category || 'EXPENSES',
          description: toolInput.description,
          amount: toolInput.amount,
          notes: toolInput.notes || ''
        });
        break;
      }

      case 'finance_log_recurring': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.logRecurringExpense({
          property: toolInput.property || '',
          category: toolInput.category,
          frequency: toolInput.frequency || 'MONTHLY',
          startDate: toolInput.startDate,
          endDate: toolInput.endDate || '',
          amount: toolInput.amount,
          notes: toolInput.notes || ''
        });
        break;
      }

      case 'finance_log_income': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.logIncome({
          cancelled: false,
          category: toolInput.category || 'Rental',
          date: toolInput.date,
          guestName: toolInput.guestName || '',
          numGuests: toolInput.numGuests || '',
          property: toolInput.property || '',
          checkIn: toolInput.checkIn || '',
          checkOut: toolInput.checkOut || '',
          nights: toolInput.nights || '',
          rentalIncome: toolInput.rentalIncome,
          otherFees: toolInput.otherFees || 0,
          notes: toolInput.notes || ''
        });
        break;
      }

      case 'finance_get_recent': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.getRecentExpenses(toolInput.limit || 10);
        break;
      }

      case 'finance_get_upcoming_recurring': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.getUpcomingRecurring(toolInput.daysAhead || 30);
        break;
      }

      case 'finance_get_income_summary': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.getIncomeSummary(toolInput.limit || 10);
        break;
      }

      case 'finance_monthly_overview': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.getMonthlyOverview({
          month: toolInput.month,
          year: toolInput.year
        });
        break;
      }

      case 'finance_sync_expenses': {
        if (!finance) throw new Error('Finance integration not loaded');
        result = await finance.syncExpenseSummary({
          month: toolInput.month,
          year: toolInput.year
        });
        break;
      }



      // ═══ DOCUMENT PROCESSING ═══
      case 'doc_read_pdf': {
        const pdfParseFn = require('pdf-parse');
        const fs_rpdf = require('fs');
        if (!toolInput.file_path || !fs_rpdf.existsSync(toolInput.file_path)) throw new Error('Provide valid file_path');
        const pdfData = await pdfParseFn(fs_rpdf.readFileSync(toolInput.file_path));
        result = { text: pdfData.text.substring(0, 10000), pages: pdfData.numpages, info: pdfData.info };
        break;
      }

      case 'doc_create_pdf': {
        const PDFDocument = require('pdfkit');
        const fs_cpdf = require('fs');
        const pdfPath = '/tmp/tvmbot_' + Date.now() + '.pdf';
        const pdfDoc = new PDFDocument({ margin: 50 });
        const pdfStream = fs_cpdf.createWriteStream(pdfPath);
        pdfDoc.pipe(pdfStream);
        if (toolInput.title) { pdfDoc.fontSize(20).font('Helvetica-Bold').text(toolInput.title, { align: 'center' }); pdfDoc.moveDown(); }
        if (toolInput.subtitle) { pdfDoc.fontSize(14).font('Helvetica').fillColor('#666').text(toolInput.subtitle, { align: 'center' }); pdfDoc.moveDown(); pdfDoc.fillColor('#000'); }
        const pdfSections = toolInput.sections || [{ body: toolInput.content || toolInput.text || '' }];
        for (const sec of pdfSections) {
          if (sec.heading) { pdfDoc.fontSize(14).font('Helvetica-Bold').text(sec.heading); pdfDoc.moveDown(0.5); }
          if (sec.body) { pdfDoc.fontSize(11).font('Helvetica').text(sec.body, { lineGap: 3 }); pdfDoc.moveDown(); }
        }
        pdfDoc.end();
        await new Promise(resolve => pdfStream.on('finish', resolve));
        const pdfDelivery = await deliverDocument(pdfPath, (toolInput.title || 'document').replace(/[^a-zA-Z0-9 ]/g,'') + '.pdf', 'application/pdf', drive);
        result = { success: true, file_name: pdfDelivery.file_name, ...pdfDelivery, message: '✅ PDF ready — ' + pdfDelivery.download_url };
        break;
      }

      case 'doc_create_docx': {
        const docxLib = require('docx');
        const fs_cdocx = require('fs');
        const docxPath = '/tmp/tvmbot_' + Date.now() + '.docx';
        const docChildren = [];
        if (toolInput.title) {
          docChildren.push(new docxLib.Paragraph({ children: [new docxLib.TextRun({ text: toolInput.title, bold: true, size: 36 })], alignment: docxLib.AlignmentType.CENTER, spacing: { after: 300 } }));
        }
        const docSecs = toolInput.sections || [{ body: toolInput.content || '' }];
        for (const sec of docSecs) {
          if (sec.heading) docChildren.push(new docxLib.Paragraph({ children: [new docxLib.TextRun({ text: sec.heading, bold: true, size: 28 })], spacing: { before: 300, after: 100 } }));
          if (sec.body) {
            for (const para of sec.body.split('\n')) {
              docChildren.push(new docxLib.Paragraph({ children: [new docxLib.TextRun({ text: para, size: 22 })], spacing: { after: 100 } }));
            }
          }
        }
        const docxDoc = new docxLib.Document({ sections: [{ children: docChildren }] });
        const docxBuf = await docxLib.Packer.toBuffer(docxDoc);
        fs_cdocx.writeFileSync(docxPath, docxBuf);
        const docxDelivery = await deliverDocument(docxPath, (toolInput.title || 'document').replace(/[^a-zA-Z0-9 ]/g,'') + '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', drive);
        result = { success: true, file_name: docxDelivery.file_name, ...docxDelivery, message: '✅ Word doc ready — ' + docxDelivery.download_url };
        break;
      }

      case 'doc_read_docx': {
        const mammoth = require('mammoth');
        const fs_rdocx = require('fs');
        if (!toolInput.file_path || !fs_rdocx.existsSync(toolInput.file_path)) throw new Error('Provide valid file_path');
        const mResult = await mammoth.extractRawText({ buffer: fs_rdocx.readFileSync(toolInput.file_path) });
        result = { text: mResult.value.substring(0, 10000), messages: mResult.messages };
        break;
      }

      case 'doc_create_xlsx': {
        const XLSX_C = require('xlsx');
        const fs_cxlsx = require('fs');
        const xlsxPath = '/tmp/tvmbot_' + Date.now() + '.xlsx';
        const wb = XLSX_C.utils.book_new();
        const xlSheets = toolInput.sheets || [{ name: 'Sheet1', data: toolInput.data || [[]] }];
        for (const s of xlSheets) { XLSX_C.utils.book_append_sheet(wb, XLSX_C.utils.aoa_to_sheet(s.data), s.name || 'Sheet1'); }
        XLSX_C.writeFile(wb, xlsxPath);
        const xlsxDelivery = await deliverDocument(xlsxPath, (toolInput.title || 'spreadsheet').replace(/[^a-zA-Z0-9 ]/g,'') + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', drive);
        result = { success: true, file_name: xlsxDelivery.file_name, ...xlsxDelivery, message: '✅ Spreadsheet ready — ' + xlsxDelivery.download_url };
        break;
      }

      case 'doc_create_pptx': {
        const PptxGenJS = require('pptxgenjs');
        const pptxPath = '/tmp/tvmbot_' + Date.now() + '.pptx';
        const pptx = new PptxGenJS();
        pptx.author = 'TVMbot'; pptx.company = 'The Villa Managers';
        const pptxSlides = toolInput.slides || [{ title: toolInput.title || 'Untitled' }];
        for (const sd of pptxSlides) {
          const slide = pptx.addSlide();
          if (sd.title) slide.addText(sd.title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true, color: '333333' });
          if (sd.content) slide.addText(sd.content, { x: 0.5, y: 1.5, w: 9, h: 4, fontSize: 16, color: '666666' });
          if (sd.bullets) { slide.addText(sd.bullets.map(b => ({ text: b, options: { bullet: true, fontSize: 14 } })), { x: 0.5, y: 1.5, w: 9, h: 4 }); }
        }
        await pptx.writeFile({ fileName: pptxPath });
        const pptxDelivery = await deliverDocument(pptxPath, (toolInput.title || 'presentation').replace(/[^a-zA-Z0-9 ]/g,'') + '.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', drive);
        result = { success: true, file_name: pptxDelivery.file_name, ...pptxDelivery, message: '✅ Presentation ready — ' + pptxDelivery.download_url };
        break;
      }

      // ═══ WEB SCRAPING & MARKETING (routed through Ruflo pipeline) ═══
      case 'scrape_url':
      case 'scrape_multiple':
      case 'scrape_competitor_prices': {
        // Route through Ruflo for circuit breaker, metrics, gossip integration
        let ruflo;
        try { ruflo = require('./ruflo-integration'); } catch(e) { /* ruflo not available */ }

        if (ruflo && typeof ruflo.executeScraperTool === 'function') {
          result = await ruflo.executeScraperTool(toolName, toolInput);
        } else {
          // Fallback: direct call if Ruflo not loaded
          const scraper = require('./web-scraper');
          result = await scraper.executeTool(toolName, toolInput);
        }
        break;
      }

      // ── User Settings Tools ──────────────────────────────────────────────────
      case 'user_set_timezone': {
        const memory = require('./memory');
        memory.upsertUserSettings(toolInput.user_id, { timezone: toolInput.timezone });
        result = { success: true, message: `Timezone set to ${toolInput.timezone} for user ${toolInput.user_id}` };
        break;
      }
      case 'user_set_language': {
        const memory = require('./memory');
        memory.upsertUserSettings(toolInput.user_id, { language: toolInput.language });
        result = { success: true, message: `Language set to ${toolInput.language} for user ${toolInput.user_id}` };
        break;
      }
      case 'user_get_settings': {
        const memory = require('./memory');
        const settings = memory.getUserSettings(toolInput.user_id);
        result = settings || { message: 'No settings found for this user. Using defaults.' };
        break;
      }

      case 'marketing_generate_listing': {
        result = { prompt_context: 'Generate a ' + (toolInput.style || 'luxury') + ' ' + (toolInput.platform || 'airbnb') + ' listing for ' + toolInput.villa_name + '. Include: compelling title, description, key amenities, house rules. ' + (toolInput.features ? 'Features: ' + toolInput.features : '') + (toolInput.location ? ' Location: ' + toolInput.location : ''), platform: toolInput.platform || 'airbnb', villa: toolInput.villa_name };
        break;
      }

      case 'marketing_social_post': {
        result = { prompt_context: 'Create a social media post for ' + (toolInput.platform || 'instagram') + '. Topic: ' + toolInput.topic + '. Tone: ' + (toolInput.tone || 'professional') + '.', platform: toolInput.platform || 'instagram' };
        break;
      }


      // ── Notion Todo / Task Management ────────────────────────────────────────
      case 'todo_get_tasks': {
        if (!notionTodo) throw new Error('Notion Todo integration not loaded');
        const todoTasks = await notionTodo.getTasks({
          status: toolInput.status,
          priority: toolInput.priority,
          assignee: toolInput.assignee,
          limit: toolInput.limit
        });
        result = todoTasks;
        break;
      }

      case 'todo_create_task': {
        if (!notionTodo) throw new Error('Notion Todo integration not loaded');
        const createdTask = await notionTodo.createTask({
          task_name: toolInput.task_name,
          assignee: toolInput.assignee,
          priority: toolInput.priority,
          due_date: toolInput.due_date,
          description: toolInput.description,
          status: toolInput.status
        });
        result = createdTask;
        break;
      }

      case 'todo_update_task': {
        if (!notionTodo) throw new Error('Notion Todo integration not loaded');
        const updatedTask = await notionTodo.updateTask(toolInput.task_id, {
          status: toolInput.status,
          priority: toolInput.priority,
          assignee: toolInput.assignee,
          due_date: toolInput.due_date,
          description: toolInput.description,
          task_name: toolInput.task_name
        });
        result = updatedTask;
        break;
      }

      case 'todo_delete_task': {
        if (!notionTodo) throw new Error('Notion Todo integration not loaded');
        result = await notionTodo.deleteTask(toolInput.task_id);
        break;
      }

      case 'todo_get_summary': {
        if (!notionTodo) throw new Error('Notion Todo integration not loaded');
        result = await notionTodo.getTaskSummary();
        break;
      }

      default:
        result = { error: `Unknown tool: ${toolName}` };
        status = 'ERROR';
        break;
    }

  } catch (err) {
    console.error(`[Executor] Error in ${toolName}:`, err.message);
    result = { error: err.message, tool: toolName };
    status = 'ERROR';
  }

  // Audit log every execution
  audit.log(toolName, JSON.stringify(toolInput).slice(0, 500), userEmail, status);

  const elapsed = Date.now() - startTime;
  console.log(`[Executor] ${toolName} → ${status} (${elapsed}ms)`);

  return result;
}

// ─── Execute Multiple Tools in Parallel (for independent steps) ───────────────
async function executeParallel(toolCalls, userEmail) {
  return Promise.all(toolCalls.map(({ toolName, toolInput }) => executeTool(toolName, toolInput, userEmail)));
}

module.exports = { executeTool, executeParallel, SENSITIVE_TOOLS };
