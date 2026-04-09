// Tests for the commit-time bypass path in check.js.
//
// Discovered during self-validation on 2026-04-09: check.js was
// silently early-returning on FIXGUARD_BYPASS=1 without emitting any
// events. That broke the symmetry with hook.js (PreToolUse bypass)
// and meant the learning ring (weights.js) never eroded scars that
// were being overridden at commit time — only scars overridden at
// Claude Code edit time.
//
// These tests lock in the fix: commit-time bypass must emit
// hook.bypassed events, one per unique violated file, so sleep.js
// can feed them into the weight-decay loop on the next cycle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-bypass-'));
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

// Run the CLI with the given args + env, return { code, out, err }
function runCli(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => resolve({ code, out, err }));
    proc.on('error', reject);
  });
}

function readEventsFile(cwd) {
  const p = path.join(cwd, '.fixguard', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Plant a scar on a given line of a committed file
function setupRepoWithScar(fileName, fileContent, scarLines) {
  const dir = tmpGitRepo();
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fileContent);
  execSync(`git add .`, { cwd: dir, stdio: 'ignore' });
  execSync(`git commit -q -m init`, { cwd: dir, stdio: 'ignore' });

  // Plant the scar map manually (faster than running a real fixguard scars)
  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fixguard', 'scars.json'), JSON.stringify({
    scars: [{
      file: fileName,
      startLine: scarLines[0],
      endLine: scarLines[1],
      sha: 'dead1234',
      fullSha: 'dead1234'.padEnd(40, 'a'),
      story: 'fix: plant-for-test',
      date: '2026-01-01T00:00:00Z',
      score: 0.9,
    }],
  }));

  return { dir, filePath };
}

// ─── Core bypass test ──────────────────────────────────────────────
test('bypass: violation + FIXGUARD_BYPASS=1 emits one hook.bypassed event per file', async () => {
  const { dir, filePath } = setupRepoWithScar(
    'src/auth.js',
    'function a() {}\nif (!x) throw new Error("guard")\nreturn null;\n',
    [2, 2]
  );

  // Modify the scarred line and stage it
  fs.writeFileSync(filePath, 'function a() {}\n// removed\nreturn null;\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });

  // Run check with bypass
  const { code, err } = await runCli(['check', '--staged'], dir, { FIXGUARD_BYPASS: '1' });

  // Must succeed (exit 0) despite the violation
  assert.equal(code, 0, `expected bypass to pass commit, got exit ${code}. stderr:\n${err}`);

  // Bypass warning must be visible
  assert.match(err, /BYPASS active/);
  assert.match(err, /violation\(s\) silently overridden/);

  // And an event must have been emitted
  const events = readEventsFile(dir);
  const bypassEvents = events.filter(e => e.type === 'hook.bypassed');
  assert.equal(bypassEvents.length, 1);
  assert.equal(bypassEvents[0].file, 'src/auth.js');
  assert.equal(bypassEvents[0].tool, 'git-commit');
  assert.match(bypassEvents[0].reason, /FIXGUARD_BYPASS=1/);
});

// ─── Silent bypass (no violations) emits NO event ─────────────────
test('bypass: no violations → bypass is silent, no event noise', async () => {
  const { dir, filePath } = setupRepoWithScar(
    'src/safe.js',
    'function a() {}\nfunction b() {}\nfunction c() {}\n',
    [2, 2]  // scar on line 2
  );

  // Modify line 1, NOT the scar line
  fs.writeFileSync(filePath, 'function aa() {}\nfunction b() {}\nfunction c() {}\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });

  const { code } = await runCli(['check', '--staged'], dir, { FIXGUARD_BYPASS: '1' });
  assert.equal(code, 0);

  const events = readEventsFile(dir);
  const bypassEvents = events.filter(e => e.type === 'hook.bypassed');
  assert.equal(bypassEvents.length, 0, 'empty bypass (no violation) must not pollute the log');
});

// ─── Multiple files bypassed → one event per unique file ──────────
test('bypass: multi-file violation → one hook.bypassed event per file', async () => {
  const dir = tmpGitRepo();

  // Two files, each with content and each with a scar
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'line1\nguard_a\nline3\n');
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'line1\nguard_b\nline3\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -q -m init', { cwd: dir, stdio: 'ignore' });

  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fixguard', 'scars.json'), JSON.stringify({
    scars: [
      { file: 'src/a.js', startLine: 2, endLine: 2, sha: 'a0000000', fullSha: 'a0000000'.padEnd(40, 'a'), story: 'fix: a', date: '2026-01-01T00:00:00Z', score: 0.9 },
      { file: 'src/b.js', startLine: 2, endLine: 2, sha: 'b0000000', fullSha: 'b0000000'.padEnd(40, 'b'), story: 'fix: b', date: '2026-01-01T00:00:00Z', score: 0.9 },
    ],
  }));

  // Modify BOTH scarred lines
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'line1\n// removed a\nline3\n');
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'line1\n// removed b\nline3\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });

  const { code } = await runCli(['check', '--staged'], dir, { FIXGUARD_BYPASS: '1' });
  assert.equal(code, 0);

  const events = readEventsFile(dir);
  const bypassEvents = events.filter(e => e.type === 'hook.bypassed');
  assert.equal(bypassEvents.length, 2, 'expected one bypass event per unique violated file');
  const files = bypassEvents.map(e => e.file).sort();
  assert.deepEqual(files, ['src/a.js', 'src/b.js']);
});

// ─── Without bypass: violations still block (regression) ──────────
test('bypass: without FIXGUARD_BYPASS, violation still blocks commit (exit 1)', async () => {
  const { dir, filePath } = setupRepoWithScar(
    'src/c.js',
    'line1\nguard\nline3\n',
    [2, 2]
  );
  fs.writeFileSync(filePath, 'line1\n// removed\nline3\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });

  const { code } = await runCli(['check', '--staged'], dir);
  assert.equal(code, 1, 'without bypass, violation must block');

  const events = readEventsFile(dir);
  const bypassEvents = events.filter(e => e.type === 'hook.bypassed');
  assert.equal(bypassEvents.length, 0, 'block path must not emit bypass events');
});

// ─── Event must be processable by weights.js ──────────────────────
test('bypass: emitted event shape is compatible with weights.js expectations', async () => {
  const { dir, filePath } = setupRepoWithScar(
    'src/shape.js',
    'line1\nguard\nline3\n',
    [2, 2]
  );
  fs.writeFileSync(filePath, 'line1\n// removed\nline3\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  await runCli(['check', '--staged'], dir, { FIXGUARD_BYPASS: '1' });

  // Now run the weights update and verify the scar was eroded
  const { updateWeightsFromEvents } = require('../src/weights');
  const { loadScarMap } = require('../src/scars');
  const scarMap = loadScarMap(dir);
  assert.ok(scarMap && scarMap.scars.length === 1);

  const result = updateWeightsFromEvents(dir, scarMap, 0);
  assert.ok(result.eroded >= 1, 'weights.js must have processed the commit-time bypass');

  // Verify the specific scar weight dropped
  const { loadWeights } = require('../src/weights');
  const w = loadWeights(dir);
  const entry = w.scars['dead1234'.padEnd(40, 'a')];
  assert.ok(entry, 'weight entry should exist after update');
  assert.ok(entry.weight < 1.0, `weight should have decayed, got ${entry.weight}`);
  assert.equal(entry.bypassCount, 1);
});
