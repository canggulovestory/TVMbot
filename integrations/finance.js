// integrations/finance.js
// ═════════════════════════════════════════════════════════════════════════════
// DUAL-SHEET FINANCIAL INTEGRATION
//
// STAFF SHEET (shared with team) — detailed operational data
//   ID: 1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw
//   Tabs: Income, Variable Expenses, Recurring Expenses
//
// INTERNAL SHEET (owner only) — personal budget planner (EzyPlanners template)
//   ID: 1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ
//   Writable tabs ONLY: Transactions (Variable), Transactions (Recurring)
//   ⚠️ DO NOT write to: Monthly tabs, Dashboards, Payment Tracker,
//       Expense/Income Distribution, 50/30/20, Debt Calculator, Savings,
//       Net Worth, Annual Report — these are ALL auto-calculated!
//
// RULES:
//   1. Income  → write to BOTH sheets
//   2. Expenses → write to Staff Sheet ONLY (detailed)
//   3. Expense summary → bot calculates monthly totals per villa from
//      Staff Sheet and writes summary to Internal Sheet
// ═════════════════════════════════════════════════════════════════════════════

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// ─── SHEET IDs ────────────────────────────────────────────────────────────────
const STAFF_SHEET    = '1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw';
const INTERNAL_SHEET = '1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ';

// ─── STAFF SHEET TABS ─────────────────────────────────────────────────────────
const TAB_INCOME    = 'Income';
const TAB_RECURRING = 'Recurring Expenses';
const TAB_VARIABLE  = 'Variable Expenses';
const HEADER_ROW    = 7;
const DATA_START    = 8;

// ─── INTERNAL SHEET TABS & COLUMN MAP ─────────────────────────────────────────
// Transactions (Variable) — headers at row 6, data from row 7
//   J(9):  DESCRIPTION
//   R(17): AMOUNT value  (Q(16) = currency prefix "$" auto)
//   U(20): DATE
//   Y(24): SPENDER
//   AS(44): CATEGORY  ← critical for monthly tab auto-calc
//
// Transactions (Recurring) — headers at row 8, data from row 9
//   INCOME section (left side):
//     K(10):  DESCRIPTION
//     R(17):  FREQUENCY
//     W(22):  AMOUNT value  (V(21) = "Rp" auto)
//     Z(25):  DATE
//     AF(31): MEMBER
const INT_TAB_VARIABLE  = 'Transactions (Variable)';
const INT_TAB_RECURRING = 'Transactions (Recurring)';
const INT_VAR_DATA_START = 7;
const INT_REC_DATA_START = 9;  // income section rows 9-11

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function getAuth() {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'integrations.json'), 'utf8'
  ));
  const c = config.sheets;
  const auth = new google.auth.OAuth2(c.client_id, c.client_secret);
  auth.setCredentials({ refresh_token: c.refresh_token });
  return auth;
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatDate(input) {
  if (!input) {
    const n = new Date();
    return `${String(n.getDate()).padStart(2,'0')}/${String(n.getMonth()+1).padStart(2,'0')}/${n.getFullYear()}`;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d)) return String(input);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

// ISO format for Internal Sheet (YYYY-MM-DD)
function formatDateISO(input) {
  if (!input) {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d)) return String(input);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function findEmptyRow(sheets, sheetId, tab, col = 'B', startRow = DATA_START) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!${col}${startRow}:${col}`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || rows[i][0].toString().trim() === '' || rows[i][0] === 'FALSE') {
      return startRow + i;
    }
  }
  return startRow + rows.length;
}

// ─── SAFE ROW FINDER FOR INCOME TAB ─────────────────────────────────────────
// The Income tab has B=FALSE pre-filled in ALL rows (template default).
// We CANNOT use column B to find empty rows — it always returns row 8!
// Instead, check column D (DATE) — only rows with actual data have a date.
// Also: some rows may have hidden formulas (e.g. N157 has SUMPRODUCT).
// We must verify the target row has no formulas in our write columns.
async function findEmptyIncomeRow(sheets) {
  // 1. Check column D (DATE) to find first row without a date value
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_INCOME}'!D${DATA_START}:D`,
  });
  const rows = res.data.values || [];
  let candidate = DATA_START + rows.length; // default: after all data

  for (let i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || rows[i][0].toString().trim() === '') {
      candidate = DATA_START + i;
      break;
    }
  }

  // 2. FORMULA SAFETY CHECK — verify no formulas exist in our write columns
  //    at the candidate row. If found, skip to next row (up to 10 attempts).
  for (let attempt = 0; attempt < 10; attempt++) {
    const row = candidate + attempt;
    const hasFormula = await checkRowForFormulas(sheets, STAFF_SHEET, TAB_INCOME, row,
      ['B','C','D','E','F','G','H','I','K','L','N']  // all columns we write to
    );
    if (!hasFormula) {
      return row;
    }
    console.log(`⚠️ Income row ${row} has formula in write column — skipping`);
  }

  // If all 10 attempts had formulas, return the last one + 1
  return candidate + 10;
}

// ─── FORMULA SAFETY CHECK ────────────────────────────────────────────────────
// Checks if ANY of the specified columns in a row contain a formula.
// Uses spreadsheets.get with includeGridData to inspect userEnteredValue.
// Returns true if formula found, false if safe to write.
async function checkRowForFormulas(sheets, sheetId, tab, row, columns) {
  const ranges = columns.map(col => `'${tab}'!${col}${row}`);
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      ranges,
      includeGridData: true,
      fields: 'sheets.data.rowData.values(userEnteredValue)'
    });

    for (const sheet of (res.data.sheets || [])) {
      for (const data of (sheet.data || [])) {
        const rowData = data.rowData;
        if (!rowData || !rowData[0] || !rowData[0].values) continue;
        for (const cell of rowData[0].values) {
          if (cell && cell.userEnteredValue && cell.userEnteredValue.formulaValue) {
            return true; // Formula found!
          }
        }
      }
    }
  } catch (e) {
    console.error(`Formula check error for row ${row}:`, e.message);
  }
  return false; // No formulas — safe to write
}

// Find empty row in Internal Sheet Transactions (Variable)
// Uses J column (DESCRIPTION) starting from row 7
// Also verifies candidate rows have no formulas in bot write columns
async function findInternalVarRow(sheets) {
  // Read B, C, and J columns to find truly empty data rows
  // Must skip rows with labels in B (e.g. "Monthly Transactions")
  // or totals in C (e.g. "Total Paid", "Total Outstanding")
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: INTERNAL_SHEET,
    range: `'${INT_TAB_VARIABLE}'!B${INT_VAR_DATA_START}:J39`,
  });
  const rows = res.data.values || [];
  const candidates = [];

  for (let i = 0; i < rows.length; i++) {
    const b = (rows[i] && rows[i][0]) ? rows[i][0].toString().trim() : '';
    const c = (rows[i] && rows[i][1]) ? rows[i][1].toString().trim() : '';
    const j = (rows[i] && rows[i][8]) ? rows[i][8].toString().trim() : '';
    // Skip if B has a label (section header) or C has content (total/formula)
    if (b && b !== '' && !b.startsWith('Rp')) continue;
    if (c && c !== '' && !c.startsWith('Rp') && c !== '0' && c !== '0.00') continue;
    // Only use row if J (DESCRIPTION) is empty
    if (!j || j === '') {
      candidates.push(INT_VAR_DATA_START + i);
    }
  }

  // Formula safety check — verify candidate row has no formulas in write columns
  for (const row of candidates) {
    const hasFormula = await checkRowForFormulas(sheets, INTERNAL_SHEET, INT_TAB_VARIABLE, row,
      ['J', 'R', 'U', 'Y', 'AS']  // bot write columns
    );
    if (!hasFormula) {
      return row;
    }
    console.log(`⚠️ Internal Var row ${row} has formula in write column — skipping`);
  }

  return INT_VAR_DATA_START + rows.length;
}

// Find empty row in Internal Sheet Transactions (Recurring) INCOME section
// K column rows 9-11 only (limited rows in the template)
async function findInternalRecIncomeRow(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: INTERNAL_SHEET,
    range: `'${INT_TAB_RECURRING}'!K${INT_REC_DATA_START}:K11`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || rows[i][0].toString().trim() === '') {
      return INT_REC_DATA_START + i;
    }
  }
  return null; // All 3 income rows full
}


// ═══════════════════════════════════════════════════════════════════════════════
// STAFF SHEET FUNCTIONS (existing — unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── LOG VARIABLE EXPENSE → Staff Sheet only ──────────────────────────────────
async function logVariableExpense({ date, property = '', category = 'EXPENSES', description, amount, notes = '' }) {
  if (!description) throw new Error('description is required');
  if (amount === undefined || amount === null) throw new Error('amount is required');
  const sheets = getSheets();
  const row = await findEmptyRow(sheets, STAFF_SHEET, TAB_VARIABLE);
  await sheets.spreadsheets.values.update({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_VARIABLE}'!B${row}:G${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[
      formatDate(date), property, category.toUpperCase(),
      description, Number(amount), notes
    ]] }
  });
  return { success: true, row, message: `Logged expense: ${description} — Rp ${Number(amount).toLocaleString('id-ID')} [${category}] on ${formatDate(date)}` };
}

// ─── LOG RECURRING EXPENSE → Staff Sheet only ─────────────────────────────────
async function logRecurringExpense({ property = '', category, frequency = 'MONTHLY', startDate, endDate = '', amount, notes = '' }) {
  if (!category) throw new Error('category is required');
  if (amount === undefined) throw new Error('amount is required');
  const sheets = getSheets();
  const row = await findEmptyRow(sheets, STAFF_SHEET, TAB_RECURRING);
  await sheets.spreadsheets.values.update({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_RECURRING}'!B${row}:H${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[
      property, category.toUpperCase(), frequency.toUpperCase(),
      startDate ? formatDate(startDate) : formatDate(),
      endDate ? formatDate(endDate) : '', Number(amount), notes
    ]] }
  });
  return { success: true, row, message: `Logged recurring: ${category} — Rp ${Number(amount).toLocaleString('id-ID')} ${frequency}` };
}

// ─── LOG INCOME → BOTH SHEETS ─────────────────────────────────────────────────
async function logIncome({ cancelled = false, category = 'Rental', date, guestName = '', numGuests = '', property = '', checkIn = '', checkOut = '', nights = '', rentalIncome, otherFees = 0, notes = '' }) {
  if (rentalIncome === undefined) throw new Error('rentalIncome is required');
  const sheets = getSheets();
  const total = Number(rentalIncome) + Number(otherFees || 0);

  // 1) Write to Staff Sheet Income tab
  // ⚠️ J (NIGHTS) has formula =DAYS(I,H) — DO NOT write
  // ⚠️ M (TOTAL) has formula =K+L — DO NOT write
  // ⚠️ N157 has SUMPRODUCT formula — must formula-check before writing
  // Write B-I (skip J), then K-L (skip M), then N
  // Uses findEmptyIncomeRow (checks col D, not B) + formula safety check
  const staffRow = await findEmptyIncomeRow(sheets);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: STAFF_SHEET,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `'${TAB_INCOME}'!B${staffRow}:I${staffRow}`, values: [[
          cancelled ? 'TRUE' : 'FALSE', category, formatDate(date),
          guestName, numGuests || '', property,
          checkIn ? formatDate(checkIn) : '', checkOut ? formatDate(checkOut) : ''
        ]] },
        // Skip J (NIGHTS) — formula auto-calculates from H & I
        { range: `'${TAB_INCOME}'!K${staffRow}:L${staffRow}`, values: [[
          Number(rentalIncome), Number(otherFees || 0)
        ]] },
        // Skip M (TOTAL) — formula auto-calculates from K + L
        { range: `'${TAB_INCOME}'!N${staffRow}`, values: [[notes]] }
      ]
    }
  });

  // 2) Write to Internal Sheet → Transactions (Variable) as income entry
  //    J=DESCRIPTION  R=AMOUNT  U=DATE  Y=SPENDER  AS=CATEGORY
  let internalMsg = '';
  try {
    const intRow = await findInternalVarRow(sheets);
    if (intRow <= 39) { // Template has rows up to ~39
      const desc = property ? `${property} - ${guestName || category}` : `${guestName || category} Income`;
      // Write ONLY to safe cells — avoid formula cells (C, Q, AY)
      // Safe cells: J=DESCRIPTION, R=AMOUNT, U=DATE, Y=SPENDER, AS=CATEGORY
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: INTERNAL_SHEET,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `'${INT_TAB_VARIABLE}'!J${intRow}`, values: [[desc]] },
            { range: `'${INT_TAB_VARIABLE}'!R${intRow}`, values: [[total]] },
            { range: `'${INT_TAB_VARIABLE}'!U${intRow}`, values: [[formatDateISO(date)]] },
            { range: `'${INT_TAB_VARIABLE}'!Y${intRow}`, values: [['TVMbot']] },
            { range: `'${INT_TAB_VARIABLE}'!AS${intRow}`, values: [['Income']] },
          ]
        }
      });
      internalMsg = ` | Also logged to Internal Sheet row ${intRow}`;
    } else {
      internalMsg = ' | Internal Sheet Transactions (Variable) is full';
    }
  } catch (e) {
    internalMsg = ` | Internal Sheet sync failed: ${e.message}`;
  }

  return {
    success: true,
    row: staffRow,
    message: `Logged income: ${property || 'villa'} — Rp ${total.toLocaleString('id-ID')} on ${formatDate(date)}${internalMsg}`
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// READ FUNCTIONS (from Staff Sheet)
// ═══════════════════════════════════════════════════════════════════════════════

async function getRecentExpenses(limit = 10) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_VARIABLE}'!B${DATA_START}:G`,
  });
  const rows = (res.data.values || []).filter(r => r && r[0] && r[0] !== 'FALSE' && r[4]);
  return rows.slice(-limit).map(r => ({
    date: r[0] || '', property: r[1] || '', category: r[2] || '',
    description: r[3] || '', amount: r[4] || '', notes: r[5] || ''
  }));
}

async function getUpcomingRecurring(daysAhead = 30) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_RECURRING}'!B${DATA_START}:H`,
  });
  const rows = (res.data.values || []).filter(r => r && r[0] !== 'FALSE' && r[5]);
  const now = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 86400000);
  return rows
    .map(r => {
      const parts = (r[3] || '').split('/');
      const d = parts.length === 3 ? new Date(`${parts[2]}-${parts[1]}-${parts[0]}`) : new Date(r[3]);
      return { property: r[0], category: r[1], frequency: r[2], date: r[3], endDate: r[4], amount: r[5], notes: r[6], dueDate: d };
    })
    .filter(r => !isNaN(r.dueDate) && r.dueDate >= now && r.dueDate <= cutoff)
    .sort((a, b) => a.dueDate - b.dueDate);
}

async function getIncomeSummary(limit = 10) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_INCOME}'!B${DATA_START}:N`,
  });
  const rows = (res.data.values || []).filter(r => r && r[0] !== 'FALSE' && r[9]);
  return rows.slice(-limit).map(r => ({
    cancelled: r[0], category: r[1], date: r[2], guest: r[3],
    property: r[5], checkIn: r[6], checkOut: r[7], nights: r[8],
    rentalIncome: r[9], otherFees: r[10], total: r[11], notes: r[12]
  }));
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPENSE SUMMARY SYNC → Internal Sheet
// Reads Staff Sheet expenses, calculates monthly totals per villa,
// writes summary lines to Internal Sheet Transactions (Variable)
// ═══════════════════════════════════════════════════════════════════════════════

async function syncExpenseSummary({ month, year }) {
  if (!month || !year) throw new Error('month and year are required (e.g. month=3, year=2026)');
  const sheets = getSheets();
  const m = Number(month);
  const y = Number(year);
  const monthNames = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

  // 1) Read ALL variable expenses from Staff Sheet
  const varRes = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_VARIABLE}'!B${DATA_START}:G`,
  });
  const varRows = (varRes.data.values || []).filter(r => r && r[0] && r[4]);

  // 2) Read ALL recurring expenses
  const recRes = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_RECURRING}'!B${DATA_START}:H`,
  });
  const recRows = (recRes.data.values || []).filter(r => r && r[0] && r[5]);

  // 3) Filter variable expenses for the target month
  const villaExpenses = {};
  for (const r of varRows) {
    const parts = (r[0] || '').split('/');
    if (parts.length !== 3) continue;
    const eMonth = Number(parts[1]);
    const eYear = Number(parts[2]);
    if (eMonth !== m || eYear !== y) continue;
    const villa = r[1] || 'Unassigned';
    const amount = parseFloat(String(r[4]).replace(/[^\d.-]/g, '')) || 0;
    villaExpenses[villa] = (villaExpenses[villa] || 0) + amount;
  }

  // 4) Add recurring expenses that apply to this month
  for (const r of recRows) {
    const villa = r[0] || 'Unassigned';
    const freq = (r[2] || '').toUpperCase();
    const amount = parseFloat(String(r[5]).replace(/[^\d.-]/g, '')) || 0;
    const startParts = (r[3] || '').split('/');
    const endParts = (r[4] || '').split('/');
    if (startParts.length !== 3) continue;
    const startMonth = Number(startParts[1]);
    const startYear = Number(startParts[2]);
    const startDate = new Date(startYear, startMonth - 1, Number(startParts[0]));
    const targetDate = new Date(y, m - 1, 1);
    if (targetDate < startDate) continue; // hasn't started yet
    if (endParts.length === 3) {
      const endDate = new Date(Number(endParts[2]), Number(endParts[1]) - 1, Number(endParts[0]));
      if (targetDate > endDate) continue; // already ended
    }
    if (freq === 'MONTHLY' || freq === 'WEEKLY' || freq === 'BI-WEEKLY' || freq === 'QUARTERLY' || freq === 'ANNUALLY') {
      let multiplier = 1;
      if (freq === 'WEEKLY') multiplier = 4;
      if (freq === 'BI-WEEKLY') multiplier = 2;
      if (freq === 'QUARTERLY' && m % 3 !== startMonth % 3) continue;
      if (freq === 'ANNUALLY' && m !== startMonth) continue;
      villaExpenses[villa] = (villaExpenses[villa] || 0) + (amount * multiplier);
    }
  }

  if (Object.keys(villaExpenses).length === 0) {
    return { success: true, message: `No expenses found for ${monthNames[m]} ${y}` };
  }

  // 5) Write summaries to Internal Sheet Transactions (Variable)
  const results = [];
  const lastDay = new Date(y, m, 0).getDate();
  const summaryDate = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  for (const [villa, total] of Object.entries(villaExpenses).sort()) {
    const intRow = await findInternalVarRow(sheets);
    if (intRow > 39) {
      results.push(`⚠️ Internal Sheet full — could not write ${villa}`);
      break;
    }
    const desc = `${villa} - ${monthNames[m]} ${y} Expenses`;
    // Write ONLY to safe cells — avoid formula cells (C, Q, AY)
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: INTERNAL_SHEET,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `'${INT_TAB_VARIABLE}'!J${intRow}`, values: [[desc]] },
          { range: `'${INT_TAB_VARIABLE}'!R${intRow}`, values: [[total]] },
          { range: `'${INT_TAB_VARIABLE}'!U${intRow}`, values: [[summaryDate]] },
          { range: `'${INT_TAB_VARIABLE}'!Y${intRow}`, values: [['Auto-Summary']] },
          { range: `'${INT_TAB_VARIABLE}'!AS${intRow}`, values: [['Expense']] },
        ]
      }
    });
    results.push(`✓ ${villa}: Rp ${total.toLocaleString('id-ID')} → row ${intRow}`);
  }

  return {
    success: true,
    message: `Expense summary for ${monthNames[m]} ${y}:\n${results.join('\n')}`,
    data: villaExpenses
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// GET MONTHLY OVERVIEW — combined view for owner
// ═══════════════════════════════════════════════════════════════════════════════

async function getMonthlyOverview({ month, year }) {
  if (!month || !year) throw new Error('month and year required');
  const sheets = getSheets();
  const m = Number(month);
  const y = Number(year);
  const monthNames = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

  // Income from Staff Sheet
  const incRes = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_INCOME}'!B${DATA_START}:N`,
  });
  const incRows = (incRes.data.values || []).filter(r => {
    if (!r || !r[2]) return false;
    const parts = (r[2] || '').split('/');
    return parts.length === 3 && Number(parts[1]) === m && Number(parts[2]) === y;
  });
  let totalIncome = 0;
  const incomeByVilla = {};
  for (const r of incRows) {
    const villa = r[5] || 'Unknown';
    const total = parseFloat(String(r[11] || r[9]).replace(/[^\d.-]/g, '')) || 0;
    totalIncome += total;
    incomeByVilla[villa] = (incomeByVilla[villa] || 0) + total;
  }

  // Variable Expenses from Staff Sheet
  const varRes = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_SHEET,
    range: `'${TAB_VARIABLE}'!B${DATA_START}:G`,
  });
  let totalExpenses = 0;
  const expenseByVilla = {};
  for (const r of (varRes.data.values || [])) {
    if (!r || !r[0]) continue;
    const parts = (r[0] || '').split('/');
    if (parts.length !== 3 || Number(parts[1]) !== m || Number(parts[2]) !== y) continue;
    const villa = r[1] || 'Unassigned';
    const amount = parseFloat(String(r[4]).replace(/[^\d.-]/g, '')) || 0;
    totalExpenses += amount;
    expenseByVilla[villa] = (expenseByVilla[villa] || 0) + amount;
  }

  // Build response
  let summary = `📊 ${monthNames[m]} ${y} Overview\n\n`;
  summary += `💰 Total Income: Rp ${totalIncome.toLocaleString('id-ID')}\n`;
  for (const [v, a] of Object.entries(incomeByVilla)) {
    summary += `   ${v}: Rp ${a.toLocaleString('id-ID')}\n`;
  }
  summary += `\n💸 Total Expenses: Rp ${totalExpenses.toLocaleString('id-ID')}\n`;
  for (const [v, a] of Object.entries(expenseByVilla)) {
    summary += `   ${v}: Rp ${a.toLocaleString('id-ID')}\n`;
  }
  const profit = totalIncome - totalExpenses;
  summary += `\n${profit >= 0 ? '✅' : '⚠️'} Net: Rp ${profit.toLocaleString('id-ID')}`;

  return { success: true, message: summary, totalIncome, totalExpenses, profit };
}


module.exports = {
  logVariableExpense,
  logRecurringExpense,
  logIncome,
  getRecentExpenses,
  getUpcomingRecurring,
  getIncomeSummary,
  syncExpenseSummary,
  getMonthlyOverview,
  STAFF_SHEET,
  INTERNAL_SHEET,
  TAB_INCOME,
  TAB_RECURRING,
  TAB_VARIABLE,
};
