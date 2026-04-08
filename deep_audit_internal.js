// DEEP AUDIT: Internal Sheet - Transactions (Variable)
// Scans ALL rows (7-4000) in CHUNKS, ALL columns (A-BO = 67 cols)
// Reports EVERY formula cell found
const { google } = require('googleapis');
const config = require('./config/integrations.json');

const SHEET_ID = '1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ';
const TAB = 'Transactions (Variable)';

function colToLetter(col) {
  let letter = '';
  while (col >= 0) {
    letter = String.fromCharCode((col % 26) + 65) + letter;
    col = Math.floor(col / 26) - 1;
  }
  return letter;
}

async function deepAudit() {
  const oauth2Client = new google.auth.OAuth2(config.sheets.client_id, config.sheets.client_secret);
  oauth2Client.setCredentials({ refresh_token: config.sheets.refresh_token, access_token: config.sheets.access_token });
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  // Track ALL formulas by column
  const formulasByCol = {};  // { "AY": [{row, formula}] }
  const allFormulas = [];     // [{cell, formula}]

  // BOT WRITE COLUMNS - the ones we MUST verify are formula-free
  const BOT_COLUMNS = ['J', 'R', 'U', 'Y', 'AS'];
  const botColIndexes = [9, 17, 20, 24, 44]; // 0-based

  // Scan in chunks of 500 rows to avoid API limits
  const CHUNK = 500;
  const MAX_ROW = 4000;
  const MAX_COL = 66; // column BO (index 66)
  const endCol = colToLetter(MAX_COL);

  console.log(`=== DEEP AUDIT: "${TAB}" ===`);
  console.log(`Scanning rows 1-${MAX_ROW}, columns A-${endCol} (${MAX_COL + 1} columns)`);
  console.log(`Bot write columns to verify: ${BOT_COLUMNS.join(', ')}\n`);

  for (let startRow = 1; startRow <= MAX_ROW; startRow += CHUNK) {
    const endRow = Math.min(startRow + CHUNK - 1, MAX_ROW);
    const range = `'${TAB}'!A${startRow}:${endCol}${endRow}`;

    process.stdout.write(`  Scanning rows ${startRow}-${endRow}...`);

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

    console.log(` ${chunkFormulas} formulas found`);
  }

  // === SUMMARY ===
  console.log(`\n${'='.repeat(80)}`);
  console.log(`TOTAL FORMULAS FOUND: ${allFormulas.length}`);
  console.log(`FORMULA COLUMNS: ${Object.keys(formulasByCol).sort().join(', ')}`);
  console.log(`${'='.repeat(80)}\n`);

  // === DETAIL PER COLUMN ===
  const sortedCols = Object.keys(formulasByCol).sort((a, b) => {
    const aIdx = a.length === 1 ? a.charCodeAt(0) - 65 : (a.charCodeAt(0) - 64) * 26 + a.charCodeAt(1) - 65;
    const bIdx = b.length === 1 ? b.charCodeAt(0) - 65 : (b.charCodeAt(0) - 64) * 26 + b.charCodeAt(1) - 65;
    return aIdx - bIdx;
  });

  for (const col of sortedCols) {
    const entries = formulasByCol[col];
    const rows = entries.map(e => e.row);
    const minRow = Math.min(...rows);
    const maxRow = Math.max(...rows);
    const sampleFormula = entries[0].formula;

    const isBotCol = BOT_COLUMNS.includes(col);
    const marker = isBotCol ? '⚠️ BOT WRITES HERE' : '✓ Bot never touches';

    console.log(`  Column ${col} (${entries.length} formulas, rows ${minRow}-${maxRow}) — ${marker}`);
    console.log(`    Sample: ${sampleFormula}`);
    if (entries.length <= 5) {
      entries.forEach(e => console.log(`    ${col}${e.row}: ${e.formula}`));
    }
    console.log('');
  }

  // === CRITICAL CHECK: Bot write columns ===
  console.log(`${'='.repeat(80)}`);
  console.log('CRITICAL CHECK — BOT WRITE COLUMNS:');
  console.log(`${'='.repeat(80)}`);

  let allSafe = true;
  for (const col of BOT_COLUMNS) {
    if (formulasByCol[col]) {
      console.log(`  ❌ DANGER: Column ${col} has ${formulasByCol[col].length} formulas!`);
      formulasByCol[col].forEach(e => console.log(`     ${col}${e.row}: ${e.formula}`));
      allSafe = false;
    } else {
      console.log(`  ✅ Column ${col}: ZERO formulas — SAFE to write`);
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  if (allSafe) {
    console.log('VERDICT: ALL BOT WRITE COLUMNS ARE SAFE — ZERO FORMULAS');
  } else {
    console.log('VERDICT: ❌❌❌ DANGER — FORMULAS FOUND IN BOT WRITE COLUMNS!');
  }
  console.log(`${'='.repeat(80)}`);
}

deepAudit().catch(e => console.error('ERROR:', e.message));
