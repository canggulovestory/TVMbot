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
let gmail, calendar, drive, docs, sheets, cleaning, notion, finance;

try { gmail    = require('./integrations/gmail');    } catch(e) { console.warn('[Executor] Gmail not available:', e.message); }
try { calendar = require('./integrations/calendar'); } catch(e) { console.warn('[Executor] Calendar not available:', e.message); }
try { drive    = require('./integrations/drive');    } catch(e) { console.warn('[Executor] Drive not available:', e.message); }
try { docs     = require('./integrations/docs');     } catch(e) { console.warn('[Executor] Docs not available:', e.message); }
try { sheets   = require('./integrations/sheets');   } catch(e) { console.warn('[Executor] Sheets not available:', e.message); }
try { cleaning = require('./integrations/cleaning'); } catch(e) { console.warn('[Executor] Cleaning not available:', e.message); }
try { notion   = require('./integrations/notion');   } catch(e) { console.warn('[Executor] Notion not available:', e.message); }
try { finance  = require('./integrations/finance');  } catch(e) { console.warn('[Executor] Finance not available:', e.message); }

// ─── Sensitive Tools (require supervisor approval) ─────────────────────────────
const SENSITIVE_TOOLS = [
  'gmail_send_message',
  'calendar_create_event',
  'docs_create_contract',
  'docs_create_document',
  'docs_update_document',
  'sheets_write_data',
  'sheets_append_row'
];

// ─── Main Tool Executor ────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, userEmail = 'unknown') {
  const startTime = Date.now();
  let result;
  let status = 'SUCCESS';

  try {
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
        if (!gmail) throw new Error('Gmail integration not loaded');
        const sent = await gmail.sendEmail(toolInput.to, toolInput.subject, toolInput.body);
        result = { success: true, message: `Email sent to ${toolInput.to}`, messageId: sent?.id };

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
        if (!calendar) throw new Error('Calendar integration not loaded');
        const event = await calendar.createEvent(
          toolInput.summary,
          toolInput.startTime,
          toolInput.endTime,
          toolInput.description || '',
          toolInput.attendees || []
        );
        result = { success: true, eventId: event.id, link: event.htmlLink, message: `Event "${toolInput.summary}" created` };

        // Store in memory
        memory.setFact('calendar', `event_${Date.now()}`,
          `Created: ${toolInput.summary} at ${toolInput.startTime}`, userEmail);
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
        // Auto-log to Sheets if configured
        const profile = memory.getOwnerProfile();
        const sheetsId = profile.sheets_booking_id;
        let sheetsResult = { skipped: true };
        if (sheetsId && finance) {
          sheetsResult = await finance.logTransactionToSheets(sheetsId, {
            date: toolInput.date || new Date().toISOString().slice(0, 10),
            type: 'income',
            category: toolInput.villa_name || toolInput.category || 'booking',
            amount: toolInput.amount,
            account: toolInput.account || toolInput.payment_method || '',
            note: toolInput.description || ''
          });
        }
        result = {
          success: true, transactionId: txId,
          message: `Payment of ${toolInput.currency || 'IDR'} ${toolInput.amount} recorded`,
          sheets: sheetsResult
        };
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
        const profile = memory.getOwnerProfile();
        const sheetsId = profile.sheets_booking_id;
        let sheetsResult = { skipped: true };
        if (sheetsId && finance) {
          // Map expense category to sheet category names
          const expenseCategoryMap = {
            cleaning: 'Villa Expense', maintenance: 'Villa Expense',
            staff: 'Salary', utilities: toolInput.villa_name ? `${toolInput.villa_name} Electricity` : 'Villa Expense',
            supplies: 'Villa Expense', other: 'Villa Expense'
          };
          const sheetCategory = expenseCategoryMap[toolInput.category] || toolInput.category || 'Villa Expense';
          sheetsResult = await finance.logTransactionToSheets(sheetsId, {
            date: toolInput.date || new Date().toISOString().slice(0, 10),
            type: 'expense',
            category: sheetCategory,
            amount: toolInput.amount,
            account: toolInput.account || toolInput.payment_method || '',
            note: toolInput.description || ''
          });
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
          // Log to Sheets
          const profileInv = memory.getOwnerProfile();
          const sheetsIdInv = profileInv.sheets_booking_id;
          if (sheetsIdInv && finance) {
            await finance.logTransactionToSheets(sheetsIdInv, {
              date: new Date().toISOString().slice(0, 10),
              type: 'income',
              category: inv.villa_name || 'booking',
              amount: inv.total,
              account: toolInput.account || toolInput.payment_method || '',
              note: `Invoice ${toolInput.invoice_number} — ${inv.guest_name}`
            });
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
        await sheets.writeSheet(toolInput.spreadsheetId, toolInput.range, toolInput.values);
        result = { success: true, message: `Data written to ${toolInput.range}` };
        break;
      }

      case 'sheets_append_row': {
        if (!sheets) throw new Error('Sheets integration not loaded');
        await sheets.appendSheet(toolInput.spreadsheetId, toolInput.sheetName || 'Sheet1', toolInput.values);
        result = { success: true, message: `Row appended to ${toolInput.sheetName || 'Sheet1'}` };
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
        memory.saveNote(
          toolInput.title || 'Agent Note',
          toolInput.body || toolInput.content || '',
          toolInput.tags || ''
        );
        result = { success: true, message: `Note saved: "${toolInput.title}"` };
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
