// check.js — fail commit if staged changes touch protected regions
const fs = require('fs');
const path = require('path');
const { parseFile, loadConfig, DEFAULT_IGNORE } = require('./markers');
const { getStagedChanges, getStagedDeletions, rangesOverlap, git } = require('./diff');
const { loadScarMap } = require('./scars');
const { appendEvent } = require('./events');

const RED = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const BOLD = s => `\x1b[1m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

async function check({ staged = true, force = false, cwd }) {
  const bypassActive = force || process.env.FIXGUARD_BYPASS === '1';

  // Verify we're in a git repo
  try { git('rev-parse --git-dir', cwd); }
  catch { throw new Error('not a git repository'); }

  const newRanges = getStagedChanges(cwd);
  const oldRanges = getStagedDeletions(cwd);

  if (newRanges.size === 0 && oldRanges.size === 0) {
    console.log('fixguard: no staged changes.');
    return;
  }

  const cfg = loadConfig(cwd);
  const violations = [];

  // Load auto-detected scar map (if `fixguard scars` or `fixguard sleep` has been run).
  // loadScarMap enriches each scar with weight/archived state, so we skip
  // archived scars here — matching hook.js behavior.
  const scarMap = loadScarMap(cwd);
  const scarsByFile = new Map();
  if (scarMap && Array.isArray(scarMap.scars)) {
    for (const s of scarMap.scars) {
      if (s.archived) continue; // respect weight-based archival
      if (!scarsByFile.has(s.file)) scarsByFile.set(s.file, []);
      scarsByFile.get(s.file).push(s);
    }
  }

  // Collect all files involved (both new and old sides)
  const filesToCheck = new Set([...newRanges.keys(), ...oldRanges.keys()]);

  for (const rel of filesToCheck) {
    const abs = path.join(cwd, rel);

    // Check OLD-side: are we deleting lines that were inside a protected region?
    // Use HEAD version of the file to find markers as they were committed.
    const oldHits = oldRanges.get(rel) || [];
    if (oldHits.length) {
      let headText;
      try { headText = git(`show HEAD:"${rel}"`, cwd); }
      catch { headText = null; }
      if (headText !== null) {
        const tmpRegions = parseTextAsFile(headText, rel);
        for (const r of tmpRegions) {
          for (const range of oldHits) {
            if (rangesOverlap([r.startLine, r.endLine], range)) {
              violations.push({ ...r, hitRange: range, side: 'deleted' });
            }
          }
        }
      }
    }

    // Check NEW-side: do additions land inside a protected region of the working file?
    const newHits = newRanges.get(rel) || [];
    if (newHits.length && fs.existsSync(abs)) {
      const regions = parseFile(abs, cwd);
      for (const r of regions) {
        for (const range of newHits) {
          if (rangesOverlap([r.startLine, r.endLine], range)) {
            violations.push({ ...r, hitRange: range, side: 'modified' });
          }
        }
      }
    }

    // Check against auto-detected scars (both new + old side, against current line ranges)
    const scarRegions = scarsByFile.get(rel) || [];
    if (scarRegions.length) {
      const allHits = [...(newRanges.get(rel) || []), ...(oldRanges.get(rel) || [])];
      for (const scar of scarRegions) {
        for (const range of allHits) {
          if (rangesOverlap([scar.startLine, scar.endLine], range)) {
            violations.push({
              file: rel,
              startLine: scar.startLine,
              endLine: scar.endLine,
              tag: `scar:${scar.sha}`,
              reason: scar.story,
              hitRange: range,
              side: 'scar',
            });
          }
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('fixguard: ✓ no protected regions touched.');
    return;
  }

  // Deduplicate
  const seen = new Set();
  const uniq = violations.filter(v => {
    const k = `${v.file}:${v.startLine}:${v.endLine}:${v.hitRange[0]}:${v.side}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // ─── Bypass path: violations exist but user set FIXGUARD_BYPASS ───
  // Emit one hook.bypassed event per UNIQUE violated file so that
  // sleep.js → weights.js can erode the scars for each file the
  // bypass effectively covered. Without this, commit-time bypasses
  // would not flow into the learning ring, breaking the symmetry with
  // hook.js-time bypasses.
  if (bypassActive) {
    console.error(YELLOW('fixguard: BYPASS active — protected regions NOT checked.'));
    console.error(YELLOW(`          ${uniq.length} violation(s) silently overridden.`));
    console.error(YELLOW('          This is audited — run `fixguard events` to see the bypass log.'));
    const filesBypassed = new Set(uniq.map(v => v.file));
    for (const file of filesBypassed) {
      appendEvent(cwd, {
        type: 'hook.bypassed',
        tool: 'git-commit',
        file,
        reason: 'FIXGUARD_BYPASS=1 at commit time',
      });
    }
    return;
  }

  console.error(RED(BOLD(`\n✗ fixguard: ${uniq.length} protected region(s) touched\n`)));
  for (const v of uniq) {
    console.error(BOLD(`  ${v.file}:${v.startLine}-${v.endLine}`) + DIM(`  [${v.tag}] (${v.side})`));
    if (v.reason) console.error(`    ${YELLOW('why:')} ${v.reason}`);
    console.error(DIM(`    your change touched lines ${v.hitRange[0]}-${v.hitRange[1]}`));
    console.error('');
  }
  console.error(DIM('  Read FIXES.md before changing these. If you really need to bypass:'));
  console.error(DIM('    FIXGUARD_BYPASS=1 git commit ...\n'));
  process.exit(1);
}

// Helper: parse a text blob (from `git show`) using same logic as parseFile
function parseTextAsFile(text, rel) {
  const tmp = require('os').tmpdir() + '/fixguard-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, text);
  try {
    const regions = parseFile(tmp, require('os').tmpdir());
    // Re-stamp file path to match real file
    return regions.map(r => ({ ...r, file: rel }));
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

module.exports = { check };
