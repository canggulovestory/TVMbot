// Deep audit of Internal Sheet - ALL tabs, ALL cells with formulas
const { google } = require('googleapis');
const config = require('./config/integrations.json');

async function audit() {
  const oauth2Client = new google.auth.OAuth2(
    config.sheets.client_id,
    config.sheets.client_secret
  );
  oauth2Client.setCredentials({
    refresh_token: config.sheets.refresh_token,
    access_token: config.sheets.access_token
  });

  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const SHEET_ID = '1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ';

  // Get all sheet names
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabNames = meta.data.sheets.map(s => s.properties.title);
  console.log('=== INTERNAL SHEET - ALL TABS ===');
  console.log(tabNames.join('\n'));

  for (const tab of tabNames) {
    const sheetMeta = meta.data.sheets.find(s => s.properties.title === tab);
    const maxRow = sheetMeta.properties.gridProperties.rowCount;
    const maxCol = sheetMeta.properties.gridProperties.columnCount;
    const scanRows = Math.min(maxRow, 100);
    const scanCols = Math.min(maxCol, 78); // up to BZ

    console.log(`\n--- TAB: "${tab}" (${maxRow}r x ${maxCol}c, scanning ${scanRows}r x ${scanCols}c) ---`);

    const endCol = colToLetter(scanCols - 1);
    const range = `'${tab}'!A1:${endCol}${scanRows}`;

    const res = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      ranges: [range],
      includeGridData: true,
      fields: 'sheets.data.rowData.values(userEnteredValue)'
    });

    const rowData = res.data.sheets[0].data[0].rowData || [];
    const formulas = [];

    for (let r = 0; r < rowData.length; r++) {
      const row = rowData[r];
      if (!row.values) continue;
      for (let c = 0; c < row.values.length; c++) {
        const cell = row.values[c];
        if (!cell || !cell.userEnteredValue) continue;
        if (cell.userEnteredValue.formulaValue) {
          formulas.push({
            cell: `${colToLetter(c)}${r + 1}`,
            formula: cell.userEnteredValue.formulaValue
          });
        }
      }
    }

    if (formulas.length > 0) {
      console.log(`  FORMULAS (${formulas.length}):`);
      formulas.forEach(f => console.log(`    ${f.cell}: ${f.formula}`));
    } else {
      console.log('  NO formulas');
    }
  }
}

function colToLetter(col) {
  let letter = '';
  while (col >= 0) {
    letter = String.fromCharCode((col % 26) + 65) + letter;
    col = Math.floor(col / 26) - 1;
  }
  return letter;
}

audit().catch(e => console.error('ERROR:', e.message));
