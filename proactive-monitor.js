// proactive-monitor.js — Autonomous Operator Brain for TVMbot
// Extracts intelligence patterns from AutoGPT (execution blocks + status routing)
// and crewAI (agent roles + proactive task detection)
//
// Runs periodic scans across ALL data sources (Sheets, Calendar, Drive, Memory)
// and detects problems, inconsistencies, and opportunities BEFORE the user asks.
//
// Architecture:
//   SCAN → DETECT → CLASSIFY → ALERT (via WhatsApp) → AWAIT CONFIRMATION → EXECUTE

const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
const MONITOR_CONFIG = {
  // Scan intervals (ms)
  fullScanInterval: 6 * 60 * 60 * 1000,   // Full scan every 6 hours
  quickScanInterval: 30 * 60 * 1000,       // Quick scan every 30 minutes

  // Detection thresholds
  staleMaintenanceDays: 2,          // Flag maintenance with no update after 2 days
  staleMaintenanceUrgentHours: 24,  // Flag URGENT tasks with no update after 24h
  bookingOverlapBufferHours: 2,     // Minimum gap between checkout and next checkin
  missingDataFields: ['PIC', 'Status', 'Date'],  // Required fields for maintenance
  lowOccupancyThreshold: 0.3,       // Flag if < 30% occupied next 30 days

  // Alert settings
  maxAlertsPerScan: 5,              // Don't overwhelm with alerts
  alertCooldownMinutes: 360,        // Don't re-alert same issue within 6 hours
  alertGroupJid: null,              // Set at runtime from WhatsApp config

  // Villas
  villas: ['ANN', 'DIANE', 'KALA', 'LOUNA', 'NISSA', 'LYMA', 'LIAN', 'LYSA'],
};

// ─── Alert History (prevent duplicates) ────────────────────────────────────────
// FILE-BASED alert history — survives PM2 restarts
const ALERT_HISTORY_FILE = require('path').join(__dirname, 'data', 'alert-history.json');
function _loadAlertHistory() {
  try {
    const fs = require('fs');
    if (fs.existsSync(ALERT_HISTORY_FILE)) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(ALERT_HISTORY_FILE, 'utf8'))));
    }
  } catch(e) {}
  return new Map();
}
function _saveAlertHistory(map) {
  try {
    const fs = require('fs');
    const dir = require('path').dirname(ALERT_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = {};
    map.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(ALERT_HISTORY_FILE, JSON.stringify(obj));
  } catch(e) {}
}
const alertHistory = _loadAlertHistory();

// ── EventBus bridge (lazy-loaded) ────────────────────────────────────────────
let _pmEventBus = null;
function _getEventBus() {
  if (!_pmEventBus) {
    try { _pmEventBus = require('./event-bus'); } catch(e) {}
  }
  return _pmEventBus;
}



function shouldAlert(issueKey) {
  const entry = alertHistory.get(issueKey);
  if (!entry) return true;
  const elapsed = Date.now() - entry.lastAlerted;
  return elapsed > MONITOR_CONFIG.alertCooldownMinutes * 60 * 1000;
}

function recordAlert(issueKey) {
  const entry = alertHistory.get(issueKey) || { lastAlerted: 0, count: 0 };
  entry.lastAlerted = Date.now();
  entry.count++;
  alertHistory.set(issueKey, entry);
}

// ─── Issue Classification ──────────────────────────────────────────────────────
const SEVERITY = {
  CRITICAL: 'CRITICAL',   // Needs immediate action (double booking, urgent maintenance stale)
  WARNING: 'WARNING',     // Needs attention soon (missing data, stale tasks)
  INFO: 'INFO',           // Suggestion/optimization (low occupancy, price adjustment)
};

class Issue {
  constructor(type, severity, title, details, suggestedAction, autoFixable = false) {
    this.type = type;
    this.severity = severity;
    this.title = title;
    this.details = details;
    this.suggestedAction = suggestedAction;
    this.autoFixable = autoFixable;
    this.key = `${type}:${title}`.replace(/\s+/g, '_').toLowerCase();
    this.timestamp = new Date().toISOString();
  }
}

// ─── Detectors ─────────────────────────────────────────────────────────────────

// Detector 1: Stale Maintenance Tasks
function detectStaleMaintenance(maintenanceData) {
  const issues = [];
  const now = new Date();

  for (const task of maintenanceData) {
    const status = (task.status || '').toUpperCase();
    if (status === 'DONE' || status === 'COMPLETED' || status === 'CLOSED') continue;

    const createdDate = task.date ? new Date(task.date) : null;
    if (!createdDate || isNaN(createdDate.getTime())) continue;

    const ageDays = (now - createdDate) / (1000 * 60 * 60 * 24);
    const priority = (task.priority || '').toUpperCase();

    // Urgent tasks stale after 24h
    if (priority === 'URGENT' && ageDays > 1) {
      issues.push(new Issue(
        'stale_maintenance',
        SEVERITY.CRITICAL,
        `${task.villa} — ${task.location || 'Unknown'} | ${task.issue || 'No description'}`,
        `URGENT task created ${Math.round(ageDays)} days ago, still ${status || 'OPEN'}. Priority: ${priority}.`,
        `Follow up with PIC (${task.pic || 'unassigned'}) or escalate.`,
        false
      ));
    }
    // Regular tasks stale after threshold
    else if (ageDays > MONITOR_CONFIG.staleMaintenanceDays) {
      issues.push(new Issue(
        'stale_maintenance',
        SEVERITY.WARNING,
        `${task.villa} — ${task.location || 'Unknown'} | ${task.issue || 'No description'}`,
        `Task created ${Math.round(ageDays)} days ago, still ${status || 'OPEN'}. No update detected.`,
        `Send follow-up to PIC (${task.pic || 'unassigned'}).`,
        false
      ));
    }
  }
  return issues;
}

// Detector 2: Missing Data Fields
function detectMissingData(maintenanceData) {
  const issues = [];

  for (const task of maintenanceData) {
    const status = (task.status || '').toUpperCase();
    if (status === 'DONE' || status === 'COMPLETED' || status === 'CLOSED') continue;

    const missing = [];
    if (!task.pic && !task.assigned_to) missing.push('PIC');
    if (!task.date) missing.push('Date');
    if (!task.status) missing.push('Status');
    if (!task.priority) missing.push('Priority');
    if (!task.villa) missing.push('Villa');

    if (missing.length > 0) {
      issues.push(new Issue(
        'missing_data',
        SEVERITY.WARNING,
        `Incomplete task: ${task.villa || 'Unknown'} — ${task.issue || 'No description'}`,
        `Missing fields: ${missing.join(', ')}.`,
        `Update the maintenance sheet with the missing information.`,
        false
      ));
    }
  }
  return issues;
}

// Detector 3: Booking Overlaps
function detectBookingOverlaps(bookings) {
  const issues = [];

  // Group bookings by villa
  const byVilla = {};
  for (const booking of bookings) {
    const villa = (booking.villa || booking.summary || '').toUpperCase();
    const villaKey = MONITOR_CONFIG.villas.find(v => villa.includes(v));
    if (!villaKey) continue;

    if (!byVilla[villaKey]) byVilla[villaKey] = [];
    byVilla[villaKey].push({
      ...booking,
      start: new Date(booking.start || booking.startTime || booking.check_in),
      end: new Date(booking.end || booking.endTime || booking.check_out),
    });
  }

  // Check for overlaps per villa
  for (const [villa, villaBookings] of Object.entries(byVilla)) {
    villaBookings.sort((a, b) => a.start - b.start);

    for (let i = 0; i < villaBookings.length - 1; i++) {
      const current = villaBookings[i];
      const next = villaBookings[i + 1];

      const bufferMs = MONITOR_CONFIG.bookingOverlapBufferHours * 60 * 60 * 1000;
      const gapMs = next.start - current.end;

      if (gapMs < 0) {
        // Actual overlap
        issues.push(new Issue(
          'booking_overlap',
          SEVERITY.CRITICAL,
          `Double booking: ${villa}`,
          `"${current.guest || current.summary}" (${formatDate(current.start)} - ${formatDate(current.end)}) overlaps with "${next.guest || next.summary}" (${formatDate(next.start)} - ${formatDate(next.end)}).`,
          `Resolve conflict: reschedule one booking or move to different villa.`,
          false
        ));
      } else if (gapMs < bufferMs) {
        // Insufficient gap for cleaning
        const gapHours = Math.round(gapMs / (60 * 60 * 1000));
        issues.push(new Issue(
          'booking_tight_gap',
          SEVERITY.WARNING,
          `Tight turnaround: ${villa}`,
          `Only ${gapHours}h gap between "${current.guest || current.summary}" checkout (${formatDate(current.end)}) and "${next.guest || next.summary}" checkin (${formatDate(next.start)}).`,
          `Ensure cleaning team is scheduled. Consider adjusting check-in time.`,
          false
        ));
      }
    }
  }
  return issues;
}

// Detector 4: Unclosed Tasks (created > 14 days ago, never resolved)
function detectUnclosedTasks(maintenanceData) {
  const issues = [];
  const now = new Date();

  for (const task of maintenanceData) {
    const status = (task.status || '').toUpperCase();
    if (status === 'DONE' || status === 'COMPLETED' || status === 'CLOSED') continue;

    const createdDate = task.date ? new Date(task.date) : null;
    if (!createdDate || isNaN(createdDate.getTime())) continue;

    const ageDays = (now - createdDate) / (1000 * 60 * 60 * 24);

    if (ageDays > 14) {
      issues.push(new Issue(
        'unclosed_task',
        SEVERITY.WARNING,
        `Zombie task (${Math.round(ageDays)} days): ${task.villa || 'Unknown'} — ${task.issue || 'No description'}`,
        `This task has been open for ${Math.round(ageDays)} days without resolution. Status: ${status || 'OPEN'}.`,
        `Either close it if resolved, or escalate to ${task.pic || 'management'}.`,
        false
      ));
    }
  }
  return issues;
}

// Detector 5: Cross-System — Maintenance impacting bookings
function detectMaintenanceBookingConflict(maintenanceData, bookings) {
  const issues = [];
  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Find active maintenance per villa
  const activeMaintenanceByVilla = {};
  for (const task of maintenanceData) {
    const status = (task.status || '').toUpperCase();
    if (status === 'DONE' || status === 'COMPLETED' || status === 'CLOSED') continue;

    const villa = (task.villa || '').toUpperCase();
    const villaKey = MONITOR_CONFIG.villas.find(v => villa.includes(v));
    if (!villaKey) continue;

    if (!activeMaintenanceByVilla[villaKey]) activeMaintenanceByVilla[villaKey] = [];
    activeMaintenanceByVilla[villaKey].push(task);
  }

  // Check if any villa with active maintenance has upcoming bookings
  for (const booking of bookings) {
    const bookingStart = new Date(booking.start || booking.startTime || booking.check_in);
    if (isNaN(bookingStart.getTime()) || bookingStart > nextWeek || bookingStart < now) continue;

    const villa = (booking.villa || booking.summary || '').toUpperCase();
    const villaKey = MONITOR_CONFIG.villas.find(v => villa.includes(v));
    if (!villaKey) continue;

    const maintenance = activeMaintenanceByVilla[villaKey];
    if (maintenance && maintenance.length > 0) {
      const urgentTasks = maintenance.filter(t => (t.priority || '').toUpperCase() === 'URGENT');
      const severity = urgentTasks.length > 0 ? SEVERITY.CRITICAL : SEVERITY.WARNING;

      issues.push(new Issue(
        'maintenance_booking_conflict',
        severity,
        `${villaKey}: Active maintenance + upcoming booking`,
        `Villa ${villaKey} has ${maintenance.length} open maintenance task(s) (${urgentTasks.length} urgent), but guest "${booking.guest || booking.summary}" arrives ${formatDate(bookingStart)}.`,
        `Prioritize repairs before guest arrival. Notify guest if major issue.`,
        false
      ));
    }
  }
  return issues;
}

// Detector 6: Repeated Maintenance (same villa + similar issue)
function detectRepeatedMaintenance(maintenanceData) {
  const issues = [];
  const issuesByVillaLocation = {};

  for (const task of maintenanceData) {
    const villa = (task.villa || '').toUpperCase();
    const location = (task.location || '').toLowerCase();
    const key = `${villa}:${location}`;

    if (!issuesByVillaLocation[key]) issuesByVillaLocation[key] = [];
    issuesByVillaLocation[key].push(task);
  }

  for (const [key, tasks] of Object.entries(issuesByVillaLocation)) {
    if (tasks.length >= 3) {
      const [villa, location] = key.split(':');
      issues.push(new Issue(
        'repeated_maintenance',
        SEVERITY.INFO,
        `Recurring issue: ${villa} — ${location || 'general'}`,
        `${tasks.length} maintenance tasks reported for the same area. This may indicate a systemic problem.`,
        `Suggest full inspection of ${villa} ${location}. Consider replacing equipment or infrastructure fix.`,
        false
      ));
    }
  }
  return issues;
}

// ─── Formatter ─────────────────────────────────────────────────────────────────

function formatDate(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Makassar' });
}

function formatAlertMessage(issues) {
  if (issues.length === 0) return null;

  const severityEmoji = {
    [SEVERITY.CRITICAL]: '🚨',
    [SEVERITY.WARNING]: '⚠️',
    [SEVERITY.INFO]: '💡',
  };

  let msg = `*TVMbot Operator Alert*\n${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Makassar' })}\n\n`;

  // Group by severity
  const critical = issues.filter(i => i.severity === SEVERITY.CRITICAL);
  const warning = issues.filter(i => i.severity === SEVERITY.WARNING);
  const info = issues.filter(i => i.severity === SEVERITY.INFO);

  if (critical.length > 0) {
    msg += `🚨 *CRITICAL* (${critical.length})\n`;
    for (const issue of critical.slice(0, 3)) {
      msg += `• ${issue.title}\n  ${issue.details}\n  → _${issue.suggestedAction}_\n\n`;
    }
  }

  if (warning.length > 0) {
    msg += `⚠️ *NEEDS ATTENTION* (${warning.length})\n`;
    for (const issue of warning.slice(0, 3)) {
      msg += `• ${issue.title}\n  → _${issue.suggestedAction}_\n\n`;
    }
  }

  if (info.length > 0) {
    msg += `💡 *SUGGESTIONS* (${info.length})\n`;
    for (const issue of info.slice(0, 2)) {
      msg += `• ${issue.title}\n  → _${issue.suggestedAction}_\n\n`;
    }
  }

  msg += `_Reply with the issue number or description to take action._`;

  // WhatsApp limit: keep under 1300 chars
  if (msg.length > 1300) {
    msg = msg.slice(0, 1250) + `\n\n_...${issues.length - 5} more issues. Ask me for full report._`;
  }

  return msg;
}

// ─── Main Scan Engine ──────────────────────────────────────────────────────────

class ProactiveMonitor {
  constructor(options = {}) {
    this.executor = options.executor || null;       // Tool executor function
    this.whatsapp = options.whatsapp || null;        // WhatsApp send function
    this.memory = options.memory || null;            // Memory module
    this.memoryManager = options.memoryManager || null; // Memory manager module
    this.alertJid = options.alertJid || null;        // WhatsApp group JID for alerts
    this.runPEMSAgent = options.runPEMSAgent || null; // The AI agent function
    this.scanTimer = null;
    this.quickScanTimer = null;
    this.lastScanResults = [];
    this.isScanning = false;
  }

  // Parse maintenance data from sheets (raw rows to objects)
  parseMaintenanceRows(rows, headers) {
    if (!rows || rows.length === 0) return [];
    const hdr = (headers || rows[0] || []).map(h => (h || '').toLowerCase().trim());
    const dataRows = headers ? rows : rows.slice(1);

    return dataRows.map(row => {
      const obj = {};
      hdr.forEach((h, i) => { obj[h] = row[i] || ''; });
      return {
        villa: obj.villa || obj['villa name'] || obj['villa_name'] || '',
        location: obj.location || obj.area || '',
        issue: obj.issue || obj.description || obj.problem || '',
        status: obj.status || '',
        priority: obj.priority || obj.urgency || '',
        pic: obj.pic || obj['person in charge'] || obj.assigned || '',
        date: obj.date || obj['date reported'] || obj.timestamp || '',
        notes: obj.notes || obj.update || '',
      };
    }).filter(t => t.villa || t.issue); // Skip empty rows
  }

  // Parse booking data from calendar events
  parseBookingEvents(events) {
    return (events || []).map(e => ({
      summary: e.summary || '',
      guest: e.summary ? e.summary.split('@')[0].trim() : '',
      villa: e.summary || '',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
    }));
  }

  // Run all detectors
  async runFullScan() {
    if (this.isScanning) {
      console.log('[Monitor] Scan already in progress, skipping');
      return [];
    }

    this.isScanning = true;
    console.log('[Monitor] Starting full proactive scan...');
    const startTime = Date.now();
    const allIssues = [];

    try {
      // 1. Fetch maintenance data from sheets
      let maintenanceData = [];
      try {
        const sheetId = '1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE';
        // Single maintenance sheet: https://docs.google.com/spreadsheets/d/1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE
        // First tab contains all maintenance data (API name differs from display name)
        const ranges = ['A1:Z200'];

        for (const range of ranges) {
          const result = await this.executeToolSafe('sheets_read_data', {
            spreadsheetId: sheetId,
            range: range
          });
          if (result && (result.data || result.values)) {
            const parsed = this.parseMaintenanceRows(result.data || result.values);
            maintenanceData.push(...parsed);
          }
        }
        console.log(`[Monitor] Fetched ${maintenanceData.length} maintenance records`);
      } catch (e) {
        console.error('[Monitor] Maintenance fetch error:', e.message);
      }

      // 2. Fetch calendar bookings (next 30 days)
      let bookings = [];
      try {
        const now = new Date();
        const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const result = await this.executeToolSafe('calendar_get_events', {
          timeMin: now.toISOString(),
          timeMax: future.toISOString(),
          maxResults: 50
        });
        if (result && result.events) {
          bookings = this.parseBookingEvents(result.events);
          console.log(`[Monitor] Fetched ${bookings.length} upcoming bookings`);
        }
      } catch (e) {
        console.error('[Monitor] Calendar fetch error:', e.message);
      }

      // 3. Run all detectors
      allIssues.push(...detectStaleMaintenance(maintenanceData));
      allIssues.push(...detectMissingData(maintenanceData));
      allIssues.push(...detectBookingOverlaps(bookings));
      allIssues.push(...detectUnclosedTasks(maintenanceData));
      allIssues.push(...detectMaintenanceBookingConflict(maintenanceData, bookings));
      allIssues.push(...detectRepeatedMaintenance(maintenanceData));

      // 4. Filter by cooldown (don't re-alert same issue too quickly)
      const newIssues = allIssues.filter(issue => shouldAlert(issue.key));

      // 5. Sort by severity
      const severityOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 };
      newIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

      // 6. Limit alerts
      const toAlert = newIssues.slice(0, MONITOR_CONFIG.maxAlertsPerScan);

      // 7. Send alert if there are NEW issues (max 2 alert batches per day)
      const today = new Date().toISOString().split('T')[0];
      if (!this._alertsToday) this._alertsToday = { date: today, count: 0 };
      if (this._alertsToday.date !== today) this._alertsToday = { date: today, count: 0 };
      
      // Extra dedup: only send if alert content is different from last time
      const alertFingerprint = toAlert.map(i => i.key).sort().join('|');
      const isDuplicate = this._lastAlertFingerprint === alertFingerprint;
      if (isDuplicate) {
        console.log('[Monitor] Skipping duplicate alert (same issues as last time)');
      }
      
      if (toAlert.length > 0 && this.whatsapp && this.alertJid && this._alertsToday.count < 2 && !isDuplicate) {
        this._alertsToday.count++;
        this._lastAlertFingerprint = alertFingerprint;
        const message = formatAlertMessage(toAlert);
        if (message) {
          try {
            if (global.__tvmbot_no_autonomous) {
              console.log('[Monitor] Suppressed alert send (NO_AUTONOMOUS_MODE)');
            } else if (this.whatsapp && this.whatsapp.user) {
              await this.whatsapp.sendMessage(this.alertJid, message);
            }
            toAlert.forEach(issue => recordAlert(issue.key));
          // ── EventBus bridge: emit maintenance events for detected issues ────
          const _eb = _getEventBus();
          if (_eb) {
            const MAINT_ISSUE_TYPES = new Set(['stale_maintenance', 'unclosed_task', 'missing_data', 'maintenance_booking_conflict']);
            toAlert.forEach(issue => {
              if (MAINT_ISSUE_TYPES.has(issue.type)) {
                // Extract villa name from title pattern: "VILLA — location | issue"
                const villaMatch = (issue.title || '').match(/^([A-Z]+)\s*[—-]/);
                const villaName = villaMatch ? villaMatch[1] : '';
                _eb.emitMaintenance({
                  title:       issue.title    || 'Monitor Alert',
                  description: issue.details  || '',
                  villa_name:  villaName,
                  severity:    issue.severity === 'CRITICAL' ? 'critical' : issue.severity === 'WARNING' ? 'high' : 'medium',
                  reported_by: 'proactive-monitor',
                  fromMonitor: true,
                  fromExecutor: true  // skip duplicate DB save in MaintenanceAgent
                }, 'proactive-monitor');
              }
            });
          }
            console.log(`[Monitor] Sent alert with ${toAlert.length} issues to ${this.alertJid}`);
          } catch (e) {
            if (!global._monitorWaWarned) { console.warn('[Monitor] WhatsApp alerts unavailable (not connected)'); global._monitorWaWarned = true; }
          }
        }
      }

      // 8. Store results
      this.lastScanResults = allIssues;

      const duration = Date.now() - startTime;
      console.log(`[Monitor] Full scan complete: ${allIssues.length} issues found (${toAlert.length} alerted) in ${duration}ms`);

      // 9. Log to memory manager
      if (this.memoryManager) {
        this.memoryManager.logExecution({
          sessionId: 'proactive_monitor',
          request: 'full_scan',
          toolsCalled: ['sheets_read_data', 'calendar_get_events'],
          durationMs: duration,
          status: 'completed',
          resultSummary: `${allIssues.length} issues: ${allIssues.filter(i => i.severity === 'CRITICAL').length} critical, ${allIssues.filter(i => i.severity === 'WARNING').length} warning, ${allIssues.filter(i => i.severity === 'INFO').length} info`
        });
      }

      return allIssues;

    } catch (e) {
      console.error('[Monitor] Scan error:', e.message);
      return [];
    } finally {
      this.isScanning = false;
    }
  }

  // Safe tool execution wrapper
  async executeToolSafe(toolName, input) {
    if (!this.executor) {
      console.warn('[Monitor] No executor available');
      return null;
    }
    try {
      return await this.executor(toolName, input);
    } catch (e) {
      console.error(`[Monitor] Tool ${toolName} error:`, e.message);
      return null;
    }
  }


  // ═══ UPGRADE #4: AUTO-RESOLVE — act, don't just report ═══════════════
  async autoResolve(issues) {
    let resolved = 0;
    for (const issue of issues) {
      try {
        switch (issue.type) {
          case 'stale_maintenance': {
            // Auto-escalate: send direct message to PIC
            if (global.__tvmbot_no_autonomous) { break; }
            if (issue.data && issue.data.pic && this.whatsapp) {
              const msg = `⏰ Maintenance reminder: "${issue.data.issue}" at ${issue.data.villa} has had no update for ${issue.data.daysSinceReport || '?'} days. Please update the status or add notes.`;
              // Send to maintenance group with @mention
              const maintGroup = this._getMaintGroup();
              if (maintGroup) {
                await this.whatsapp.sendMessage(maintGroup, `*Stale task reminder*\n${msg}`);
                resolved++;
              }
            }
            break;
          }
          case 'missing_data': {
            // Auto-fill: set default PIC to "Unassigned" in sheet
            if (issue.data && !issue.data.pic && issue.data.row) {
              try {
                await this.executeToolSafe('sheets_write_data', {
                  spreadsheetId: '1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE',
                  range: `E${issue.data.row}`,
                  values: [['Unassigned']]
                });
                console.log(`[Monitor] Auto-filled PIC for row ${issue.data.row}`);
                resolved++;
              } catch(e) {}
            }
            break;
          }
          case 'unclosed_task': {
            // Auto-follow-up: ask in maintenance group for update
            if (global.__tvmbot_no_autonomous) { break; }
            const maintGroup = this._getMaintGroup();
            if (maintGroup && this.whatsapp && issue.data) {
              const msg = `📋 *Task follow-up*: "${issue.data.issue}" at ${issue.data.villa} is still open. Is this done? Reply with status update.`;
              await this.whatsapp.sendMessage(maintGroup, msg);
              resolved++;
            }
            break;
          }
          // booking_overlap and maintenance_booking_conflict → just alert (human decision needed)
          default:
            break;
        }
      } catch(e) {
        console.error(`[Monitor] Auto-resolve failed for ${issue.type}:`, e.message);
      }
    }
    if (resolved > 0) {
      console.log(`[Monitor] Auto-resolved ${resolved}/${issues.length} issues`);
    }
    return resolved;
  }

  _getMaintGroup() {
    try {
      const fs = require('fs');
      const path = require('path');
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'whatsapp-config.json'), 'utf8'));
      const g = (cfg.groups || []).find(g => g.name && g.name.toLowerCase().includes('maintenance'));
      return g ? g.jid : null;
    } catch(e) { return null; }
  }

  // Get issues summary (for AI context)
  getIssuesSummary() {
    if (this.lastScanResults.length === 0) return '';

    const critical = this.lastScanResults.filter(i => i.severity === SEVERITY.CRITICAL);
    const warning = this.lastScanResults.filter(i => i.severity === SEVERITY.WARNING);
    const info = this.lastScanResults.filter(i => i.severity === SEVERITY.INFO);

    let summary = '\nPROACTIVE MONITOR STATUS:';
    if (critical.length) summary += `\n🚨 ${critical.length} critical issue(s): ${critical.map(i => i.title).join('; ')}`;
    if (warning.length) summary += `\n⚠️ ${warning.length} warning(s): ${warning.slice(0, 3).map(i => i.title).join('; ')}`;
    if (info.length) summary += `\n💡 ${info.length} suggestion(s)`;

    return summary;
  }

  // Start periodic scanning
  start() {
    console.log('[Monitor] Starting proactive monitor...');

    // Initial scan after 60 seconds (let other systems initialize)
    setTimeout(() => this.runFullScan(), 5 * 60 * 1000); // 5 min delay on boot

    // Full scan every 4 hours
    this.scanTimer = setInterval(() => this.runFullScan(), MONITOR_CONFIG.fullScanInterval);

    console.log(`[Monitor] Scheduled: full scan every ${MONITOR_CONFIG.fullScanInterval / 3600000}h`);
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.quickScanTimer) clearInterval(this.quickScanTimer);
    console.log('[Monitor] Stopped');
  }

  // On-demand scan (triggered by user asking "any issues?" or "status report")
  async onDemandScan() {
    const issues = await this.runFullScan();
    if (issues.length === 0) {
      return 'All clear — no issues detected across maintenance, bookings, and operations.';
    }
    return formatAlertMessage(issues);
  }

  // Write alert to SQLite dashboard queue (works even when WA is down)
  _writeAlertToDb(issue) {
    try {
      const memory = require('./memory');
      const db = memory.db;
      db.exec(`CREATE TABLE IF NOT EXISTS monitor_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT DEFAULT 'WARNING',
        title TEXT NOT NULL,
        details TEXT,
        suggested_action TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        acknowledged INTEGER DEFAULT 0,
        sent_via_wa INTEGER DEFAULT 0
      )`);
      db.prepare("INSERT INTO monitor_alerts (severity, title, details, suggested_action) VALUES (?, ?, ?, ?)")
        .run(issue.severity || 'WARNING', issue.title || 'Alert', issue.details || '', issue.suggestedAction || '');
    } catch(e) { /* non-critical */ }
  }


}

module.exports = {
  ProactiveMonitor,
  MONITOR_CONFIG,
  SEVERITY,
  Issue,
  // Export detectors for testing
  detectStaleMaintenance,
  detectMissingData,
  detectBookingOverlaps,
  detectUnclosedTasks,
  detectMaintenanceBookingConflict,
  detectRepeatedMaintenance,
  formatAlertMessage,
};
