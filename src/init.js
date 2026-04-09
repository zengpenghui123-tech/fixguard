// init.js — install git pre-commit hook + Claude Code PreToolUse hook
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOOK_MARKER = '# fixguard-managed';

// Build the pre-commit hook body with a resolution chain that tries the
// absolute path to THIS installation first — so fixguard working on its
// own repository (or any repo where the user hasn't npm-linked) still
// actually runs the check instead of silently skipping. The absolute
// path is injected at install time and persists in the hook script.
function hookBody() {
  const cliAbs = path.resolve(__dirname, 'cli.js').replace(/\\/g, '/');
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by \`fixguard init\`. Remove this file to disable.
if [ -f "${cliAbs}" ]; then
  node "${cliAbs}" check --staged
elif command -v fixguard >/dev/null 2>&1; then
  fixguard check --staged
elif [ -f node_modules/.bin/fixguard ]; then
  node_modules/.bin/fixguard check --staged
else
  npx --no-install fixguard check --staged 2>/dev/null || {
    echo "fixguard: not installed, skipping check" >&2
  }
fi
`;
}

// Build the Node command that Claude Code will shell out to for hooks.
// We use the absolute path to this installation's cli.js so the hook works
// regardless of whether `fixguard` is on PATH.
function hookCommand() {
  const cliPath = path.resolve(__dirname, 'cli.js');
  // On Windows Claude Code expects cmd-wrapped commands; on posix bare node works.
  if (process.platform === 'win32') {
    return `cmd /c node "${cliPath}" hook`;
  }
  return `node "${cliPath}" hook`;
}

// Detect the real pre-commit hook location.
//
// Git lets a project override the default `.git/hooks/` via
// `core.hooksPath`. The most common use of this is **Husky**, which
// sets the hooks path to `.husky/_` (Husky 9+) or `.husky/` (older
// Husky) and keeps its hook scripts alongside the project source so
// they can be version-controlled.
//
// If we blindly write to `.git/hooks/pre-commit` on a Husky project,
// git will IGNORE our hook entirely — it only runs the path configured
// in core.hooksPath. This was a real compatibility bug discovered while
// validating fixguard on a real AlphaClaw-style project on 2026-04-09.
//
// Strategy:
//   1. Read `core.hooksPath` if set. If it points at `.husky/_` or
//      similar, the "real" Husky hook lives at `<cwd>/.husky/pre-commit`
//      (the PARENT of `.husky/_`, because Husky runs the outer file).
//   2. Otherwise, fall back to `<git-dir>/hooks/pre-commit`.
function resolvePreCommitPath(cwd) {
  let gitDir;
  try {
    gitDir = execSync('git rev-parse --git-dir', { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('not a git repository — run `git init` first');
  }
  if (!path.isAbsolute(gitDir)) gitDir = path.join(cwd, gitDir);

  // Detect Husky via core.hooksPath
  let hooksPathConfig = '';
  try {
    hooksPathConfig = execSync('git config --get core.hooksPath', {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* not set */ }

  if (hooksPathConfig) {
    // Normalize: Husky sets `.husky/_` (9+) or just `.husky` (older).
    // In both cases the user-visible hook file is `.husky/pre-commit`
    // (the OUTER file, not the one in the `_` subdirectory — that's
    // Husky's own bootstrap wrapper).
    const huskyHook = path.join(cwd, '.husky', 'pre-commit');
    if (fs.existsSync(path.dirname(huskyHook))) {
      return { path: huskyHook, kind: 'husky', hooksPathConfig };
    }
    // Non-Husky custom hooks path: honor it directly
    const customHook = path.isAbsolute(hooksPathConfig)
      ? path.join(hooksPathConfig, 'pre-commit')
      : path.join(cwd, hooksPathConfig, 'pre-commit');
    return { path: customHook, kind: 'custom', hooksPathConfig };
  }

  // Default: .git/hooks/pre-commit
  return { path: path.join(gitDir, 'hooks', 'pre-commit'), kind: 'default' };
}

function installGitHook(cwd) {
  const resolved = resolvePreCommitPath(cwd);
  const hookPath = resolved.path;
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });

  // Build the fixguard-check line we need to inject
  const cliAbs = path.resolve(__dirname, 'cli.js').replace(/\\/g, '/');
  const fixguardLine = `node "${cliAbs}" check --staged || exit 1`;

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_MARKER)) {
      console.log(`fixguard: pre-commit hook already installed (${resolved.kind}).`);
      return;
    }
    // Existing hook — append fixguard check at the end. Husky and other
    // hook chains run top-to-bottom; appending means we run after their
    // existing checks, which is fine because all we need is ONE chance
    // to block the commit before git finalizes it.
    const appended = existing.replace(/\s*$/, '') +
      `\n\n${HOOK_MARKER}\n${fixguardLine}\n`;
    fs.writeFileSync(hookPath, appended);
    try { fs.chmodSync(hookPath, 0o755); } catch { /* windows */ }
    const where = path.relative(cwd, hookPath);
    console.log(`fixguard: appended check to existing ${resolved.kind} pre-commit hook → ${where}`);
    return;
  }

  // No existing hook — create a fresh one using the standard template
  fs.writeFileSync(hookPath, hookBody());
  try { fs.chmodSync(hookPath, 0o755); } catch { /* windows */ }
  const where = path.relative(cwd, hookPath);
  console.log(`fixguard: installed ${resolved.kind} pre-commit hook → ${where}`);
}

// Merge fixguard's Claude Code hook entry into the project's .claude/settings.json
// without clobbering any existing hooks.
function installClaudeCodeHook(cwd) {
  const claudeDir = path.join(cwd, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      console.warn(`fixguard: ${path.relative(cwd, settingsPath)} is not valid JSON, leaving it alone.`);
      return;
    }
  }

  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

  const cmd = hookCommand();

  // Check if a fixguard entry already exists (by command substring)
  const already = settings.hooks.PreToolUse.some(entry =>
    entry && Array.isArray(entry.hooks) && entry.hooks.some(h =>
      h && typeof h.command === 'string' && /\bcli\.js["']?\s+hook\b/.test(h.command) && h.command.includes('fixguard')
    )
  );

  if (already) {
    console.log('fixguard: Claude Code hook already installed in .claude/settings.json');
    return;
  }

  settings.hooks.PreToolUse.push({
    matcher: 'Read|Edit|Write|MultiEdit',
    hooks: [{
      type: 'command',
      command: cmd,
      timeout: 5000,
    }],
  });

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`fixguard: installed Claude Code hook → ${path.relative(cwd, settingsPath)}`);
}

async function init(cwd) {
  installGitHook(cwd);
  installClaudeCodeHook(cwd);

  // Drop a sample .fixguardrc.json if missing
  const rc = path.join(cwd, '.fixguardrc.json');
  if (!fs.existsSync(rc)) {
    fs.writeFileSync(rc, JSON.stringify({ ignore: [], defaultBlockLines: 20 }, null, 2) + '\n');
    console.log('fixguard: wrote .fixguardrc.json');
  }

  console.log('');
  console.log('Next steps:');
  console.log('  1. Run `fixguard scars` to auto-detect scars from git history');
  console.log('  2. (Optional) Add `// @fix [tag] "reason"` markers for anything git history does not cover');
  console.log('  3. Commit `.fixguard/scars.json` so your team + AI share the same map');
  console.log('');
  console.log('Claude Code integration is now active:');
  console.log('  · Reading a scarred file → AI sees scar context as a system message');
  console.log('  · Editing a scarred line → blocked with a reason the AI reads');
  console.log('  · Writing over a scarred file → blocked entirely');
  console.log('  · Bypass (logged): set FIXGUARD_BYPASS=1 before the session');
}

module.exports = { init, installGitHook, installClaudeCodeHook, hookCommand };
