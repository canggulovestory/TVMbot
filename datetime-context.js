// datetime-context.js — Fresh datetime injection per message turn
// RULE: Never put datetime in system prompt (goes stale). Inject per message.

/**
 * Resolve timezone for a user with fallback chain:
 *   user timezone → business default → Asia/Makassar (Bali)
 */
function resolveTimezone(userId, db) {
  // Try user-specific timezone first
  if (db && userId) {
    try {
      const user = db.prepare('SELECT timezone FROM user_settings WHERE user_id = ?').get(userId);
      if (user && user.timezone) return user.timezone;
    } catch(e) { /* table may not exist yet */ }
  }
  // Fall back to business default from .env or Asia/Makassar
  return process.env.TZ || 'Asia/Makassar';
}

/**
 * Format a rich datetime injection string for prepending to user messages.
 * Called on EVERY incoming message before passing to AI.
 */
function formatDatetimeInjection(userId, db) {
  const tz = resolveTimezone(userId, db);
  const now = new Date();
  
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: tz
  });
  const isoStr = now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
  
  return `[Current datetime: ${dateStr}, ${timeStr} (${tz}) | ISO: ${isoStr}]`;
}

/**
 * Server-accurate "now" in a specific timezone — for scheduler/cron use.
 * Returns a Date object adjusted to the timezone context.
 */
function serverNow(tz) {
  const timezone = tz || process.env.TZ || 'Asia/Makassar';
  const now = new Date();
  // Return ISO string in the target timezone for SQLite comparisons
  return now.toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
}

module.exports = { resolveTimezone, formatDatetimeInjection, serverNow };
