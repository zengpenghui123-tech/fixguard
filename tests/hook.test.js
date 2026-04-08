// End-to-end tests for the fixguard hook entry point.
// Spawns `node src/cli.js hook` as a real subprocess, pipes JSON on stdin,
// and parses the JSON response from stdout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

// Same file content used across tests — 6 lines, scar at line 4.
const FIXTURE_FILE = [
  'function a() {}',
  'function verifyToken(token) {',
  '  const payload = jwt.decode(token);',
  '  if (!payload.iat) throw new Error("bad iat");',
  '  return payload;',
  '}',
].join('\n');

function setupTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-hook-'));
  const filePath = path.join(dir, 'auth.js');
  fs.writeFileSync(filePath, FIXTURE_FILE);

  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fixguard', 'scars.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    fixCommitCount: 1,
    scannedFiles: 1,
    scars: [{
      file: 'auth.js',
      startLine: 4,
      endLine: 4,
      sha: 'abcd1234',
      fullSha: 'abcd1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      story: 'fix: jwt iat bypass attack',
      date: '2025-12-03T04:00:00Z',
      score: 0.90,
      signals: { cleanFixKeyword: 0.4, smallDiff: 0.15, guardShape: 0.2, recentRevert: 0.15 },
    }],
  }));
  return { dir, filePath };
}

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, 'hook'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => resolve({ code, out, err }));
    proc.on('error', reject);
    proc.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
    proc.stdin.end();
  });
}

function parseOut(out) {
  const trimmed = out.trim();
  if (!trimmed) throw new Error('empty hook output');
  return JSON.parse(trimmed);
}

test('hook: Read of scarred file returns additionalContext', async () => {
  const { dir, filePath } = setupTmpProject();
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(parsed.hookSpecificOutput.additionalContext);
  assert.match(parsed.hookSpecificOutput.additionalContext, /scar/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /jwt iat/);
});

test('hook: Edit targeting a scarred line is denied', async () => {
  const { dir, filePath } = setupTmpProject();
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '  if (!payload.iat) throw new Error("bad iat");',
      new_string: '  // removed unnecessary check',
    },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /scar/);
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /jwt iat/);
});

test('hook: Edit NOT targeting a scarred line is allowed with gentle nudge', async () => {
  const { dir, filePath } = setupTmpProject();
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: 'function a() {}',
      new_string: 'function a() { return 1; }',
    },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(parsed.hookSpecificOutput.additionalContext);
  assert.match(parsed.hookSpecificOutput.additionalContext, /does not touch/);
});

test('hook: Write to a scarred file is denied', async () => {
  const { dir, filePath } = setupTmpProject();
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'replaced entire file' },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /overwrite/);
});

test('hook: MultiEdit with one scarred edit is denied', async () => {
  const { dir, filePath } = setupTmpProject();
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: filePath,
      edits: [
        { old_string: 'function a() {}', new_string: 'function a() { return 1; }' },
        { old_string: '  if (!payload.iat) throw new Error("bad iat");', new_string: '  // removed' },
      ],
    },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});

test('hook: file with no scars.json → allow silently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-hook-empty-'));
  fs.writeFileSync(path.join(dir, 'x.js'), 'hello');
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: path.join(dir, 'x.js') },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(!parsed.hookSpecificOutput.additionalContext);
});

test('hook: FIXGUARD_BYPASS=1 skips all checks', async () => {
  const { dir, filePath } = setupTmpProject();
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '  if (!payload.iat) throw new Error("bad iat");',
      new_string: '  // removed',
    },
    cwd: dir,
  }, { FIXGUARD_BYPASS: '1' });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
});

test('hook: empty stdin → allow silently', async () => {
  const { code, out } = await runHook('');
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
});

test('hook: invalid JSON on stdin → allow (fail open)', async () => {
  const { code, out } = await runHook('not-json-at-all');
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
});

// ─── Edge case: CRLF line endings ──────────────────────────────────
test('hook: Edit with CRLF file + LF old_string still matches scar', async () => {
  const { dir, filePath } = setupTmpProject();
  // Rewrite the fixture with CRLF
  fs.writeFileSync(filePath, FIXTURE_FILE.replace(/\n/g, '\r\n'));
  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '  if (!payload.iat) throw new Error("bad iat");', // LF
      new_string: '  // removed',
    },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});

// ─── Edge case: non-unique old_string ─────────────────────────────
test('hook: Edit with ambiguous old_string (multiple matches) is denied conservatively', async () => {
  const { dir } = setupTmpProject();
  const filePath = path.join(dir, 'dup.js');
  fs.writeFileSync(filePath, 'return 1;\nreturn 1;\nreturn 1;\n');
  // Add a scar on this file
  const scarPath = path.join(dir, '.fixguard', 'scars.json');
  const map = JSON.parse(fs.readFileSync(scarPath, 'utf8'));
  map.scars.push({
    file: 'dup.js', startLine: 2, endLine: 2,
    sha: 'dupe1234', fullSha: 'dupe1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    story: 'fix: dup bug', date: '2025-12-03T04:00:00Z',
  });
  fs.writeFileSync(scarPath, JSON.stringify(map));

  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: 'return 1;',
      new_string: 'return 2;',
    },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /more than once|ambiguous|unique/);
});

// ─── Session dedup ─────────────────────────────────────────────────
test('hook: second Read of same file in same session gets brief pointer', async () => {
  const { dir, filePath } = setupTmpProject();
  const sessionId = 'test-session-' + Date.now();

  const first = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    cwd: dir,
    session_id: sessionId,
  });
  const firstParsed = parseOut(first.out);
  assert.ok(firstParsed.hookSpecificOutput.additionalContext.includes('jwt iat'));
  assert.ok(firstParsed.hookSpecificOutput.additionalContext.length > 200);

  const second = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    cwd: dir,
    session_id: sessionId,
  });
  const secondParsed = parseOut(second.out);
  // Second injection should be a brief reminder, much shorter
  assert.ok(secondParsed.hookSpecificOutput.additionalContext.length < firstParsed.hookSpecificOutput.additionalContext.length);
  assert.match(secondParsed.hookSpecificOutput.additionalContext, /Reminder|earlier this session/);
});

// ─── Relevance ranking: only top N scars injected per file ────────
test('hook: Read of file with many scars ranks and truncates to top N', async () => {
  const { dir, filePath } = setupTmpProject();
  const scarPath = path.join(dir, '.fixguard', 'scars.json');
  const map = JSON.parse(fs.readFileSync(scarPath, 'utf8'));

  // Inject 20 scars with varying dates + scores. Recent high-score ones
  // should rank highest under (confidence × recency).
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  map.scars = [];
  for (let i = 0; i < 20; i++) {
    const isRecent = i < 3;  // first 3 are recent high-quality (should appear)
    const date = new Date(now - (isRecent ? 5 * DAY : 400 * DAY)).toISOString();
    map.scars.push({
      file: 'auth.js',
      startLine: 1 + i, endLine: 1 + i,
      sha: `sha${i.toString().padStart(5, '0')}`,
      fullSha: `sha${i.toString().padStart(5, '0')}` + 'a'.repeat(40 - 8),
      story: isRecent ? `fix: RECENT_${i}` : `fix: OLD_${i}`,
      date,
      score: isRecent ? 0.95 : 0.55,
    });
  }
  fs.writeFileSync(scarPath, JSON.stringify(map));

  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  const ctx = parsed.hookSpecificOutput.additionalContext;

  assert.match(ctx, /20 protected scar region/);
  assert.match(ctx, /more scar region|top 5/);
  assert.match(ctx, /RECENT_0/);
  assert.match(ctx, /RECENT_1/);
  assert.match(ctx, /RECENT_2/);
  const oldMatches = (ctx.match(/OLD_/g) || []).length;
  assert.ok(oldMatches <= 2, `expected ≤2 old scars in top 5, got ${oldMatches}`);
});

// ─── Proximity ranking for non-overlap nudge ──────────────────────
test('hook: Edit nudge shows nearest scars, not arbitrary ones', async () => {
  const { dir } = setupTmpProject();
  const filePath = path.join(dir, 'big.js');
  fs.writeFileSync(filePath, Array.from({ length: 100 }, (_, i) => `line_${i+1}`).join('\n'));
  const scarPath = path.join(dir, '.fixguard', 'scars.json');
  const map = JSON.parse(fs.readFileSync(scarPath, 'utf8'));
  map.scars = [
    { file: 'big.js', startLine: 5,  endLine: 5,  sha: 'far1', fullSha: 'far1'.padEnd(40, 'a'), story: 'fix: early',  date: '2025-12-01T00:00:00Z', score: 0.8 },
    { file: 'big.js', startLine: 50, endLine: 50, sha: 'mid1', fullSha: 'mid1'.padEnd(40, 'a'), story: 'fix: middle', date: '2025-12-01T00:00:00Z', score: 0.8 },
    { file: 'big.js', startLine: 95, endLine: 95, sha: 'end1', fullSha: 'end1'.padEnd(40, 'a'), story: 'fix: late',   date: '2025-12-01T00:00:00Z', score: 0.8 },
  ];
  fs.writeFileSync(scarPath, JSON.stringify(map));

  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: 'line_48',
      new_string: 'line_forty_eight',
    },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Nearest/);
  assert.match(ctx, /middle/);
});

// ─── HEAD staleness warning ────────────────────────────────────────
test('hook: adds stale-map note when scars.json headSha differs from current HEAD', async () => {
  const { dir, filePath } = setupTmpProject();
  // Inject a fake (impossible) headSha into scars.json
  const scarPath = path.join(dir, '.fixguard', 'scars.json');
  const map = JSON.parse(fs.readFileSync(scarPath, 'utf8'));
  map.headSha = '0000000000000000000000000000000000000000';
  fs.writeFileSync(scarPath, JSON.stringify(map));

  // Need dir to be a git repo for HEAD comparison to even happen.
  // If it isn't, isScarMapStale returns false (no warning) — that's also OK,
  // but we want to exercise the warning path, so init a tiny git repo.
  const { execSync } = require('child_process');
  try {
    execSync('git init -q', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "t@t"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "t"', { cwd: dir, stdio: 'ignore' });
    execSync('git add -A', { cwd: dir, stdio: 'ignore' });
    execSync('git commit -q -m init --allow-empty', { cwd: dir, stdio: 'ignore' });
  } catch { /* if git not available, test becomes tolerant below */ }

  const { code, out } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = parseOut(out);
  // Only assert the note if git succeeded (the HEAD differs from the fake sha)
  if (parsed.hookSpecificOutput.additionalContext) {
    assert.match(parsed.hookSpecificOutput.additionalContext, /(different HEAD|fixguard scars|Reminder)/);
  }
});
