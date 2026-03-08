// integrations/finance.js — Invoice PDF Generation & Sheets Auto-Logging
// Generates professional PDF invoices using pdfkit

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const INVOICE_DIR = path.join(DATA_DIR, 'invoices');
if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

// ─── PDF Invoice Generator ─────────────────────────────────────────────────────
async function generateInvoicePDF(invoice, ownerProfile = {}) {
  const PDFDocument = require('pdfkit');

  const fileName  = `${invoice.invoice_number}.pdf`;
  const filePath  = path.join(INVOICE_DIR, fileName);
  const lineItems = typeof invoice.line_items === 'string'
    ? JSON.parse(invoice.line_items)
    : (invoice.line_items || []);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const GREEN  = '#16a34a';
    const DARK   = '#0f172a';
    const MUTED  = '#64748b';
    const BORDER = '#e2e8f0';
    const W      = 495; // usable width

    // ── Header band ──────────────────────────────────────────────────────────
    doc.rect(50, 50, W, 80).fill(GREEN);
    doc.fillColor('#fff').fontSize(24).font('Helvetica-Bold')
       .text(ownerProfile.company || 'The Villa Managers', 70, 68);
    doc.fontSize(10).font('Helvetica')
       .text('Villa Rental Invoice', 70, 96);

    // Invoice meta (top-right)
    doc.fontSize(10).fillColor('#fff')
       .text(`Invoice #:  ${invoice.invoice_number}`, 350, 68, { width: 175, align: 'right' })
       .text(`Date:          ${invoice.created_at?.slice(0,10) || new Date().toISOString().slice(0,10)}`, 350, 84, { width: 175, align: 'right' })
       .text(`Due:            ${invoice.due_date || 'Upon receipt'}`, 350, 100, { width: 175, align: 'right' });

    // ── From / To block ──────────────────────────────────────────────────────
    const blockY = 155;
    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text('FROM', 50, blockY);
    doc.fillColor(DARK).fontSize(10).font('Helvetica-Bold')
       .text(ownerProfile.company || 'The Villa Managers', 50, blockY + 14);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(ownerProfile.email || '', 50, blockY + 28)
       .text(ownerProfile.phone || '', 50, blockY + 40);

    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text('BILL TO', 300, blockY);
    doc.fillColor(DARK).fontSize(10).font('Helvetica-Bold')
       .text(invoice.guest_name, 300, blockY + 14);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(invoice.guest_email || '', 300, blockY + 28);
    if (invoice.villa_name) {
      doc.text(`Villa: ${invoice.villa_name}`, 300, blockY + 40);
    }

    // ── Line items table ─────────────────────────────────────────────────────
    const tableTop = blockY + 80;
    const colDesc  = 50;
    const colQty   = 310;
    const colPrice = 370;
    const colTotal = 440;

    // Header row
    doc.rect(50, tableTop, W, 22).fill('#f1f5f9');
    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
       .text('DESCRIPTION',    colDesc,  tableTop + 7)
       .text('QTY',            colQty,   tableTop + 7, { width: 50, align: 'right' })
       .text('UNIT PRICE',     colPrice, tableTop + 7, { width: 60, align: 'right' })
       .text('TOTAL',          colTotal, tableTop + 7, { width: 55, align: 'right' });

    // Item rows
    let y = tableTop + 22;
    for (const item of lineItems) {
      if (y > 680) { doc.addPage(); y = 50; }
      const rowTotal = (parseFloat(item.quantity || 1) * parseFloat(item.unit_price || 0));
      const label    = item.description || item.name || 'Service';
      doc.fillColor(DARK).fontSize(9).font('Helvetica')
         .text(label,                        colDesc,  y + 6, { width: 250 })
         .text(String(item.quantity || 1),   colQty,   y + 6, { width: 50, align: 'right' })
         .text(fmtMoney(item.unit_price, invoice.currency), colPrice, y + 6, { width: 60, align: 'right' })
         .text(fmtMoney(rowTotal, invoice.currency),        colTotal, y + 6, { width: 55, align: 'right' });
      doc.moveTo(50, y + 24).lineTo(545, y + 24).stroke(BORDER);
      y += 28;
    }

    // ── Totals box ───────────────────────────────────────────────────────────
    y += 10;
    const subtotal   = parseFloat(invoice.subtotal  || 0);
    const taxRate    = parseFloat(invoice.tax_rate   || 0);
    const taxAmount  = parseFloat(invoice.tax_amount || 0);
    const total      = parseFloat(invoice.total      || subtotal + taxAmount);
    const cur        = invoice.currency || 'USD';

    doc.rect(350, y, 195, taxRate > 0 ? 70 : 48).fill('#f8fafc');
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text('Subtotal:',              360, y + 10)
       .text(fmtMoney(subtotal, cur),  460, y + 10, { width: 75, align: 'right' });

    if (taxRate > 0) {
      doc.text(`Tax (${taxRate}%):`,       360, y + 28)
         .text(fmtMoney(taxAmount, cur),   460, y + 28, { width: 75, align: 'right' });
    }

    const totalY = taxRate > 0 ? y + 46 : y + 28;
    doc.rect(350, totalY, 195, 22).fill(GREEN);
    doc.fillColor('#fff').fontSize(10).font('Helvetica-Bold')
       .text('TOTAL DUE:',            360, totalY + 6)
       .text(fmtMoney(total, cur),    460, totalY + 6, { width: 75, align: 'right' });

    // ── Payment & notes ──────────────────────────────────────────────────────
    if (invoice.notes) {
      y += taxRate > 0 ? 90 : 70;
      doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text('NOTES', 50, y);
      doc.fillColor(DARK).fontSize(9).font('Helvetica').text(invoice.notes, 50, y + 14, { width: 280 });
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    doc.rect(50, 760, W, 1).fill(BORDER);
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
       .text('Thank you for choosing ' + (ownerProfile.company || 'The Villa Managers') + '!', 50, 770, { width: W, align: 'center' });

    doc.end();
    stream.on('finish', () => resolve({ filePath, fileName }));
    stream.on('error',  reject);
  });
}

// ─── Sheets Auto-Logger (matches your "Transaksi" tab format exactly) ────────
// Your sheet columns: DATE | TRANSACTIONS | CATEGORY | TOTAL | ACCOUNT | NOTE
async function logTransactionToSheets(spreadsheetId, transaction) {
  if (!spreadsheetId) return { skipped: true, reason: 'No spreadsheet ID configured' };
  try {
    const sheets = require('./sheets');

    // Map to exact Transaksi tab column order
    const row = [
      transaction.date || new Date().toISOString().slice(0, 10), // DATE
      transaction.type === 'income' ? 'Income' : 'Expense',      // TRANSACTIONS
      transaction.category || transaction.villa_name || '',       // CATEGORY (villa or expense type)
      parseFloat(transaction.amount) || 0,                        // TOTAL
      transaction.account || transaction.payment_method || '',    // ACCOUNT (BCA, WISE, CASH, etc.)
      transaction.note || transaction.description || ''           // NOTE
    ];

    await sheets.appendSheet(spreadsheetId, 'Transaksi', row);
    return { logged: true, spreadsheetId, tab: 'Transaksi' };
  } catch (err) {
    return { logged: false, error: err.message };
  }
}

// No need to write headers — your Transaksi tab already has them
async function ensureTransactionSheetHeaders(spreadsheetId) {
  // Headers are already in place in your existing Transaksi sheet
  return;
}

// ─── Rekening (Bank Account) Sheet Updater ────────────────────────────────────
// Matches your "Rekening" tab: ACCOUNT | CURRENT BALANCE | OPENING BALANCE |
//   TOTAL DEPOSIT | TOTAL WITHDRAWALS | BALANCE +/- | TERAKHIR DIPERIKSA
async function updateRekeningSheet(spreadsheetId, accounts) {
  if (!spreadsheetId || !accounts?.length) return { skipped: true };
  try {
    const sheets = require('./sheets');
    const today  = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

    // Read current Rekening data to find which rows to update
    const data = await sheets.readSheet(spreadsheetId, 'Rekening');
    const rows = data || [];

    for (const acct of accounts) {
      // Find the row with this account name (search col A or B)
      const rowIdx = rows.findIndex(r =>
        r.some(cell => String(cell).trim().toUpperCase() === acct.name.toUpperCase())
      );
      if (rowIdx >= 0) {
        // Update CURRENT BALANCE (col C) and TERAKHIR DIPERIKSA (last col ~H)
        // Row is 1-indexed in Sheets, +1 for header
        const sheetRow = rowIdx + 1;
        await sheets.writeSheet(spreadsheetId, `Rekening!C${sheetRow}`, [[parseFloat(acct.balance)]]);
        await sheets.writeSheet(spreadsheetId, `Rekening!H${sheetRow}`, [[today]]);
      }
    }
    return { updated: true, accountsUpdated: accounts.length };
  } catch (err) {
    return { updated: false, error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtMoney(amount, currency = 'USD') {
  const n = parseFloat(amount) || 0;
  const symbols = { USD: '$', IDR: 'Rp ', EUR: '€', AUD: 'A$', GBP: '£' };
  const sym = symbols[currency] || (currency + ' ');
  return sym + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calcLineItems(lineItems) {
  const subtotal = lineItems.reduce((s, item) => {
    return s + (parseFloat(item.quantity || 1) * parseFloat(item.unit_price || 0));
  }, 0);
  return subtotal;
}

module.exports = {
  generateInvoicePDF,
  logTransactionToSheets,
  ensureTransactionSheetHeaders,
  fmtMoney,
  calcLineItems,
  INVOICE_DIR
};
