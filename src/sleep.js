// sleep.js — consolidation cycle. Compares current scar map to last sleep,
// surfaces new scars, recurring pain, and decay. Outputs a "dream report".
const fs = require('fs');
const path = require('path');
const { detectScars } = require('./scars');
const { readEvents } = require('./events');
const { updateWeightsFromEvents, loadWeights, ARCHIVE_THRESHOLD } = require('./weights');
const { updatePatternsFromEvents, resolvePair } = require('./patterns');

const DIM   = s => `\x1b[2m${s}\x1b[0m`;
const BOLD  = s => `\x1b[1m${s}\x1b[0m`;
const CYAN  = s => `\x1b[36m${s}\x1b[0m`;
const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const YEL   = s => `\x1b[33m${s}\x1b[0m`;

function scarKey(s) { return `${s.file}:${s.startLine}:${s.fullSha || s.sha}`; }

// Summarize blood-log events since a given timestamp.
// Returns counts and top-5 breakdowns the dream report can render.
function summarizeEventsSince(cwd, sinceMs) {
  const events = readEvents(cwd, { since: sinceMs });
  const summary = {
    total: events.length,
    deny: 0,
    allowWithContext: 0,
    bypassed: 0,
    staleMap: 0,
    scansTriggered: 0,
    mostDeniedFiles: new Map(),
    mostSurfacedFiles: new Map(),
    mostBypassedFiles: new Map(),
  };
  for (const e of events) {
    switch (e.type) {
      case 'hook.deny':
        summary.deny++;
        if (e.file) summary.mostDeniedFiles.set(e.file, (summary.mostDeniedFiles.get(e.file) || 0) + 1);
        break;
      case 'hook.allow_with_context':
        summary.allowWithContext++;
        if (e.file) summary.mostSurfacedFiles.set(e.file, (summary.mostSurfacedFiles.get(e.file) || 0) + 1);
        break;
      case 'hook.bypassed':
        summary.bypassed++;
        if (e.file) summary.mostBypassedFiles.set(e.file, (summary.mostBypassedFiles.get(e.file) || 0) + 1);
        break;
      case 'hook.stale_map':
        summary.staleMap++;
        break;
      case 'scars.scan':
        summary.scansTriggered++;
        break;
    }
  }
  return summary;
}

// Files bypassed ≥ BYPASS_ESCALATION_THRESHOLD times since last sleep are
// surfaced as warnings in the dream report — the scars protecting them
// are likely outdated. Weights.js is already eroding them automatically;
// this surface just tells the user what the system noticed.
const BYPASS_ESCALATION_THRESHOLD = 3;

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function loadLast(cwd) {
  const p = path.join(cwd, '.fixguard', 'last-sleep.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function saveLast(cwd, payload) {
  const dir = path.join(cwd, '.fixguard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-sleep.json'), JSON.stringify(payload, null, 2));
}

function writeDream(cwd, dateStr, body) {
  const dir = path.join(cwd, '.fixguard', 'dreams');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${dateStr}.md`), body);
}

function formatDreamMd({ now, total, fixCommitCount, newScars, vanishedScars, recurringFiles, isFirst, lastAt }) {
  const lines = [];
  lines.push(`# Dream — ${now}`);
  lines.push('');
  if (isFirst) {
    lines.push(`First sleep. Scanned ${fixCommitCount} fix-commits → **${total}** scar regions.`);
  } else {
    lines.push(`Last sleep: ${lastAt}`);
    lines.push(`Current total: **${total}** scars (from ${fixCommitCount} fix-commits)`);
  }
  lines.push('');
  if (newScars.length) {
    lines.push(`## New scars (${newScars.length})`);
    for (const s of newScars.slice(0, 50)) {
      lines.push(`- \`${s.file}:${s.startLine}-${s.endLine}\` ${s.sha} — ${s.story}`);
    }
    if (newScars.length > 50) lines.push(`- …and ${newScars.length - 50} more`);
    lines.push('');
  }
  if (vanishedScars.length) {
    lines.push(`## Healed / vanished (${vanishedScars.length})`);
    for (const s of vanishedScars.slice(0, 20)) {
      lines.push(`- \`${s.file}:${s.startLine}-${s.endLine}\` ${s.sha}`);
    }
    lines.push('');
  }
  if (recurringFiles.length) {
    lines.push(`## Recurring pain`);
    lines.push(`Files with many scars — possibly structural debt rather than ordinary bugs:`);
    for (const [file, count] of recurringFiles) {
      lines.push(`- \`${file}\` — ${count} scars`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function sleep(cwd) {
  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10);

  console.log('');
  console.log(CYAN('🌙 fixguard sleeping…'));

  const result = await detectScars(cwd);
  const { scars, fixCommitCount, scannedFiles } = result;
  const last = loadLast(cwd);

  // Compute deltas vs last sleep
  const currentSet = new Set(scars.map(scarKey));
  const lastSet = last ? new Set(last.scars.map(scarKey)) : new Set();

  const newScars = scars.filter(s => !lastSet.has(scarKey(s)));
  const vanishedScars = last ? last.scars.filter(s => !currentSet.has(scarKey(s))) : [];

  // Recurring pain: files with ≥3 scars
  const fileCounts = new Map();
  for (const s of scars) fileCounts.set(s.file, (fileCounts.get(s.file) || 0) + 1);
  const recurringFiles = [...fileCounts.entries()]
    .filter(([_, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Blood-log summary since last sleep (or all-time if first sleep)
  const sinceMs = last && last.at ? new Date(last.at).getTime() : 0;
  const blood = summarizeEventsSince(cwd, sinceMs);

  // Apply weight updates from the same window. Scars reinforced / eroded
  // this cycle land back in .fixguard/weights.json and change how hook.js
  // treats them on the very next call.
  const weightDelta = updateWeightsFromEvents(cwd, { scars }, sinceMs);

  // REM-style cross-scar pattern detection. Pairs of scars blocked in
  // the same session accumulate co-occurrence counts; pairs crossing
  // the confirmation threshold (≥2 distinct sessions) are treated as
  // structural coupling signals and surfaced in the dream report.
  const patterns = updatePatternsFromEvents(cwd, sinceMs);

  // ─── Dream report ────────────────────────────────────────────────
  console.log('');
  if (!last) {
    console.log(`  ${BOLD('First sleep.')} Scanned ${scannedFiles} files, ${fixCommitCount} fix-commits.`);
    console.log(`  Found ${BOLD(scars.length)} scar regions.`);
  } else {
    console.log(`  Last sleep: ${DIM(last.at)}`);
    console.log(`  Current: ${BOLD(scars.length)} scars total ${DIM(`(was ${last.scars.length})`)}`);
    console.log('');

    if (newScars.length) {
      console.log(`  ${GREEN('+ New scars formed since last sleep:')} ${newScars.length}`);
      for (const s of newScars.slice(0, 8)) {
        console.log(`    ${s.file}:${s.startLine}-${s.endLine}  ${DIM(s.sha)}  ${s.story}`);
      }
      if (newScars.length > 8) console.log(DIM(`    …and ${newScars.length - 8} more`));
      console.log('');
    }
    if (vanishedScars.length) {
      console.log(`  ${DIM(`~ Healed / vanished: ${vanishedScars.length}`)}`);
      console.log('');
    }
  }

  if (recurringFiles.length) {
    console.log(`  ${YEL('💡 Recurring pain — files that bleed often:')}`);
    for (const [file, count] of recurringFiles) {
      console.log(`     ${file}  ${DIM(`(${count} scars)`)} — maybe needs a rewrite, not another patch`);
    }
    console.log('');
  }

  // ── Blood-log summary ─────────────────────────────────────────────
  if (blood.total > 0) {
    console.log(`  ${BOLD('Blood-log activity')} ${DIM(`since ${last?.at || 'start'}`)}:`);
    console.log(`    ${GREEN('✓')} ${blood.allowWithContext} scar context injection(s) shown to AI`);
    if (blood.deny > 0) {
      console.log(`    ${YEL('⛔')} ${BOLD(blood.deny)} edit attempt(s) blocked at scar regions`);
    }
    if (blood.bypassed > 0) {
      console.log(`    ${YEL('⚠')}  ${blood.bypassed} time(s) FIXGUARD_BYPASS was used`);
      // Escalate: any file repeatedly bypassed is probably guarding something
      // that's no longer relevant. Weights.js is already decaying it, but
      // flag it for the user too.
      const repeatedBypass = [...blood.mostBypassedFiles.entries()]
        .filter(([_, n]) => n >= BYPASS_ESCALATION_THRESHOLD)
        .sort((a, b) => b[1] - a[1]);
      if (repeatedBypass.length) {
        console.log('');
        console.log(`    ${YEL('⚠⚠')} ${BOLD('Repeatedly bypassed files')} — scars here may be outdated:`);
        for (const [file, n] of repeatedBypass) {
          console.log(`       ${file}  ${DIM(`(${n}× bypassed — scar weights auto-decaying)`)}`);
        }
      }
    }
    if (blood.staleMap > 0) {
      console.log(`    ${DIM(`${blood.staleMap} hook call(s) saw a stale scar map — consider running \`fixguard scars\` more often`)}`);
    }
    const topDenied = topN(blood.mostDeniedFiles, 5);
    if (topDenied.length) {
      console.log('');
      console.log(`    ${DIM('Most-attacked scars:')}`);
      for (const [file, n] of topDenied) {
        console.log(`      ${file}  ${DIM(`${n}× blocked`)}`);
      }
    }
    console.log('');
  }

  // ── REM: cross-scar patterns ─────────────────────────────────────
  if (patterns.newlyConfirmed.length > 0 || patterns.confirmedCount > 0) {
    console.log(`  ${BOLD('Cross-scar patterns')} ${DIM('(scars blocked together across sessions)')}:`);
    if (patterns.newlyConfirmed.length > 0) {
      console.log(`    ${GREEN('💡')} ${patterns.newlyConfirmed.length} new pattern(s) confirmed this cycle`);
    }
    const shown = patterns.topPatterns.slice(0, 5);
    for (const p of shown) {
      const pair = resolvePair(p, { scars });
      if (!pair || !pair.a || !pair.b) continue;
      console.log(`    · ${pair.a.file}:${pair.a.startLine}  ↔  ${pair.b.file}:${pair.b.startLine}  ${DIM(`(${p.count}× together)`)}`);
      console.log(`      ${DIM(`${pair.a.story.slice(0, 60)}`)}`);
      console.log(`      ${DIM(`${pair.b.story.slice(0, 60)}`)}`);
    }
    console.log('');
  }

  // ── Weight dynamics ──────────────────────────────────────────────
  if (weightDelta.eventsProcessed > 0 || weightDelta.archived > 0 || weightDelta.unarchived > 0) {
    console.log(`  ${BOLD('Memory dynamics')} ${DIM(`(weight < ${ARCHIVE_THRESHOLD} = archived)`)}:`);
    if (weightDelta.reinforced > 0) {
      console.log(`    ${GREEN('↑')} ${weightDelta.reinforced} scar-hit(s) reinforced (attacked & defended)`);
    }
    if (weightDelta.eroded > 0) {
      console.log(`    ${YEL('↓')} ${weightDelta.eroded} scar-hit(s) eroded (bypassed by user)`);
    }
    if (weightDelta.archived > 0) {
      console.log(`    ${DIM(`📦 ${weightDelta.archived} scar(s) auto-archived (weight fell below threshold)`)}`);
    }
    if (weightDelta.unarchived > 0) {
      console.log(`    ${GREEN('🔓')} ${weightDelta.unarchived} scar(s) unarchived (weight recovered)`);
    }
    console.log('');
  }

  // Persist
  const dreamMd = formatDreamMd({
    now,
    total: scars.length,
    fixCommitCount,
    newScars,
    vanishedScars,
    recurringFiles,
    isFirst: !last,
    lastAt: last?.at,
  });
  writeDream(cwd, dateStr, dreamMd);
  saveLast(cwd, { at: now, fixCommitCount, scars });

  // Also refresh scars.json for the rest of the system to use
  const { writeScarMap } = require('./scars');
  writeScarMap(cwd, result);

  console.log(DIM(`  → .fixguard/dreams/${dateStr}.md`));
  console.log(DIM(`  → .fixguard/scars.json`));
  console.log(DIM(`  → .fixguard/last-sleep.json`));
  console.log('');
}

module.exports = { sleep };
