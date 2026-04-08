const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendEvent, readEvents, countEvents, eventsPath } = require('../src/events');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fg-events-'));
}

test('events: append + read round-trip', () => {
  const dir = tmp();
  appendEvent(dir, { type: 'scars.scan', scarCount: 10 });
  appendEvent(dir, { type: 'hook.deny', tool: 'Edit', file: 'auth.js' });
  const events = readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'scars.scan');
  assert.equal(events[0].scarCount, 10);
  assert.equal(events[1].type, 'hook.deny');
  assert.ok(typeof events[0].t === 'number');
});

test('events: readEvents honors --limit', () => {
  const dir = tmp();
  for (let i = 0; i < 10; i++) {
    appendEvent(dir, { type: 'test', i });
  }
  const last3 = readEvents(dir, { limit: 3 });
  assert.equal(last3.length, 3);
  assert.equal(last3[0].i, 7);
  assert.equal(last3[2].i, 9);
});

test('events: readEvents honors since filter', () => {
  const dir = tmp();
  appendEvent(dir, { type: 'old' });
  const cutoff = Date.now() + 1;
  // Wait a tick so the next event has a later timestamp
  const start = Date.now();
  while (Date.now() === start) { /* spin 1ms */ }
  appendEvent(dir, { type: 'new' });
  const recent = readEvents(dir, { since: cutoff });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].type, 'new');
});

test('events: readEvents honors type filter (single)', () => {
  const dir = tmp();
  appendEvent(dir, { type: 'a' });
  appendEvent(dir, { type: 'b' });
  appendEvent(dir, { type: 'a' });
  const as = readEvents(dir, { type: 'a' });
  assert.equal(as.length, 2);
});

test('events: readEvents honors type filter (array)', () => {
  const dir = tmp();
  appendEvent(dir, { type: 'a' });
  appendEvent(dir, { type: 'b' });
  appendEvent(dir, { type: 'c' });
  const ab = readEvents(dir, { type: ['a', 'b'] });
  assert.equal(ab.length, 2);
});

test('events: countEvents matches readEvents.length', () => {
  const dir = tmp();
  appendEvent(dir, { type: 'x' });
  appendEvent(dir, { type: 'y' });
  assert.equal(countEvents(dir), 2);
  assert.equal(countEvents(dir, { type: 'x' }), 1);
});

test('events: missing cwd / bad input is silent', () => {
  const dir = tmp();
  appendEvent(dir, null);
  appendEvent(dir, {}); // no type
  appendEvent(null, { type: 'a' });
  const events = readEvents(dir);
  assert.equal(events.length, 0);
});

test('events: malformed lines in existing log are skipped, not fatal', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(eventsPath(dir), [
    JSON.stringify({ t: 1, type: 'good' }),
    'not-json-garbage',
    JSON.stringify({ t: 2, type: 'also-good' }),
  ].join('\n') + '\n');
  const events = readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'good');
  assert.equal(events[1].type, 'also-good');
});

test('events: hook FIXGUARD_BYPASS=1 emits a hook.bypassed audit event', async () => {
  const { spawn } = require('child_process');
  const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

  const dir = tmp();
  const filePath = path.join(dir, 'auth.js');
  fs.writeFileSync(filePath, 'if (!x) throw new Error("bad");\n');
  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fixguard', 'scars.json'), JSON.stringify({
    scars: [{
      file: 'auth.js', startLine: 1, endLine: 1,
      sha: 'deadbeef', fullSha: 'deadbeef'.padEnd(40, 'a'),
      story: 'fix: guard', date: '2025-12-03T04:00:00Z', score: 0.9,
    }],
  }));

  await new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, 'hook'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FIXGUARD_BYPASS: '1' },
    });
    proc.on('close', resolve);
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: 'if (!x) throw new Error("bad");', new_string: '' },
      cwd: dir,
      session_id: 'bypass-test',
    }));
    proc.stdin.end();
  });

  const events = readEvents(dir);
  const bypassed = events.filter(e => e.type === 'hook.bypassed');
  assert.equal(bypassed.length, 1);
  assert.equal(bypassed[0].tool, 'Edit');
  assert.equal(bypassed[0].file, filePath);
  assert.equal(bypassed[0].session, 'bypass-test');
});

test('events: hook integration — deny emits a hook.deny event', async () => {
  const { spawn } = require('child_process');
  const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

  const dir = tmp();
  const filePath = path.join(dir, 'auth.js');
  fs.writeFileSync(filePath, [
    'function a() {}',
    '  if (!payload.iat) throw new Error("bad");',
  ].join('\n'));
  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fixguard', 'scars.json'), JSON.stringify({
    scars: [{
      file: 'auth.js', startLine: 2, endLine: 2,
      sha: 'abc12345', fullSha: 'abc12345aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      story: 'fix: iat', date: '2025-12-03T04:00:00Z', score: 0.9,
    }],
  }));

  // Run hook with a Write request that should deny
  await new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, 'hook'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.on('close', resolve);
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: 'replaced' },
      cwd: dir,
    }));
    proc.stdin.end();
  });

  const events = readEvents(dir);
  const denyEvents = events.filter(e => e.type === 'hook.deny');
  assert.equal(denyEvents.length, 1);
  assert.equal(denyEvents[0].tool, 'Write');
  assert.equal(denyEvents[0].file, 'auth.js');
});
