// Regression test: check.js must skip archived scars the same way hook.js does.
// Before this fix, `fixguard check` would block commits on scars that had
// decayed below the archive threshold — stricter than the PreToolUse hook,
// which already ignored them. That inconsistency is exactly the kind of
// "the tool behaves differently in different places" friction that erodes
// trust.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-check-arch-'));
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function run(cmd, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, ...cmd.split(' ')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => resolve({ code, out, err }));
    proc.on('error', reject);
  });
}

test('check: archived scar does not block commit', async () => {
  const dir = tmpGitRepo();
  const filePath = path.join(dir, 'foo.js');

  // Initial commit
  fs.writeFileSync(filePath, 'function a() { return 1; }\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -q -m init', { cwd: dir, stdio: 'ignore' });

  // Plant a scar map with ONE scar, pre-archived
  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fixguard', 'scars.json'), JSON.stringify({
    scars: [{
      file: 'foo.js',
      startLine: 1,
      endLine: 1,
      sha: 'deadbeef',
      fullSha: 'deadbeef'.padEnd(40, 'a'),
      story: 'fix: would-block',
      date: '2025-12-03T04:00:00Z',
      score: 0.9,
    }],
  }));
  // And a weights file that marks that scar as archived
  fs.writeFileSync(path.join(dir, '.fixguard', 'weights.json'), JSON.stringify({
    version: 1,
    scars: {
      [('deadbeef'.padEnd(40, 'a'))]: {
        weight: 0.20,
        blockCount: 0,
        bypassCount: 10,
        allowCount: 0,
        archived: true,
        lastObserved: null,
      },
    },
  }));

  // Stage a modification to line 1
  fs.writeFileSync(filePath, 'function a() { return 2; }\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });

  const { code, err } = await run('check --staged', dir);

  // Should NOT block — archived scars are inactive
  assert.equal(code, 0, `expected exit 0, got ${code}. stderr: ${err}`);
});

test('check: non-archived scar still blocks commit', async () => {
  const dir = tmpGitRepo();
  const filePath = path.join(dir, 'foo.js');

  fs.writeFileSync(filePath, 'function a() { return 1; }\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -q -m init', { cwd: dir, stdio: 'ignore' });

  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fixguard', 'scars.json'), JSON.stringify({
    scars: [{
      file: 'foo.js',
      startLine: 1, endLine: 1,
      sha: 'healthy1',
      fullSha: 'healthy1'.padEnd(40, 'a'),
      story: 'fix: real',
      date: '2025-12-03T04:00:00Z',
      score: 0.9,
    }],
  }));
  // No weights file → default weight 1.0, not archived

  fs.writeFileSync(filePath, 'function a() { return 2; }\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });

  const { code } = await run('check --staged', dir);
  assert.equal(code, 1, 'non-archived scar should block commit');
});
