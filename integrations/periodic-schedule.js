// integrations/periodic-schedule.js — Villa Periodic Maintenance Schedule Scanner
// Reads per-villa tabs, parses due dates, syncs to Google Calendar, sends reminders

const sheets = require('./sheets');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const MAINTENANCE_SID = '1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE';
const CONFIG_PATH = path.join(__dirname, '../config/integrations.json');

// ─── FORMULA SAFETY CHECK ────────────────────────────────────────────────────
// Checks if a specific cell contains a formula. Uses spreadsheets.get with
// includeGridData to inspect userEnteredValue. Returns true if formula found.
async function checkCellForFormula(sheetId, tab, col, row) {
  try {
    const { google } = require('googleapis');
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const s = config.sheets || {};
    const auth = new google.auth.OAuth2(s.client_id, s.client_secret);
    auth.setCredentials({ refresh_token: s.refresh_token });
    const sheetsApi = google.sheets({ version: 'v4', auth });

    const range = "'" + tab + "'!" + col + row;
    const res = await sheetsApi.spreadsheets.get({
      spreadsheetId: sheetId,
      ranges: [range],
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
    console.error('[Schedule] Formula check error for ' + col + row + ':', e.message);
  }
  return false; // No formula — safe to write
}

// Villa tabs with standard columns: B=CATEGORY, C=ITEM, D=TASK, E=LAST_TIME, F=DUE_DATE, G=STATUS, H=COST, I=PIC
const VILLA_TABS = [
  { name: 'VILLA ANN', villa: 'ANN', picCol: 8 },
  { name: 'VILLA DIANE', villa: 'DIANE', picCol: 8 },
  { name: 'VILLA LUNA', villa: 'LUNA', picCol: 8 },
  { name: 'VILLA LOURINKA', villa: 'LOURINKA', picCol: 8 },
  { name: 'VILLA ALYSAA', villa: 'ALYSAA', picCol: 8 },
  { name: 'VILLA NISSA', villa: 'NISSA', picCol: 8 },
  { name: 'VILLA LYSA', villa: 'LYSA', picCol: 8 },
  { name: 'VILLA LIAN', villa: 'LIAN', picCol: 8 },
  { name: 'VILLA INDUSTRIAL', villa: 'INDUSTRIAL', picCol: 8 },
  { name: 'VILLA LYMA', villa: 'LYMA', picCol: 8 }
];

// Ocean Drive has different columns: I=VILLA1, J=VILLA2, K=VILLA3 (checkboxes)
const OCEAN_DRIVE_TAB = { name: 'OCEAN DRIVE', villa: 'OCEAN DRIVE' };

// Category → days until next due
const CATEGORY_DAYS = {
  'bi-weekly': 14,
  'weekly': 7,
  'monthly': 30,
  'quarterly': 90,
  'semi-annual': 180,
  'annual': 365
};

// Parse various date formats: "2/10/2026", "January 27, 2026", "12/16/2025", etc.
function parseDate(str) {
  if (!str || str.trim() === '') return null;
  const s = str.trim();

  // Try "Month Day, Year" format: "January 27, 2026"
  const d1 = new Date(s);
  if (!isNaN(d1.getTime()) && d1.getFullYear() > 2000) return d1;

  // Try "M/D/YYYY" format: "2/10/2026"
  const parts = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (parts) {
    const d2 = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (!isNaN(d2.getTime())) return d2;
  }

  return null;
}

function formatDateForSheet(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = date.getFullYear();
  return m + '/' + d + '/' + y;
}

function getCalendarAuth() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const cal = config.google_calendar || {};
  const auth = new google.auth.OAuth2(
    cal.client_id || '',
    cal.client_secret || '',
    'https://developers.google.com/oauthplayground'
  );
  auth.setCredentials({
    access_token: cal.access_token,
    refresh_token: cal.refresh_token
  });
  auth.on('tokens', (tokens) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (tokens.access_token) {
        for (const svc of ['sheets', 'gmail', 'docs', 'drive', 'google_calendar']) {
          if (cfg[svc]) cfg[svc].access_token = tokens.access_token;
        }
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    } catch (e) {}
  });
  return { auth, calendarId: cal.calendar_id || 'primary', timezone: cal.timezone || 'Asia/Makassar' };
}

// Read all villa periodic schedules
async function getAllSchedules() {
  const allItems = [];

  // Standard villa tabs
  for (const tab of VILLA_TABS) {
    try {
      const data = await sheets.readSheet(MAINTENANCE_SID, tab.name + '!A1:K30');
      if (!data || data.length <= 4) continue; // rows 0-3 are empty/header

      for (let i = 4; i < data.length; i++) {
        const row = data[i];
        if (!row || row.length < 3) continue;
        const category = (row[1] || '').trim();
        const item = (row[2] || '').trim();
        if (!category || !item) continue;

        allItems.push({
          tab: tab.name,
          villa: tab.villa,
          row: i + 1,
          category: category,
          item: item,
          task: (row[3] || '').trim(),
          lastTime: parseDate(row[4]),
          lastTimeRaw: (row[4] || '').trim(),
          dueDate: parseDate(row[5]),
          dueDateRaw: (row[5] || '').trim(),
          status: (row[6] || '').trim(),
          cost: (row[7] || '').trim(),
          pic: (row[tab.picCol] || '').trim(),
          note: (row[10] || '').trim()
        });
      }
    } catch (err) {
      console.error('[Schedule] Error reading ' + tab.name + ':', err.message);
    }
  }

  // Ocean Drive (different structure)
  try {
    const data = await sheets.readSheet(MAINTENANCE_SID, OCEAN_DRIVE_TAB.name + '!A1:K30');
    if (data && data.length > 4) {
      for (let i = 4; i < data.length; i++) {
        const row = data[i];
        if (!row || row.length < 3) continue;
        const category = (row[1] || '').trim();
        const item = (row[2] || '').trim();
        if (!category || !item) continue;

        allItems.push({
          tab: OCEAN_DRIVE_TAB.name,
          villa: 'OCEAN DRIVE',
          row: i + 1,
          category: category,
          item: item,
          task: (row[3] || '').trim(),
          lastTime: parseDate(row[4]),
          lastTimeRaw: (row[4] || '').trim(),
          dueDate: parseDate(row[5]),
          dueDateRaw: (row[5] || '').trim(),
          status: (row[6] || '').trim(),
          cost: (row[7] || '').trim(),
          pic: 'OCEAN DRIVE TEAM',
          note: ''
        });
      }
    }
  } catch (err) {
    console.error('[Schedule] Error reading OCEAN DRIVE:', err.message);
  }

  return allItems;
}

// Get items due in N days
async function getItemsDueInDays(days) {
  const all = await getAllSchedules();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const target = new Date(now);
  target.setDate(target.getDate() + days);

  return all.filter(item => {
    if (!item.dueDate) return false;
    const due = new Date(item.dueDate);
    due.setHours(0, 0, 0, 0);
    return due.getTime() === target.getTime();
  });
}

// Get overdue items
async function getOverdueItems() {
  const all = await getAllSchedules();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return all.filter(item => {
    if (!item.dueDate) return false;
    const due = new Date(item.dueDate);
    due.setHours(0, 0, 0, 0);
    return due < now;
  });
}

// Get items with missing due dates (have lastTime but no dueDate)
async function getMissingDueDates() {
  const all = await getAllSchedules();
  return all.filter(item => !item.dueDate);
}

// Auto-calculate due date from lastTime + category
function calculateNextDueDate(lastTime, category) {
  if (!lastTime) return null;
  const cat = category.toLowerCase().replace(/\s/g, '-');
  const days = CATEGORY_DAYS[cat];
  if (!days) return null;
  const next = new Date(lastTime);
  next.setDate(next.getDate() + days);
  return next;
}

// Auto-determine status based on due date
function calculateStatus(dueDate) {
  if (!dueDate) return '';
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - now) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'Overdue';
  if (diffDays === 0) return 'Due Today';
  if (diffDays <= 2) return 'Due Soon';
  return 'Upcoming';
}

// Fill missing due dates and update statuses in the sheet
async function autoFillDueDatesAndStatus() {
  const all = await getAllSchedules();
  let updated = 0;

  for (const item of all) {
    let needsWrite = false;
    let newDueDate = item.dueDateRaw;
    let newStatus = item.status;

    // Auto-calc missing due date
    if (!item.dueDate && item.lastTime) {
      const calc = calculateNextDueDate(item.lastTime, item.category);
      if (calc) {
        newDueDate = formatDateForSheet(calc);
        item.dueDate = calc;
        needsWrite = true;
      }
    }

    // Auto-update status
    if (item.dueDate) {
      const correctStatus = calculateStatus(item.dueDate);
      if (correctStatus && correctStatus !== item.status) {
        newStatus = correctStatus;
        needsWrite = true;
      }
    }

    if (needsWrite) {
      try {
        // ⚠️ FORMULA SAFETY: Some rows in F (DUE DATE) and G (STATUS) have formulas
        // that auto-calculate. We must NOT overwrite those — only write to plain-value cells.
        const hasFFormula = await checkCellForFormula(MAINTENANCE_SID, item.tab, 'F', item.row);
        const hasGFormula = await checkCellForFormula(MAINTENANCE_SID, item.tab, 'G', item.row);

        let wrote = false;
        if (!hasFFormula && newDueDate !== item.dueDateRaw) {
          await sheets.writeSheet(MAINTENANCE_SID, item.tab + '!F' + item.row, [[newDueDate]]);
          wrote = true;
        } else if (hasFFormula) {
          console.log('[Schedule] Skipped F' + item.row + ' in ' + item.villa + ' — has formula');
        }

        if (!hasGFormula && newStatus !== item.status) {
          await sheets.writeSheet(MAINTENANCE_SID, item.tab + '!G' + item.row, [[newStatus]]);
          wrote = true;
        } else if (hasGFormula) {
          console.log('[Schedule] Skipped G' + item.row + ' in ' + item.villa + ' — has formula');
        }

        if (wrote) {
          updated++;
          console.log('[Schedule] Updated ' + item.villa + ' - ' + item.item + ': due=' + newDueDate + ' status=' + newStatus);
        }
      } catch (err) {
        console.error('[Schedule] Write error for ' + item.villa + ' - ' + item.item + ':', err.message);
      }
    }
  }

  return updated;
}

// Sync due dates to Google Calendar
async function syncToCalendar(items) {
  const { auth, calendarId, timezone } = getCalendarAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  let created = 0;

  for (const item of items) {
    if (!item.dueDate) continue;

    const summary = '[Maintenance] ' + item.villa + ' - ' + item.item;
    const description = 'Category: ' + item.category +
      '\nTask: ' + item.task +
      '\nPIC: ' + item.pic +
      '\nVilla: ' + item.villa +
      (item.note ? '\nNote: ' + item.note : '');

    // Check if event already exists (avoid duplicates)
    try {
      const dueStr = item.dueDate.toISOString().split('T')[0];
      const existing = await calendar.events.list({
        calendarId: calendarId,
        timeMin: dueStr + 'T00:00:00+08:00',
        timeMax: dueStr + 'T23:59:59+08:00',
        q: item.villa + ' ' + item.item,
        singleEvents: true
      });

      const alreadyExists = (existing.data.items || []).some(e =>
        e.summary && e.summary.includes(item.villa) && e.summary.includes(item.item)
      );

      if (alreadyExists) continue;

      // Create all-day event
      await calendar.events.insert({
        calendarId: calendarId,
        requestBody: {
          summary: summary,
          description: description,
          start: { date: dueStr, timeZone: timezone },
          end: { date: dueStr, timeZone: timezone },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: 2 * 24 * 60 },
              { method: 'popup', minutes: 24 * 60 }
            ]
          },
          colorId: item.category.toLowerCase().includes('quarterly') ? '11' :
                   item.category.toLowerCase().includes('annual') ? '4' :
                   item.category.toLowerCase().includes('semi') ? '6' : '8'
        }
      });
      created++;
    } catch (err) {
      console.error('[Schedule] Calendar error for ' + item.villa + ' ' + item.item + ':', err.message);
    }
  }

  return created;
}

// Format WhatsApp reminder for items due in 2 days
function formatUpcomingReminder(items) {
  if (items.length === 0) return null;

  const byVilla = {};
  for (const item of items) {
    if (!byVilla[item.villa]) byVilla[item.villa] = [];
    byVilla[item.villa].push(item);
  }

  const dueDate = items[0].dueDate;
  const dueDateStr = dueDate.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Asia/Makassar'
  });

  let msg = '\u23f0 *MAINTENANCE DUE IN 2 DAYS*\n';
  msg += '\ud83d\udcc5 ' + dueDateStr + '\n';
  msg += '\u2501'.repeat(18) + '\n\n';

  for (const [villa, villaItems] of Object.entries(byVilla)) {
    msg += '\ud83c\udfe0 *' + villa + '*\n';
    for (const item of villaItems) {
      msg += '\ud83d\udd27 ' + item.item + ' (' + item.category + ')\n';
      msg += '   \ud83d\udccb ' + item.task + '\n';
      msg += '   \ud83d\udc64 PIC: ' + (item.pic || '-') + '\n';
    }
    msg += '\n';
  }

  msg += '_Please schedule these tasks accordingly_';
  return msg;
}

// Format overdue alert
function formatOverdueAlert(items) {
  if (items.length === 0) return null;

  const byVilla = {};
  for (const item of items) {
    if (!byVilla[item.villa]) byVilla[item.villa] = [];
    byVilla[item.villa].push(item);
  }

  let msg = '\ud83d\udea8 *OVERDUE MAINTENANCE*\n';
  msg += '\u2501'.repeat(18) + '\n\n';

  for (const [villa, villaItems] of Object.entries(byVilla)) {
    msg += '\ud83c\udfe0 *' + villa + '* (' + villaItems.length + ' overdue)\n';
    for (const item of villaItems) {
      const daysOverdue = Math.round((new Date() - item.dueDate) / (1000 * 60 * 60 * 24));
      msg += '\ud83d\udd34 ' + item.item + ' \u2014 ' + daysOverdue + ' days overdue\n';
      msg += '   PIC: ' + (item.pic || '-') + '\n';
    }
    msg += '\n';
  }

  msg += '_These need immediate attention!_';
  return msg;
}

module.exports = {
  MAINTENANCE_SID,
  getAllSchedules,
  getItemsDueInDays,
  getOverdueItems,
  getMissingDueDates,
  autoFillDueDatesAndStatus,
  syncToCalendar,
  formatUpcomingReminder,
  formatOverdueAlert,
  calculateNextDueDate,
  calculateStatus,
  formatDateForSheet
};

