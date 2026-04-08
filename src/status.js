// status.js — single diagnostic entry point.
//
// fixguard's state is now spread across 5 files:
//   .fixguard/scars.json        (derived git-blame map)
//   .fixguard/weights.json      (per-scar learned state)
//   .fixguard/patterns.json     (REM cross-scar patterns)
//   .fixguard/events.jsonl      (append-only blood log)
//   .fixguard/last-sleep.json   (sleep cycle cursor)
//
// `fixguard status` reads all five and prints a one-screen health check
// answering the questions users will actually ask:
//   - Is this project protected? By how many scars?
//   - When was the last scan / sleep?
//   - Is the scar map stale against current HEAD?
//   - How many scars have been archived?
//   - What patterns have emerged?
//   - What has the hook been doing?
const fs = require('fs');
const path = require('path');
const { loadScarMap, isScarMapStale, getHeadSha } = require('./scars');
const { loadWeights, ARCHIVE_THRESHOLD } = require('./weights');
const { loadPatterns, PATTERN_CONFIRMATION_THRESHOLD } = require('./patterns');
const { readEvents, eventsPath } = require('./events');

const BOLD = s => `\x1b[1m${s}\x1b[0m`;
const DIM  = s => `\x1b[2m${s}\x1b[0m`;
const GREEN= s => `\x1b[32m${s}\x1b[0m`;
const YEL  = s => `\x1b[33m${s}\x1b[0m`;
const RED  = s => `\x1b[31m${s}\x1b[0m`;

function yesno(cond, yes = 'yes', no = 'no') {
  return cond ? GREEN(yes) : DIM(no);
}

function fmtDate(iso) {
  if (!iso) return DIM('never');
  return iso.slice(0, 19).replace('T', ' ');
}

function fmtRelative(iso) {
  if (!iso) return DIM('never');
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const ageMs = Date.now() - t;
  const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
  if (ageHours < 1) return `${Math.floor(ageMs / 60000)}m ago`;
  if (ageHours < 24) return `${ageHours}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

function statusCommand(cwd) {
  console.log('');
  console.log(BOLD('fixguard status'));
  console.log(DIM(`  ${cwd}`));
  console.log('');

  // ── Scar map ────────────────────────────────────────────────
  const scarMap = loadScarMap(cwd);
  if (!scarMap) {
    console.log(`  ${YEL('⚠')} no scar map found. Run ${BOLD('fixguard scars')} to generate one.`);
    console.log('');
    return;
  }

  const activeScars = scarMap.scars.filter(s => !s.archived);
  const archivedScars = scarMap.scars.filter(s => s.archived);
  const stale = isScarMapStale(cwd, scarMap);
  const currentHead = getHeadSha(cwd);

  console.log(`  ${BOLD('Scar map')}  ${DIM(`(.fixguard/scars.json)`)}`);
  console.log(`    active:   ${BOLD(activeScars.length)} scar region(s)`);
  console.log(`    archived: ${archivedScars.length} ${DIM(`(weight < ${ARCHIVE_THRESHOLD})`)}`);
  console.log(`    fix commits: ${scarMap.fixCommitCount}`);
  console.log(`    generated: ${fmtDate(scarMap.generatedAt)} ${DIM(`(${fmtRelative(scarMap.generatedAt)})`)}`);
  console.log(`    headSha: ${DIM((scarMap.headSha || 'unknown').slice(0, 8))} ${stale ? RED('→ STALE vs current ' + (currentHead || '').slice(0, 8)) : GREEN('→ current')}`);
  console.log('');

  // ── Weight summary ──────────────────────────────────────────
  const weights = loadWeights(cwd);
  const entries = Object.values(weights.scars || {});
  if (entries.length > 0) {
    const buckets = { '1.0-0.8': 0, '0.8-0.6': 0, '0.6-0.4': 0, '0.4-0.3': 0, '<0.3': 0 };
    let totalBlock = 0, totalBypass = 0, totalAllow = 0;
    for (const e of entries) {
      if (e.weight >= 0.8) buckets['1.0-0.8']++;
      else if (e.weight >= 0.6) buckets['0.8-0.6']++;
      else if (e.weight >= 0.4) buckets['0.6-0.4']++;
      else if (e.weight >= 0.3) buckets['0.4-0.3']++;
      else buckets['<0.3']++;
      totalBlock += e.blockCount || 0;
      totalBypass += e.bypassCount || 0;
      totalAllow += e.allowCount || 0;
    }
    console.log(`  ${BOLD('Weight dynamics')}  ${DIM(`(.fixguard/weights.json)`)}`);
    console.log(`    tracked: ${entries.length} scar(s)`);
    console.log(`    distribution:`);
    for (const [band, n] of Object.entries(buckets)) {
      if (n === 0) continue;
      console.log(`      ${band}   ${'█'.repeat(Math.min(n, 30))} ${n}`);
    }
    console.log(`    lifetime totals: ${GREEN(totalBlock + ' blocked')} · ${totalAllow} surfaced · ${totalBypass > 0 ? YEL(totalBypass + ' bypassed') : '0 bypassed'}`);
    console.log('');
  }

  // ── Patterns ────────────────────────────────────────────────
  const patterns = loadPatterns(cwd);
  const pairs = Object.values(patterns.pairs || {});
  const confirmed = pairs.filter(p => p.count >= PATTERN_CONFIRMATION_THRESHOLD);
  if (pairs.length > 0) {
    console.log(`  ${BOLD('Cross-scar patterns')}  ${DIM(`(.fixguard/patterns.json)`)}`);
    console.log(`    candidate pairs: ${pairs.length}`);
    console.log(`    confirmed: ${BOLD(confirmed.length)} ${DIM(`(seen in ≥${PATTERN_CONFIRMATION_THRESHOLD} sessions)`)}`);
    console.log('');
  }

  // ── Blood log recent activity ──────────────────────────────
  const logPath = eventsPath(cwd);
  if (fs.existsSync(logPath)) {
    const all = readEvents(cwd);
    const recent24 = all.filter(e => Date.now() - (e.t || 0) < 24 * 60 * 60 * 1000);
    const byType = new Map();
    for (const e of recent24) byType.set(e.type, (byType.get(e.type) || 0) + 1);
    console.log(`  ${BOLD('Blood log (24h)')}  ${DIM(`(.fixguard/events.jsonl)`)}`);
    console.log(`    total events: ${all.length}`);
    console.log(`    last 24h: ${recent24.length}`);
    if (byType.size > 0) {
      for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${t.padEnd(28)}  ${n}`);
      }
    }
    console.log('');
  }

  // ── Last sleep ─────────────────────────────────────────────
  const lastSleepPath = path.join(cwd, '.fixguard', 'last-sleep.json');
  if (fs.existsSync(lastSleepPath)) {
    try {
      const ls = JSON.parse(fs.readFileSync(lastSleepPath, 'utf8'));
      console.log(`  ${BOLD('Last sleep')}  ${fmtDate(ls.at)} ${DIM(`(${fmtRelative(ls.at)})`)}`);
      console.log('');
    } catch { /* ignore */ }
  }

  // ── Health summary ─────────────────────────────────────────
  const healthItems = [];
  if (stale) healthItems.push(`${YEL('⚠')} scar map is stale — run \`fixguard scars\``);
  if (activeScars.length === 0 && scarMap.fixCommitCount > 0) {
    healthItems.push(`${YEL('⚠')} 0 active scars but ${scarMap.fixCommitCount} fix commits found — check config threshold`);
  }
  if (healthItems.length === 0) {
    console.log(`  ${GREEN('✓')} healthy`);
  } else {
    for (const item of healthItems) console.log(`  ${item}`);
  }
  console.log('');
}

module.exports = { statusCommand };
