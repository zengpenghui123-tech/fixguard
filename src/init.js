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

function installGitHook(cwd) {
  let gitDir;
  try {
    gitDir = execSync('git rev-parse --git-dir', { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('not a git repository — run `git init` first');
  }
  if (!path.isAbsolute(gitDir)) gitDir = path.join(cwd, gitDir);

  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_MARKER)) {
      console.log('fixguard: pre-commit hook already installed.');
    } else {
      const append = `\n${HOOK_MARKER}\nfixguard check --staged || exit 1\n`;
      fs.appendFileSync(hookPath, append);
      console.log('fixguard: appended check to existing pre-commit hook.');
    }
  } else {
    fs.writeFileSync(hookPath, hookBody());
    try { fs.chmodSync(hookPath, 0o755); } catch { /* windows */ }
    console.log(`fixguard: installed pre-commit hook → ${path.relative(cwd, hookPath)}`);
  }
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
