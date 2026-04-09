// Tests for `fixguard bootstrap` — the one-command full install.
//
// These tests exercise the ENTIRE install pipeline end-to-end in a
// real tmp git repo: install hooks, commit them, scan, verify state.
// They lock in the contract that a developer running `bootstrap` on
// a fresh project walks away with a fully protected, committed
// state — no manual git operations required.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { bootstrap } = require('../src/bootstrap');

function tmpHuskyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-bootstrap-'));
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email t@t', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name t', { cwd: dir, stdio: 'ignore' });
  // Husky 9+ layout
  fs.mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\nnpm test\n');
  fs.writeFileSync(path.join(dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\n');
  execSync('git config core.hooksPath .husky/_', { cwd: dir, stdio: 'ignore' });
  // Baseline content + one fix commit so scars detection has something to find
  fs.writeFileSync(path.join(dir, 'src.js'), 'function a() { if (!x) throw new Error("guard"); }\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -q -m "initial"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'src.js'), 'function a() { if (!x || x < 0) throw new Error("guard"); }\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -q -m "fix: critical guard clause for negative x"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function tmpPlainRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-bootstrap-plain-'));
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email t@t', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name t', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'x.js'), 'hello\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -q -m "initial"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'x.js'), 'world\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -q -m "fix: replace greeting with world"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function gitLog(cwd) {
  return execSync('git log --oneline', { cwd, encoding: 'utf8' }).trim().split('\n');
}

// Silence console output during tests (bootstrap prints a lot)
function captureConsole(fn) {
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
  }).then(() => out);
}

// ─── Husky project end-to-end ─────────────────────────────────────
test('bootstrap: Husky project → hook installed + committed + scanned', async () => {
  const dir = tmpHuskyRepo();
  const before = gitLog(dir);
  assert.equal(before.length, 2);

  await captureConsole(() => bootstrap(dir));

  // 1. A new commit was auto-added
  const after = gitLog(dir);
  assert.equal(after.length, 3, `expected 3 commits, got ${after.length}: ${after.join(' / ')}`);
  assert.match(after[0], /chore:.*fixguard/);

  // 2. .husky/pre-commit has fixguard line AND is tracked
  const huskyHook = fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8');
  assert.match(huskyHook, /fixguard-managed/);
  assert.match(huskyHook, /check --staged/);

  // 3. .claude/settings.json exists and has fixguard hook
  const claudeSettings = JSON.parse(
    fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')
  );
  assert.ok(Array.isArray(claudeSettings.hooks.PreToolUse));
  assert.ok(claudeSettings.hooks.PreToolUse.length > 0);

  // 4. .fixguardrc.json exists
  assert.ok(fs.existsSync(path.join(dir, '.fixguardrc.json')));

  // 5. scars.json was generated and contains the fix commit's scar
  const scarMap = JSON.parse(
    fs.readFileSync(path.join(dir, '.fixguard', 'scars.json'), 'utf8')
  );
  assert.ok(scarMap.scars.length >= 1, `expected ≥1 scar, got ${scarMap.scars.length}`);
  assert.ok(scarMap.fixCommitCount >= 1);

  // 6. events.jsonl has the scars.scan event
  const events = fs.readFileSync(path.join(dir, '.fixguard', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.type === 'scars.scan'));
});

// ─── Plain (non-Husky) project ────────────────────────────────────
test('bootstrap: plain repo → hook in .git/hooks, config files committed', async () => {
  const dir = tmpPlainRepo();
  const before = gitLog(dir);

  await captureConsole(() => bootstrap(dir));

  // Plain repo still gets a new commit for the config files
  // (.claude/settings.json + .fixguardrc.json) even though the
  // pre-commit hook itself lives in untracked .git/hooks/.
  const after = gitLog(dir);
  assert.equal(after.length, before.length + 1,
    `plain repo should commit config files; got ${after.length} vs ${before.length + 1}`);
  assert.match(after[0], /chore:.*fixguard/);

  // The .git/hooks/pre-commit file should exist (but is NOT in the commit,
  // since .git/ is never tracked by git itself)
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hookPath));
  const hookContent = fs.readFileSync(hookPath, 'utf8');
  assert.match(hookContent, /fixguard-managed/);

  // The commit should NOT reference .husky/pre-commit (there is none)
  const committedFiles = execSync('git show --name-only HEAD', { cwd: dir, encoding: 'utf8' });
  assert.ok(!committedFiles.includes('.husky'), 'plain repo commit must not reference .husky/');
});

// ─── Idempotency ──────────────────────────────────────────────────
test('bootstrap: second run on already-installed repo is safe', async () => {
  const dir = tmpHuskyRepo();
  await captureConsole(() => bootstrap(dir));
  const firstAfter = gitLog(dir);

  // Running bootstrap again should not error and should not
  // accidentally create duplicate commits or double-append hooks.
  await captureConsole(() => bootstrap(dir));
  const secondAfter = gitLog(dir);

  // No new commits (nothing to commit on second run)
  assert.equal(secondAfter.length, firstAfter.length,
    `second bootstrap should not add commits; got ${secondAfter.length} vs ${firstAfter.length}`);

  // Hook line should still appear exactly once, not twice
  const huskyHook = fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8');
  const markerCount = (huskyHook.match(/fixguard-managed/g) || []).length;
  assert.equal(markerCount, 1, 'fixguard marker must appear exactly once');
});

// ─── --skip-commit ────────────────────────────────────────────────
test('bootstrap: --skip-commit leaves changes in working tree', async () => {
  const dir = tmpHuskyRepo();
  const before = gitLog(dir);

  await captureConsole(() => bootstrap(dir, { skipCommit: true }));

  // No new commit
  const after = gitLog(dir);
  assert.equal(after.length, before.length);

  // But the hook IS modified in the working tree
  const huskyHook = fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8');
  assert.match(huskyHook, /fixguard-managed/);
});

// ─── --skip-scan ──────────────────────────────────────────────────
test('bootstrap: --skip-scan installs but does not generate scars.json', async () => {
  const dir = tmpHuskyRepo();
  await captureConsole(() => bootstrap(dir, { skipScan: true }));

  // Commit still happened
  const after = gitLog(dir);
  assert.equal(after.length, 3);

  // scars.json does NOT exist
  assert.ok(!fs.existsSync(path.join(dir, '.fixguard', 'scars.json')));
});
