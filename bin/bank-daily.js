#!/usr/bin/env node
/**
 * Daily bank-mail ingest for Afni (Binky, 21-11-2026).
 *   node bin/bank-daily.js --dry-run [--since YYYY-MM-DD]   → prints the summary, prepares nothing, state untouched
 *   node bin/bank-daily.js [--since YYYY-MM-DD]             → prepares previews, writes data/bank-ingest-last-summary.txt (0600)
 * Never sends Telegram itself.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ingest = require('../bank-ingest');

function args(argv) {
  const o = { dryRun: false, since: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') o.dryRun = true;
    else if (argv[i] === '--since') o.since = argv[++i];
    else if (argv[i].startsWith('--since=')) o.since = argv[i].slice(8);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (o.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(o.since || '')) throw new Error('--since must be YYYY-MM-DD');
  return o;
}

async function main() {
  const opt = args(process.argv.slice(2));
  const root = path.join(__dirname, '..');
  const dataDir = path.join(root, 'data');
  const res = await ingest.createIngest(ingest.productionDeps({ root, dataDir })).run(opt);
  const text = ingest.buildSummary(res);
  if (!opt.dryRun) {
    const file = path.join(dataDir, 'bank-ingest-last-summary.txt');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }
  process.stdout.write(text + '\n');
}

main().catch(e => { process.stderr.write(`bank-daily failed: ${e.message}\n`); process.exit(1); });
