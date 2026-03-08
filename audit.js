// audit.js — Audit Logger for TVMbot
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LOG_FILE = path.join(DATA_DIR, 'audit.log');

function log(action, details = '', email = 'system', status = 'SUCCESS') {
  const entry = {
    timestamp: new Date().toISOString(),
    email,
    action,
    details: String(details).slice(0, 500),
    status
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch(e) {}
}

function getRecent(lines = 50) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    return content.trim().split('\n').slice(-lines).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

module.exports = { log, getRecent };
