// bootstrap.js — one-command full install.
//
// `fixguard init` is the minimal primitive — it modifies files and leaves
// everything in the working tree for the user to review and commit. That's
// correct for a library-style CLI, but it exposes a real trap: on Husky
// projects, the user MUST commit the .husky/pre-commit modification
// immediately or it gets lost on the next `git stash`. This trap was
// discovered during live validation on a Husky-based production project (DESIGN.md §12.2) and is
// exactly the kind of silent-failure that the whole project exists to
// prevent.
//
// `fixguard bootstrap` is the zero-friction path:
//   1. Install the git pre-commit hook and the Claude Code hook
//   2. Write the default .fixguardrc.json
//   3. Selectively stage ONLY the files those steps modified
//      (never user's unrelated work)
//   4. Commit them with a clear chore: message
//   5. Run the first scan to populate .fixguard/scars.json
//   6. Print a concrete "protection is now active" summary
//
// A developer who runs this on a fresh project walks away with:
//   · hooks installed and committed (stable across stash/checkout/rebase)
//   · scar map generated from their git history
//   · fixguard protection live on the very next edit or commit
//   · zero manual git operations required
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { installGitHook, installClaudeCodeHook, resolvePreCommitPath, HOOK_MARKER } = require('./init');
const { detectScars, writeScarMap } = require('./scars');
const { appendEvent } = require('./events');

const BOLD = s => `\x1b[1m${s}\x1b[0m`;
const DIM  = s => `\x1b[2m${s}\x1b[0m`;
const CYAN = s => `\x1b[36m${s}\x1b[0m`;
const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const YEL  = s => `\x1b[33m${s}\x1b[0m`;

function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); }
  catch { return false; }
}

// Returns list of files (relative to cwd) that actually exist on disk.
// Bootstrap will only ever `git add` files that actually exist — this
// prevents "git add: no files matched" errors if init skipped something.
function existingFiles(cwd, rels) {
  return rels.filter(rel => fileExists(path.join(cwd, rel)));
}

// Check if any of the target files is dirty compared to HEAD in a way
// the user would NOT want to commit automatically.
function findUserModifications(cwd) {
  try {
    const status = git('status --porcelain', cwd);
    return status.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function bootstrap(cwd, opts = {}) {
  const { skipScan = false, skipCommit = false } = opts;

  // ── Step 0: sanity checks ──────────────────────────────────────
  try { git('rev-parse --git-dir', cwd); }
  catch { throw new Error('not a git repository — run `git init` first'); }

  // Get HEAD state BEFORE any modifications so we can report the delta
  let headSha = '';
  try { headSha = git('rev-parse HEAD', cwd).trim(); }
  catch { /* no commits yet, that's fine */ }

  console.log('');
  console.log(CYAN(BOLD('fixguard bootstrap')));
  console.log(DIM('  one-command install for this repo'));
  console.log('');

  // ── Step 1: Install hooks + rc directly (skip init()'s full output) ─
  // We call the primitive install functions ourselves rather than init()
  // so bootstrap controls all user-facing output and there are no
  // conflicting "commit the hook manually" messages (bootstrap will
  // commit it automatically in step 2).
  console.log(`  ${BOLD('1/4')} Installing hooks…`);
  installGitHook(cwd);
  installClaudeCodeHook(cwd);
  const rcPath = path.join(cwd, '.fixguardrc.json');
  if (!fs.existsSync(rcPath)) {
    fs.writeFileSync(rcPath, JSON.stringify({ ignore: [], defaultBlockLines: 20 }, null, 2) + '\n');
    console.log('    fixguard: wrote .fixguardrc.json');
  }

  // ── Step 2: selectively stage only the files init touched ────
  // We KNOW these files were potentially touched. We git-add only
  // these, never `git add .` — so the user's unrelated uncommitted
  // work is never swept into the bootstrap commit.
  const targetFiles = [];
  const resolved = resolvePreCommitPath(cwd);
  if (resolved.kind === 'husky' || resolved.kind === 'custom') {
    // For Husky / custom hooks paths, the hook file is tracked
    const rel = path.relative(cwd, resolved.path).replace(/\\/g, '/');
    targetFiles.push(rel);
  }
  targetFiles.push('.claude/settings.json');
  targetFiles.push('.fixguardrc.json');

  const toStage = existingFiles(cwd, targetFiles);

  if (skipCommit) {
    console.log('');
    console.log(DIM('  (--skip-commit: leaving changes in working tree for manual review)'));
  } else if (toStage.length === 0) {
    console.log('');
    console.log(DIM('  Nothing to commit (default .git/hooks/pre-commit install, not tracked)'));
  } else {
    console.log('');
    console.log(`  ${BOLD('2/4')} Committing hook install…`);
    try {
      // Stage ONLY the specific files fixguard created/modified.
      // Any of the user's other pending work stays untouched.
      for (const f of toStage) {
        try { git(`add "${f}"`, cwd); }
        catch { /* file may not exist if init skipped it */ }
      }

      // Check if staging actually produced any changes vs HEAD
      let stagedDiff = '';
      try { stagedDiff = git('diff --cached --name-only', cwd).trim(); }
      catch { stagedDiff = ''; }

      if (!stagedDiff) {
        console.log(DIM('    (no changes to commit — already installed and committed)'));
      } else {
        const files = stagedDiff.split('\n').filter(Boolean);
        const msg = 'chore: install fixguard pre-commit protection\n\n' +
                    'Added by `fixguard bootstrap`. These hooks protect bug\n' +
                    'fixes from being silently reverted by AI assistants.\n' +
                    'See https://github.com/ for details.';
        // Use -F stdin approach to avoid shell escaping nightmares
        const tmpMsg = path.join(require('os').tmpdir(), `fg-msg-${Date.now()}.txt`);
        fs.writeFileSync(tmpMsg, msg);
        try {
          git(`commit -q -F "${tmpMsg}"`, cwd);
        } finally {
          try { fs.unlinkSync(tmpMsg); } catch { /* best effort */ }
        }

        console.log(`    ${GREEN('✓')} committed ${files.length} file(s):`);
        for (const f of files) console.log(DIM(`      · ${f}`));
      }
    } catch (e) {
      // If commit fails (e.g. hook rejected, user has rebase in progress,
      // detached HEAD), fall back to printing manual instructions
      console.log('');
      console.log(YEL('  ⚠ automatic commit failed — please finish manually:'));
      console.log('');
      for (const f of toStage) console.log(`    git add ${f}`);
      console.log('    git commit -m "chore: install fixguard pre-commit protection"');
      console.log('');
      console.log(DIM(`  (reason: ${(e.message || String(e)).split('\n')[0]})`));
    }
  }

  // ── Step 3: run the first scan ────────────────────────────────
  if (skipScan) {
    console.log('');
    console.log(DIM('  (--skip-scan: .fixguard/scars.json not generated)'));
  } else {
    console.log('');
    console.log(`  ${BOLD('3/4')} Scanning git history for bug fixes…`);
    try {
      const result = await detectScars(cwd);
      writeScarMap(cwd, result);
      appendEvent(cwd, {
        type: 'scars.scan',
        scarCount: result.scars.length,
        fixCommits: result.fixCommitCount,
        scannedFiles: result.scannedFiles,
      });
      if (result.scars.length === 0) {
        console.log(`    ${DIM('(no bug-fix commits found yet — come back after you fix a few bugs)')}`);
      } else {
        console.log(`    ${GREEN('✓')} found ${BOLD(result.scars.length)} protected region(s) from ${result.fixCommitCount} fix commit(s)`);
      }
    } catch (e) {
      console.log(`    ${YEL('⚠ scan failed:')} ${e.message}`);
    }
  }

  // ── Step 4: summary ───────────────────────────────────────────
  console.log('');
  console.log(`  ${BOLD('4/4')} ${GREEN('Protection is live.')}`);
  console.log('');
  console.log(`  From this moment on:`);
  console.log(`    ${DIM('·')} every Claude Code ${BOLD('Read')} of a scarred file injects scar context`);
  console.log(`    ${DIM('·')} every ${BOLD('Edit')} targeting a scarred line is denied with a reason`);
  console.log(`    ${DIM('·')} every ${BOLD('git commit')} checks staged changes against the scar map`);
  console.log(`    ${DIM('·')} every bypass is audited to ${DIM('.fixguard/events.jsonl')}`);
  console.log('');
  console.log(`  ${BOLD('Try it:')}`);
  console.log(`    ${DIM('fixguard status')}                    ${DIM('# one-screen health check')}`);
  console.log(`    ${DIM('fixguard explain <path/to/file.js>')}  ${DIM('# see what is protected, in plain English')}`);
  console.log('');
}

module.exports = { bootstrap };
