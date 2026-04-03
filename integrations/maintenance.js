// integrations/maintenance.js — Maintenance Reminder System
const sheets = require('./sheets');

const MAINTENANCE_SID = '1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE';

// ─── TAB DEFINITIONS ─────────────────────────────────────────────────────────
// Each tab has its own column layout. ULUWATU is different from the others.
//
// MAINTENANCE  / 2025 MAINTENANCE:
//   B=DESC  C=DAY  D=MONTH  E=PIC  F=VILLA  G=LOCATION  H=ISSUE
//   I=PHOTOS BEFORE  J=NOTES  K=STATUS  L=PHOTOS AFTER
//
// MAINTENANCE ULUWATU:
//   B=DESC  C=DAY  D=MONTH  E=PIC  F=VILLA  G=LOCATION  H=ISSUE
//   I=PHOTOS BEFORE  J=NOTES  K=PHOTOS AFTER  L=COST
//   ⚠️ NO STATUS COLUMN — status is inferred (if PHOTOS AFTER exists → done)
//
const MAINTENANCE_TABS = [
  { name: '', statusCol: 10, photoAfterCol: 11, statusLetter: 'K', photoAfterLetter: 'L' },
  // Note: The MAINTENANCE tab in the Google Sheets UI maps to the default/first tab in the API.
  // Using empty name '' means we read range 'A1:L500' (no tab prefix) which reads the first tab.
];

function parseRow(tab, row, i) {
  // Status handling: tabs with statusCol=-1 have no STATUS column
  let status = '';
  if (tab.statusCol >= 0) {
    status = (row[tab.statusCol] || '').trim().toUpperCase();
  } else {
    // ULUWATU: infer status — if photoAfter exists, it's likely done
    const photoAfter = (row[tab.photoAfterCol] || '').trim();
    if (photoAfter) status = 'DONE';
    // Otherwise leave blank (no status info available)
  }

  return {
    tab: tab.name.trim(),
    row: i + 1,
    day: (row[2] || '').trim(),
    month: (row[3] || '').trim(),
    pic: (row[4] || '').trim(),
    villa: (row[5] || '').trim(),
    location: (row[6] || '').trim(),
    issue: (row[7] || '').trim(),
    notes: (row[9] || '').trim(),
    status: status,
    hasPhotoBefore: !!(row[8] || '').trim(),
    hasPhotoAfter: tab.photoAfterCol >= 0 ? !!(row[tab.photoAfterCol] || '').trim() : false
  };
}

async function scanAllRows() {
  const all = [];
  for (const tab of MAINTENANCE_TABS) {
    try {
      const range = tab.name ? (tab.name + '!A1:L500') : 'A1:L500';
      const data = await sheets.readSheet(MAINTENANCE_SID, range);
      if (!data || data.length <= 1) continue;
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || row.length < 3) continue;
        const item = parseRow(tab, row, i);
        if (!item.issue && !item.villa) continue;
        if (item.status === 'DONE') continue;
        all.push(item);
      }
    } catch (err) {
      console.error('[Maintenance] Error reading tab "' + tab.name + '":', err.message);
    }
  }
  return all;
}

async function getPendingItems() {
  const all = await scanAllRows();
  return all.filter(i => i.status === 'PENDING' || i.status === 'URGENT');
}

async function getBlankStatusItems() {
  const all = await scanAllRows();
  return all.filter(i => !i.status || i.status === '' || i.status === 'NO STATUS');
}

function formatMorningReminder(items) {
  if (items.length === 0) {
    return '\u2705 *Good morning team!*\n\nNo pending maintenance items today. Great job! \ud83c\udfe0';
  }

  items.sort((a, b) => {
    const p = { 'URGENT': 0, 'PENDING': 1 };
    return (p[a.status] || 2) - (p[b.status] || 2);
  });

  const byVilla = {};
  for (const item of items) {
    const v = item.villa || 'Unknown';
    if (!byVilla[v]) byVilla[v] = [];
    byVilla[v].push(item);
  }

  const urgentCount = items.filter(i => i.status === 'URGENT').length;
  const pendingCount = items.filter(i => i.status === 'PENDING').length;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Asia/Makassar'
  });

  let msg = '\ud83d\udd27 *MAINTENANCE REMINDER*\n';
  msg += '\ud83d\udcc5 ' + today + '\n\n';
  if (urgentCount > 0) msg += '\ud83d\udd34 *' + urgentCount + ' URGENT*\n';
  msg += '\ud83d\udfe1 ' + pendingCount + ' Pending\n';
  msg += '\u2501'.repeat(18) + '\n\n';

  for (const [villa, villaItems] of Object.entries(byVilla)) {
    msg += '\ud83c\udfe0 *' + villa + '*\n';
    for (const item of villaItems) {
      const icon = item.status === 'URGENT' ? '\ud83d\udd34' : '\ud83d\udfe1';
      msg += icon + ' ' + item.location + ' \u2014 ' + item.issue + '\n';
      msg += '   PIC: ' + (item.pic || '-') + ' | Since: ' + item.day + ' ' + item.month + '\n';
      if (item.notes) {
        const shortNote = item.notes.substring(0, 80);
        msg += '   \ud83d\udcdd ' + shortNote + (item.notes.length > 80 ? '...' : '') + '\n';
      }
    }
    msg += '\n';
  }

  msg += '\u2501'.repeat(18) + '\n';
  msg += '\ud83d\udcca Total: *' + items.length + '* open items\n';
  msg += '\n_Reply to update status or report completion_';
  return msg;
}

function formatStatusCheck(items) {
  if (items.length === 0) return null;

  const batch = items.slice(0, 5);

  let msg = '\ud83d\udccb *STATUS UPDATE NEEDED*\n\n';
  msg += 'These items have no status yet. Please update:\n\n';

  batch.forEach(function(item, idx) {
    msg += (idx + 1) + '. \ud83c\udfe0 *' + item.villa + '* \u2014 ' + item.location + ' | ' + item.issue + '\n';
    msg += '   PIC: ' + (item.pic || '-') + ' | Reported: ' + item.day + ' ' + item.month + '\n';
    if (item.notes) {
      msg += '   \ud83d\udcdd ' + item.notes.substring(0, 60) + (item.notes.length > 60 ? '...' : '') + '\n';
    }
    msg += '\n';
  });

  msg += 'Reply with the number and status, e.g.:\n';
  msg += '_"1 DONE \u2014 fixed by Giri, replaced the pipe"_\n';
  msg += '_"2 PENDING \u2014 waiting for parts"_\n';
  msg += '_"3 URGENT \u2014 guest arriving tomorrow"_\n';

  if (items.length > 5) {
    msg += '\n\u26a0\ufe0f ' + (items.length - 5) + ' more items need status updates';
  }

  return msg;
}

function formatFollowUp(item) {
  let msg = '\ud83d\udccb *FOLLOW UP NEEDED*\n\n';
  msg += '\ud83c\udfe0 *' + item.villa + '* \u2014 ' + item.location + '\n';
  msg += '\ud83d\udd27 Issue: ' + item.issue + '\n';
  msg += '\ud83d\udc64 PIC: ' + item.pic + '\n';
  msg += '\ud83d\udcc5 Reported: ' + item.day + ' ' + item.month + '\n\n';
  msg += 'Please provide:\n';
  msg += '1\ufe0f\u20e3 *After photo* \u2014 take a photo of the fix\n';
  msg += '2\ufe0f\u20e3 *What was done* \u2014 describe the solution\n';
  msg += '3\ufe0f\u20e3 *Who did it* \u2014 technician/PIC name\n\n';
  msg += '_Send the info here and I\'ll update the sheet_ \u270f\ufe0f';
  return msg;
}

// ─── UPDATE STATUS ──────────────────────────────────────────────────────────
// Uses per-tab column config so ULUWATU writes to correct columns
async function updateStatus(tabName, row, status, notes, photoAfterUrl) {
  // Find the tab config
  const tab = MAINTENANCE_TABS.find(t => t.name.trim() === tabName.trim());
  if (!tab) {
    console.error('[Maintenance] Unknown tab: ' + tabName);
    return false;
  }

  try {
    // Notes → always J (same across all tabs)
    if (notes) {
      await sheets.writeSheet(MAINTENANCE_SID, tabName + '!J' + row, [[notes]]);
    }

    // Status → only if tab HAS a status column
    if (status && tab.statusLetter) {
      await sheets.writeSheet(MAINTENANCE_SID, tabName + '!' + tab.statusLetter + row, [[status]]);
    } else if (status && !tab.statusLetter) {
      console.warn('[Maintenance] Tab "' + tabName + '" has no STATUS column — status not written');
    }

    // Photo After → use tab-specific column
    if (photoAfterUrl && tab.photoAfterLetter) {
      await sheets.writeSheet(MAINTENANCE_SID, tabName + '!' + tab.photoAfterLetter + row, [[photoAfterUrl]]);
    }

    return true;
  } catch (err) {
    console.error('[Maintenance] Update error:', err.message);
    return false;
  }
}

module.exports = {
  MAINTENANCE_SID,
  MAINTENANCE_TABS,
  getPendingItems,
  getBlankStatusItems,
  formatMorningReminder,
  formatStatusCheck,
  formatFollowUp,
  updateStatus
};

