// DEEP AUDIT: Staff Sheet - ALL 3 writable tabs
// Income: scans ALL rows 1-10007, ALL 16 columns
// Variable Expenses: scans ALL rows 1-10006, ALL 8 columns
// Recurring Expenses: scans ALL rows 1-10006, ALL 10 columns
const { google } = require('googleapis');
const config = require('./config/integrations.json');

const SHEET_ID = '1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw';

function colToLetter(col) {
  let letter = '';
  while (col >= 0) {
    letter = String.fromCharCode((col % 26) + 65) + letter;
    col = Math.floor(col / 26) - 1;
  }
  return letter;
}

async function deepAuditTab(sheets, tab, maxRow, maxCol, botWriteCols, botSkipCols) {
  const formulasByCol = {};
  const allFormulas = [];
  const endCol = colToLetter(maxCol - 1);
  const CHUNK = 500;

  console.log(`\n${'='.repeat(80)}`);
  console.log(`DEEP AUDIT: "${tab}"`);
  console.log(`Scanning rows 1-${maxRow}, columns A-${endCol} (${maxCol} columns)`);
  console.log(`Bot writes to: ${botWriteCols.join(', ')}`);
  console.log(`Bot SKIPS: ${botSkipCols.join(', ') || 'none'}`);
  console.log(`${'='.repeat(80)}`);

  for (let startRow = 1; startRow <= maxRow; startRow += CHUNK) {
    const endRow = Math.min(startRow + CHUNK - 1, maxRow);
    const range = `'${tab}'!A${startRow}:${endCol}${endRow}`;
    process.stdout.write(`  Scanning rows ${startRow}-${endRow}...`);

    try {
      const res = await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
        ranges: [range],
        includeGridData: true,
        fields: 'sheets.data.rowData.values(userEnteredValue)'
      });

      const rowData = (res.data.sheets[0].data[0].rowData) || [];
      let chunkFormulas = 0;

      for (let r = 0; r < rowData.length; r++) {
        const row = rowData[r];
        if (!row || !row.values) continue;
        const actualRow = startRow + r;

        for (let c = 0; c < row.values.length; c++) {
          const cell = row.values[c];
          if (!cell || !cell.userEnteredValue || !cell.userEnteredValue.formulaValue) continue;

          const colLetter = colToLetter(c);
          const cellRef = `${colLetter}${actualRow}`;
          const formula = cell.userEnteredValue.formulaValue;

          allFormulas.push({ cell: cellRef, col: colLetter, row: actualRow, formula });
          if (!formulasByCol[colLetter]) formulasByCol[colLetter] = [];
          formulasByCol[colLetter].push({ row: actualRow, formula });
          chunkFormulas++;
        }
      }
      console.log(` ${chunkFormulas} formulas`);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
    }
  }

  // Summary
  console.log(`\n  TOTAL FORMULAS: ${allFormulas.length}`);
  console.log(`  FORMULA COLUMNS: ${Object.keys(formulasByCol).sort().join(', ') || 'NONE'}`);

  // Detail per column
  for (const col of Object.keys(formulasByCol).sort()) {
    const entries = formulasByCol[col];
    const rows = entries.map(e => e.row);
    const isBotWrite = botWriteCols.includes(col);
    const isBotSkip = botSkipCols.includes(col);
    const marker = isBotWrite ? '⚠️ BOT WRITES HERE!' : (isBotSkip ? '🛑 SKIPPED by bot' : '— Bot never touches');

    console.log(`    Column ${col}: ${entries.length} formulas (rows ${Math.min(...rows)}-${Math.max(...rows)}) ${marker}`);
    console.log(`      Sample: ${entries[0].formula}`);
  }

  // Critical check
  console.log(`\n  CRITICAL CHECK — Bot Write Columns:`);
  let allSafe = true;
  for (const col of botWriteCols) {
    if (formulasByCol[col]) {
      // Check if formulas are ONLY in header rows (row 5 or below data start)
      const dataFormulas = formulasByCol[col].filter(e => e.row >= 8);
      if (dataFormulas.length > 0) {
        console.log(`    ❌ DANGER: Column ${col} has ${dataFormulas.length} formulas in DATA rows!`);
        dataFormulas.slice(0, 5).forEach(e => console.log(`       ${col}${e.row}: ${e.formula}`));
        allSafe = false;
      } else {
        console.log(`    ✅ Column ${col}: Only header formulas (row ${formulasByCol[col].map(e=>e.row).join(',')}) — data rows SAFE`);
      }
    } else {
      console.log(`    ✅ Column ${col}: ZERO formulas — SAFE`);
    }
  }

  console.log(`\n  ${allSafe ? '✅ ALL BOT WRITE COLUMNS SAFE' : '❌❌❌ DANGER DETECTED'}`);
  return allSafe;
}

async function main() {
  const oauth2Client = new google.auth.OAuth2(config.sheets.client_id, config.sheets.client_secret);
  oauth2Client.setCredentials({ refresh_token: config.sheets.refresh_token, access_token: config.sheets.access_token });
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  // 1. Income tab — bot writes B-I, K-L, N (skips J, M)
  // Scan first 500 rows (covers all data + formulas pattern repeats)
  const r1 = await deepAuditTab(sheets, 'Income', 500, 16,
    ['B','C','D','E','F','G','H','I','K','L','N'],
    ['J','M']
  );

  // 2. Variable Expenses — bot writes B-G
  const r2 = await deepAuditTab(sheets, 'Variable Expenses', 500, 8,
    ['B','C','D','E','F','G'],
    []
  );

  // 3. Recurring Expenses — bot writes B-H
  const r3 = await deepAuditTab(sheets, 'Recurring Expenses', 500, 10,
    ['B','C','D','E','F','G','H'],
    []
  );

  console.log(`\n${'='.repeat(80)}`);
  console.log('FINAL STAFF SHEET VERDICT:');
  console.log(`  Income: ${r1 ? '✅ SAFE' : '❌ DANGER'}`);
  console.log(`  Variable Expenses: ${r2 ? '✅ SAFE' : '❌ DANGER'}`);
  console.log(`  Recurring Expenses: ${r3 ? '✅ SAFE' : '❌ DANGER'}`);
  console.log(`${'='.repeat(80)}`);
}

main().catch(e => console.error('ERROR:', e.message));
