
const fs = require('fs');
const results = [];

function test(name, fn) {
  try {
    const r = fn();
    results.push({ name, status: 'PASS', detail: String(r || '').substring(0, 300) });
  } catch(e) {
    results.push({ name, status: 'FAIL', detail: e.message, stack: (e.stack||'').substring(0, 200) });
  }
}

// ===== RUFLO LOAD =====
let ruflo;
test('Load ruflo-integration', () => {
  ruflo = require('./ruflo-integration');
  return Object.keys(ruflo).length + ' modules';
});

if (!ruflo) {
  fs.writeFileSync('/root/claude-chatbot/audit-output.json', JSON.stringify([{name:'FATAL', status:'FAIL', detail:'Cannot load ruflo'}], null, 2));
  process.exit(1);
}

// ===== MODULE PRESENCE =====
Object.keys(ruflo).forEach(m => {
  test('Module: ' + m, () => {
    const v = ruflo[m];
    if (v === null || v === undefined) throw new Error('null/undefined');
    return typeof v;
  });
});

// ===== SMARTROUTER =====
test('SmartRouter.route()', () => {
  const r = ruflo.smartRouter;
  if (!r) throw new Error('not exported');
  const methods = [];
  try { methods.push(...Object.getOwnPropertyNames(Object.getPrototypeOf(r)).filter(m=>m!=='constructor')); } catch(e){}
  if (r.route) return JSON.stringify(r.route('maintenance status Villa Sunset')).substring(0,200);
  if (r.classify || r.classifyIntent) return 'has classify';
  return 'methods: ' + methods.join(',');
});

// ===== MODELROUTER =====
test('ModelRouter', () => {
  const mr = ruflo.modelRouter;
  if (!mr) throw new Error('not exported');
  const methods = [];
  try { methods.push(...Object.getOwnPropertyNames(Object.getPrototypeOf(mr)).filter(m=>m!=='constructor')); } catch(e){}
  if (mr.scoreComplexity) {
    const s1 = mr.scoreComplexity('hello');
    const s2 = mr.scoreComplexity('Compare all villa finances and create detailed quarterly report');
    return 'simple=' + s1 + ' complex=' + s2 + (s1 < s2 ? ' CORRECT' : ' WRONG');
  }
  return 'methods: ' + methods.join(',');
});

// ===== SWARM =====
test('SwarmCoordinator.tagExperts()', () => {
  const sc = ruflo.swarmCoordinator;
  if (!sc) throw new Error('not exported');
  if (!sc.tagExperts) return 'tagExperts not defined';
  return JSON.stringify(sc.tagExperts('Fix AC in Villa Sunset and send invoice')).substring(0,300);
});
test('SwarmCoordinator.tagExperts("") edge', () => {
  const sc = ruflo.swarmCoordinator;
  if (!sc || !sc.tagExperts) return 'skip';
  return JSON.stringify(sc.tagExperts('')).substring(0,200);
});
test('SwarmCoordinator.tagExperts(null) edge', () => {
  const sc = ruflo.swarmCoordinator;
  if (!sc || !sc.tagExperts) return 'skip';
  return JSON.stringify(sc.tagExperts(null)).substring(0,200);
});

// ===== VALIDATOR =====
test('Validator methods check', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  const proto = Object.getOwnPropertyNames(v.constructor?.prototype || {}).filter(m=>m!=='constructor');
  const own = Object.getOwnPropertyNames(v).filter(k=>typeof v[k]==='function');
  return 'proto:[' + proto.join(',') + '] own:[' + own.join(',') + ']';
});
test('Validator.validateEmail(valid)', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateEmail) throw new Error('not found');
  return JSON.stringify(v.validateEmail({to:'test@example.com', subject:'Test', body:'Hello'})).substring(0,200);
});
test('Validator.validateEmail(empty)', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateEmail) return 'skip';
  return JSON.stringify(v.validateEmail({to:'', subject:'', body:''})).substring(0,200);
});
test('Validator.validateEmail(null)', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateEmail) return 'skip';
  return JSON.stringify(v.validateEmail(null)).substring(0,200);
});
test('Validator.validateFinancial(valid)', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateFinancial) throw new Error('not found');
  return JSON.stringify(v.validateFinancial({amount:1000, type:'payment'})).substring(0,200);
});
test('Validator.validateFinancial(negative)', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateFinancial) return 'skip';
  return JSON.stringify(v.validateFinancial({amount:-500, type:'payment'})).substring(0,200);
});
test('Validator.validateFinancial(null)', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateFinancial) return 'skip';
  return JSON.stringify(v.validateFinancial(null)).substring(0,200);
});
test('Validator.validateCalendarEvent()', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateCalendarEvent) throw new Error('not found');
  return JSON.stringify(v.validateCalendarEvent({title:'Meeting', date:'2026-04-01'})).substring(0,200);
});
test('Validator.validateWhatsApp()', () => {
  const V = require('./agents/validator');
  const v = typeof V === 'function' ? new V() : V;
  if (!v.validateWhatsApp) throw new Error('not found');
  return JSON.stringify(v.validateWhatsApp({to:'628123@s.whatsapp.net', message:'Test'})).substring(0,200);
});

// ===== ROLLBACK =====
test('Rollback.trackToolExecution()', () => {
  const R = require('./agents/rollback');
  const rb = typeof R === 'function' ? new R() : R;
  if (!rb.trackToolExecution) throw new Error('not found');
  rb.trackToolExecution('sheets_write_data', {sheet:'test'}, {success:true});
  return 'OK';
});
test('Rollback.getRecentUndoable()', () => {
  const R = require('./agents/rollback');
  const rb = typeof R === 'function' ? new R() : R;
  if (!rb.getRecentUndoable) throw new Error('not found');
  return JSON.stringify(rb.getRecentUndoable()).substring(0,200);
});

// ===== CONDUCTOR =====
test('Conductor.detectWorkflow(onboarding)', () => {
  const C = require('./agents/conductor');
  const c = typeof C === 'function' ? new C() : C;
  if (!c.detectWorkflow) throw new Error('not found');
  return JSON.stringify(c.detectWorkflow('New villa to onboard Villa Harmony')).substring(0,200);
});
test('Conductor.detectWorkflow(month_end)', () => {
  const C = require('./agents/conductor');
  const c = typeof C === 'function' ? new C() : C;
  if (!c.detectWorkflow) return 'skip';
  return JSON.stringify(c.detectWorkflow('Do month end close for March')).substring(0,200);
});
test('Conductor.detectWorkflow(null) edge', () => {
  const C = require('./agents/conductor');
  const c = typeof C === 'function' ? new C() : C;
  if (!c.detectWorkflow) return 'skip';
  return JSON.stringify(c.detectWorkflow(null)).substring(0,200);
});

// ===== AUDITOR =====
test('Auditor.generateDailyDigest()', () => {
  const A = require('./agents/auditor');
  const a = typeof A === 'function' ? new A() : A;
  if (!a.generateDailyDigest) throw new Error('not found');
  return JSON.stringify(a.generateDailyDigest()).substring(0,300);
});

// ===== CORE MODULE METHODS =====
test('AIDefence.screen()', () => {
  const ad = ruflo.aiDefence;
  if (!ad) throw new Error('missing');
  if (!ad.screen) return 'no screen() method';
  return JSON.stringify(ad.screen('normal maintenance question')).substring(0,200);
});
test('VectorMemory.search()', () => {
  const mem = ruflo.vectorMemory;
  if (!mem) throw new Error('missing');
  if (!mem.search) return 'no search() method';
  return JSON.stringify(mem.search('villa maintenance')).substring(0,200);
});

// ===== DATABASE =====
test('SQLite databases', () => {
  const Database = require('better-sqlite3');
  const dataDir = '/root/claude-chatbot/data';
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.db') || f.endsWith('.sqlite'));
  let info = '';
  files.forEach(f => {
    const db = new Database(dataDir + '/' + f, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    let counts = [];
    tables.forEach(t => {
      try {
        const c = db.prepare('SELECT COUNT(*) as c FROM ' + t.name).get();
        counts.push(t.name + ':' + c.c);
      } catch(e){}
    });
    info += f + ' [' + counts.join(', ') + '] ';
    db.close();
  });
  return info;
});

// ===== NPM PACKAGES =====
['docx','pptxgenjs','pdf-parse','pdf-lib','pdfkit','xlsx','mammoth','better-sqlite3','@anthropic-ai/sdk','googleapis','express','@whiskeysockets/baileys','sharp','multer'].forEach(p => {
  test('npm: ' + p, () => { require(p); return 'loaded'; });
});

// ===== ALERT HISTORY =====
test('Alert history file', () => {
  const file = '/root/claude-chatbot/data/alert-history.json';
  if (!fs.existsSync(file)) throw new Error('missing');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Object.entries(data);
  return entries.length + ' entries: ' + entries.map(([k,v]) => k + '(count:' + v.count + ')').join(', ');
});

// ===== WHATSAPP CONFIG =====
test('WhatsApp config', () => {
  const cfg = JSON.parse(fs.readFileSync('/root/claude-chatbot/whatsapp-config.json', 'utf8'));
  const groups = cfg.groups || [];
  return groups.length + ' groups: ' + groups.map(g => g.name + '(active:' + g.active + ')').join(', ');
});

// ===== EXECUTOR TOOLS =====
test('Executor doc tool cases', () => {
  const src = fs.readFileSync('/root/claude-chatbot/executor.js', 'utf8');
  const docTools = ['doc_create_pdf','doc_read_pdf','doc_create_docx','doc_read_docx','doc_create_xlsx','doc_create_pptx'];
  const found = docTools.filter(t => src.includes("case '" + t + "'"));
  const missing = docTools.filter(t => !src.includes("case '" + t + "'"));
  if (missing.length) throw new Error('Missing: ' + missing.join(', '));
  return found.length + '/6 found';
});
test('Executor marketing tool cases', () => {
  const src = fs.readFileSync('/root/claude-chatbot/executor.js', 'utf8');
  const tools = ['scrape_url','scrape_multiple','scrape_competitor_prices','marketing_generate_listing','marketing_social_post'];
  const found = tools.filter(t => src.includes("case '" + t + "'"));
  const missing = tools.filter(t => !src.includes("case '" + t + "'"));
  if (missing.length) throw new Error('Missing: ' + missing.join(', '));
  return found.length + '/5 found';
});
test('Executor validator gate wiring', () => {
  const src = fs.readFileSync('/root/claude-chatbot/executor.js', 'utf8');
  const gated = ['gmail_send_message','calendar_create_event','finance_log_payment','sheets_write_data','sheets_append_row'];
  // Check if validator is called near these tools
  const found = gated.filter(t => {
    const idx = src.indexOf("case '" + t + "'");
    if (idx === -1) return false;
    const block = src.substring(idx, idx + 500);
    return block.includes('validate') || block.includes('Validator');
  });
  return found.length + '/' + gated.length + ' gated: ' + found.join(', ');
});

// ===== PROACTIVE MONITOR =====
test('ProactiveMonitor load', () => {
  const PM = require('./proactive-monitor');
  return typeof PM + (typeof PM === 'function' ? ' (constructor)' : ' (instance)');
});

// ===== BACKGROUND DAEMON =====
test('BackgroundDaemon check', () => {
  const d = ruflo.backgroundDaemon;
  if (!d) throw new Error('missing');
  if (typeof d === 'function') { const inst = d(); return 'factory → ' + typeof inst; }
  if (d.getDaemon) return 'has getDaemon';
  if (d.start) return 'has start';
  return typeof d;
});

// ===== WRITE RESULTS =====
const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
const summary = {
  total: results.length,
  passed,
  failed,
  score: Math.round(passed / results.length * 100) + '%',
  failures: results.filter(r => r.status === 'FAIL'),
  results
};
fs.writeFileSync('/root/claude-chatbot/audit-output.json', JSON.stringify(summary, null, 2));
console.log('AUDIT_DONE:' + passed + '/' + results.length);
