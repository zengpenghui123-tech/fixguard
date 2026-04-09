// explain.js — show all scars in one file, in plain language.
//
// Designed for users who see `fixguard status` or `fixguard scars` output
// and want to ask "wait, what's actually protected in src/foo.js and
// WHY?" without having to open scars.json or run git blame manually.
const fs = require('fs');
const path = require('path');
const { loadScarMap } = require('./scars');
const { loadWeights } = require('./weights');

const BOLD = s => `\x1b[1m${s}\x1b[0m`;
const DIM  = s => `\x1b[2m${s}\x1b[0m`;
const CYAN = s => `\x1b[36m${s}\x1b[0m`;
const YEL  = s => `\x1b[33m${s}\x1b[0m`;
const GREEN = s => `\x1b[32m${s}\x1b[0m`;

function explainCommand(cwd, fileArg) {
  if (!fileArg) {
    console.error('usage: fixguard explain <file>');
    console.error('       fixguard explain src/auth.js');
    process.exit(2);
  }

  const scarMap = loadScarMap(cwd);
  if (!scarMap) {
    console.log('No scar map found. Run `fixguard scars` first.');
    return;
  }

  // Normalize the input path the same way scars.json stores it (relative, forward slashes)
  let target = fileArg;
  if (path.isAbsolute(target)) {
    target = path.relative(cwd, target);
  }
  target = target.replace(/\\/g, '/');

  const scars = scarMap.scars.filter(s => s.file === target);
  if (scars.length === 0) {
    console.log(`${CYAN(target)} has no scars.`);
    console.log(DIM('  This file is not currently protected by fixguard.'));
    console.log(DIM('  Either it has never been touched by a bug-fix commit,'));
    console.log(DIM('  or all of its scars have been archived as outdated.'));
    return;
  }

  // Sort by line number for readability
  scars.sort((a, b) => a.startLine - b.startLine);

  console.log('');
  console.log(`${BOLD(target)}`);
  console.log(DIM(`  ${scars.length} protected region(s) in this file`));
  console.log('');

  for (let i = 0; i < scars.length; i++) {
    const s = scars[i];
    const num = `#${i + 1}`.padEnd(4);

    // Try to show the actual code line(s) for context
    let codeSnippet = null;
    try {
      const fileText = fs.readFileSync(path.join(cwd, target), 'utf8');
      const lines = fileText.split(/\r?\n/);
      const snippetLines = lines.slice(s.startLine - 1, s.endLine);
      if (snippetLines.length && snippetLines.length <= 8) {
        codeSnippet = snippetLines.join('\n');
      } else if (snippetLines.length > 8) {
        codeSnippet = snippetLines.slice(0, 5).join('\n') + '\n    ...';
      }
    } catch { /* skip snippet */ }

    const lineLabel = s.startLine === s.endLine
      ? `line ${s.startLine}`
      : `lines ${s.startLine}-${s.endLine}`;

    console.log(`${num}${CYAN(lineLabel)} ${DIM('· commit ' + s.sha + ' · ' + (s.date || '').slice(0, 10))}`);
    console.log(`    ${BOLD('Why it exists:')} ${s.story}`);

    if (codeSnippet) {
      console.log(DIM('    ┌─ the protected code ────'));
      for (const line of codeSnippet.split('\n')) {
        console.log(DIM('    │ ') + line);
      }
      console.log(DIM('    └─'));
    }

    // Show weight info if present
    if (typeof s.weight === 'number') {
      const w = s.weight;
      let bar, tone;
      if (w >= 0.8)      { bar = '████████'; tone = GREEN; }
      else if (w >= 0.6) { bar = '██████  '; tone = GREEN; }
      else if (w >= 0.4) { bar = '████    '; tone = YEL; }
      else if (w >= 0.3) { bar = '███     '; tone = YEL; }
      else               { bar = '░░░░░░░░'; tone = DIM; }
      const counters = [];
      if (s.blockCount) counters.push(`${s.blockCount}× blocked`);
      if (s.bypassCount) counters.push(`${s.bypassCount}× bypassed`);
      const countStr = counters.length ? DIM(` (${counters.join(', ')})`) : '';
      console.log(`    ${BOLD('Health:')} ${tone(bar)} weight ${w.toFixed(2)}${countStr}`);
      if (s.archived) {
        console.log(`    ${YEL('⚠ ARCHIVED')} — this scar has been bypassed enough times that fixguard stopped enforcing it.`);
      }
    }

    console.log('');
  }

  // Closing footer: what you can do with this info
  console.log(BOLD('What this means in plain English:'));
  console.log('  Each region above is a chunk of code that your team added when fixing a real bug.');
  console.log('  fixguard will block any AI attempt to delete or rewrite these exact lines,');
  console.log('  and will show the AI the original commit message as the reason.');
  console.log('');
  console.log(DIM('  To temporarily override a block: FIXGUARD_BYPASS=1 before your next git/Claude command.'));
  console.log(DIM('  To remove a scar permanently: just keep bypassing it — fixguard auto-archives it after a few bypasses.'));
  console.log('');
}

module.exports = { explainCommand };
