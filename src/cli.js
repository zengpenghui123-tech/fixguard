#!/usr/bin/env node
// fixguard — entry point
const { scan } = require('./scan');
const { check } = require('./check');
const { init } = require('./init');
const { scarsCommand } = require('./scars');
const { sleep } = require('./sleep');
const { reviewCommand } = require('./review');
const { runHook } = require('./hook');
const { readEvents } = require('./events');
const { statusCommand } = require('./status');
const { explainCommand } = require('./explain');
const { bootstrap } = require('./bootstrap');

const VERSION = require('../package.json').version;

const HELP = `fixguard v${VERSION} — protect bug fixes from AI assistants

Usage:
  fixguard bootstrap             ★ One-command install (init + commit + scan)
  fixguard init                  Install git pre-commit hook in current repo
  fixguard scan [path]           Scan for @fix markers, write FIXES.md
  fixguard scars                 Auto-detect scar tissue from git history
  fixguard sleep                 Run consolidation cycle, write dream report
  fixguard check [--staged]      Check if changes touch protected regions or scars
  fixguard hook                  Claude Code PreToolUse hook (reads JSON on stdin)
  fixguard events [--limit N] [--type T]
                                 Show recent hook/scan events from the blood log
  fixguard status                One-screen health check across all layers
  fixguard explain <file>        Explain (in plain language) all scars in one file
  fixguard list                  Print all protected regions (JSON)

Marker syntax (any comment style: // # -- /* */ <!-- -->):
  // @fix [tag] "reason — what NOT to do"          (protects next block)
  // @fix [tag] lines=10 "reason"                  (protects next 10 lines)
  // @fix-start [tag] "reason"
  ... protected code ...
  // @fix-end

Bypass (logged):
  FIXGUARD_BYPASS=1 git commit ...
  fixguard check --force
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'init':
        return await init(process.cwd());
      case 'bootstrap':
        return await bootstrap(process.cwd(), {
          skipScan: args.includes('--skip-scan'),
          skipCommit: args.includes('--skip-commit'),
        });
      case 'scan':
        return await scan(args[0] || process.cwd());
      case 'scars':
        return await scarsCommand(process.cwd());
      case 'sleep':
        return await sleep(process.cwd());
      case 'hook':
        return await runHook();
      case 'status':
        return statusCommand(process.cwd());
      case 'explain':
        return explainCommand(process.cwd(), args[0]);
      case 'events': {
        const limitIdx = args.indexOf('--limit');
        const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 30 : 30;
        const typeIdx = args.indexOf('--type');
        const type = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
        const events = readEvents(process.cwd(), type ? { limit, type } : { limit });
        if (events.length === 0) {
          console.log('fixguard: no events yet. (Blood log is empty.)');
          return;
        }
        for (const e of events) {
          const d = new Date(e.t).toISOString().replace('T', ' ').slice(0, 19);
          const rest = Object.entries(e)
            .filter(([k]) => k !== 't' && k !== 'type')
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v)}`)
            .join(' ');
          console.log(`${d}  \x1b[2m${e.type}\x1b[0m  ${rest}`);
        }
        return;
      }
      case 'check':
        return await check({
          staged: args.includes('--staged') || args.includes('--hook'),
          force: args.includes('--force'),
          cwd: process.cwd(),
        });
      case 'list': {
        const { listProtected } = require('./markers');
        const regions = await listProtected(process.cwd());
        console.log(JSON.stringify(regions, null, 2));
        return;
      }
      case '-v':
      case '--version':
        console.log(VERSION);
        return;
      case undefined:
      case '-h':
      case '--help':
        console.log(HELP);
        return;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(HELP);
        process.exit(2);
    }
  } catch (err) {
    console.error(`fixguard: ${err.message}`);
    if (process.env.FIXGUARD_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
