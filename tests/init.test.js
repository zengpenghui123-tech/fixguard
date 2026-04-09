// Tests for init.js — specifically the Husky detection path.
// Discovered during live validation on a real Husky-based production
// project on 2026-04-09: initial version of installGitHook wrote to
// .git/hooks/pre-commit but Husky-using projects set
// core.hooksPath=.husky/_ which made git ignore the default location
// entirely. These tests lock in the fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const {
  resolvePreCommitPath,
  installGitHook,
  hookBody,
  HOOK_MARKER,
} = require('../src/init');

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-init-'));
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

// ─── resolvePreCommitPath ─────────────────────────────────────────
test('resolve: default repo → .git/hooks/pre-commit', () => {
  const dir = tmpGitRepo();
  const r = resolvePreCommitPath(dir);
  assert.equal(r.kind, 'default');
  assert.ok(r.path.endsWith('pre-commit'));
  assert.ok(r.path.includes('.git'));
});

test('resolve: Husky project → .husky/pre-commit', () => {
  const dir = tmpGitRepo();
  // Simulate Husky 9+ layout
  fs.mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
  // Write the Husky bootstrap wrapper (the file git actually runs)
  fs.writeFileSync(path.join(dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\n');
  execSync('git config core.hooksPath .husky/_', { cwd: dir, stdio: 'ignore' });
  // Create the outer pre-commit file that Husky's wrapper sources
  fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\nnpm test\n');

  const r = resolvePreCommitPath(dir);
  assert.equal(r.kind, 'husky');
  assert.ok(r.path.endsWith(path.join('.husky', 'pre-commit')));
  // Should NOT be the inner wrapper at .husky/_/pre-commit
  assert.ok(!r.path.includes(path.join('.husky', '_')));
});

test('resolve: custom hooksPath (not Husky) → that path', () => {
  const dir = tmpGitRepo();
  fs.mkdirSync(path.join(dir, 'my-hooks'), { recursive: true });
  execSync('git config core.hooksPath my-hooks', { cwd: dir, stdio: 'ignore' });

  const r = resolvePreCommitPath(dir);
  // Since there's no .husky/, Husky detection should NOT fire.
  assert.equal(r.kind, 'custom');
  assert.ok(r.path.endsWith(path.join('my-hooks', 'pre-commit')));
});

test('resolve: not a git repo → throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-init-nogit-'));
  assert.throws(() => resolvePreCommitPath(dir), /not a git repository/);
});

// ─── installGitHook: fresh install ────────────────────────────────
test('install: fresh default repo → creates hook with marker + absolute path', () => {
  const dir = tmpGitRepo();
  installGitHook(dir);

  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hookPath));
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes(HOOK_MARKER));
  // Must contain an absolute path to cli.js as the first branch of the fallback
  assert.match(content, /node\s+"[^"]*cli\.js"\s+check\s+--staged/);
});

// ─── installGitHook: existing Husky hook ──────────────────────────
test('install: existing Husky hook → appends fixguard check at the end', () => {
  const dir = tmpGitRepo();
  fs.mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
  execSync('git config core.hooksPath .husky/_', { cwd: dir, stdio: 'ignore' });

  const huskyPath = path.join(dir, '.husky', 'pre-commit');
  const originalBody = '#!/bin/sh\nnpm test\nnpx eslint src/\n';
  fs.writeFileSync(huskyPath, originalBody);

  installGitHook(dir);

  const content = fs.readFileSync(huskyPath, 'utf8');
  // Original content must be preserved
  assert.ok(content.includes('npm test'));
  assert.ok(content.includes('eslint src/'));
  // Fixguard marker must be appended
  assert.ok(content.includes(HOOK_MARKER));
  // Fixguard line must come AFTER the original content
  const originalEnd = content.indexOf('eslint src/');
  const markerStart = content.indexOf(HOOK_MARKER);
  assert.ok(markerStart > originalEnd, 'fixguard must be appended, not prepended');
});

// ─── installGitHook: idempotent ───────────────────────────────────
test('install: second run is idempotent', () => {
  const dir = tmpGitRepo();
  installGitHook(dir);
  const first = fs.readFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  installGitHook(dir);
  const second = fs.readFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.equal(first, second, 'second install must not modify anything');
});

test('install: Husky second run is also idempotent', () => {
  const dir = tmpGitRepo();
  fs.mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
  execSync('git config core.hooksPath .husky/_', { cwd: dir, stdio: 'ignore' });
  const huskyPath = path.join(dir, '.husky', 'pre-commit');
  fs.writeFileSync(huskyPath, '#!/bin/sh\nnpm test\n');

  installGitHook(dir);
  const first = fs.readFileSync(huskyPath, 'utf8');
  installGitHook(dir);
  const second = fs.readFileSync(huskyPath, 'utf8');
  assert.equal(first, second, 'Husky second install must not double-append');
});

// ─── hookBody: the absolute cli.js path is there ──────────────────
test('hookBody: always contains absolute path to cli.js as first branch', () => {
  const body = hookBody();
  assert.match(body, /\[ -f "[^"]+cli\.js" \]/);
  assert.match(body, /node "[^"]+cli\.js" check --staged/);
  assert.match(body, /command -v fixguard/);
  assert.match(body, /node_modules\/\.bin\/fixguard/);
});
