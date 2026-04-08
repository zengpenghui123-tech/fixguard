const test = require('node:test');
const assert = require('node:assert');
const {
  scoreCommit,
  diffShapeScore,
  isUnusualTime,
  hasRecentRevert,
  SCAR_THRESHOLD,
} = require('../src/signals');

// ─── diffShapeScore ────────────────────────────────────────────────
test('diffShapeScore: pure guard clauses → high', () => {
  const lines = [
    '  if (!user) throw new Error("no user")',
    '  if (token.exp < now) return null',
    '  if (!payload.iat) throw new Error("bad iat")',
  ];
  assert.ok(diffShapeScore(lines) > 0.8);
});

test('diffShapeScore: pure new functions → low', () => {
  const lines = [
    'function newFeature() {',
    '  return computeSomething();',
    '}',
    'function anotherOne() {',
    '  return 42;',
    '}',
  ];
  assert.ok(diffShapeScore(lines) < 0.5);
});

test('diffShapeScore: empty → 0', () => {
  assert.equal(diffShapeScore([]), 0);
  assert.equal(diffShapeScore(['', '   ']), 0);
});

// ─── isUnusualTime ─────────────────────────────────────────────────
test('isUnusualTime: 3am UTC → true', () => {
  assert.equal(isUnusualTime('2026-04-08T03:00:00Z'), true);
});

test('isUnusualTime: 2pm Tuesday UTC → false', () => {
  assert.equal(isUnusualTime('2026-04-07T14:00:00Z'), false);
});

test('isUnusualTime: invalid → false', () => {
  assert.equal(isUnusualTime(''), false);
  assert.equal(isUnusualTime(null), false);
  assert.equal(isUnusualTime('not-a-date'), false);
});

// ─── hasRecentRevert ───────────────────────────────────────────────
test('hasRecentRevert: revert 2 days before → true', () => {
  const commit = { sha: 'a', date: '2026-04-08T12:00:00Z', subject: 'fix: bug' };
  const all = [
    commit,
    { sha: 'b', date: '2026-04-06T12:00:00Z', subject: 'Revert "broken feature"' },
  ];
  assert.equal(hasRecentRevert(commit, all, 7), true);
});

test('hasRecentRevert: no revert in window → false', () => {
  const commit = { sha: 'a', date: '2026-04-08T12:00:00Z', subject: 'fix: bug' };
  const all = [
    commit,
    { sha: 'b', date: '2026-03-01T12:00:00Z', subject: 'Revert old' },
  ];
  assert.equal(hasRecentRevert(commit, all, 7), false);
});

// ─── scoreCommit: end-to-end ───────────────────────────────────────
test('scoreCommit: textbook real fix passes threshold', () => {
  const commit = {
    sha: 'a', date: '2026-04-08T03:30:00Z', subject: 'fix: jwt iat bypass attack',
    filesChanged: ['src/auth.js', 'tests/auth.test.js'],
    linesAdded: 8, linesDeleted: 2,
    addedLines: [
      '  if (!payload.iat || payload.iat > now) throw new Error("bad iat")',
      '  if (!payload.exp) throw new Error("missing exp")',
    ],
  };
  const { score, signals } = scoreCommit(commit, [commit]);
  assert.ok(score >= SCAR_THRESHOLD, `expected ≥ ${SCAR_THRESHOLD}, got ${score}`);
  assert.ok(signals.cleanFixKeyword > 0);
  assert.ok(signals.smallDiff > 0);
  assert.ok(signals.testCoChange > 0);
  assert.ok(signals.guardShape > 0);
});

test('scoreCommit: typo fix does NOT pass threshold', () => {
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z', subject: 'fix typo in comment',
    filesChanged: ['README.md'],
    linesAdded: 1, linesDeleted: 1,
    addedLines: ['// corrected spelling'],
  };
  const { score } = scoreCommit(commit, [commit]);
  assert.ok(score < SCAR_THRESHOLD, `typo fix should not be a scar, got ${score}`);
});

test('scoreCommit: large refactor with "fix" in message does NOT pass', () => {
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z', subject: 'refactor: extract helpers, fix naming',
    filesChanged: Array.from({ length: 20 }, (_, i) => `src/file${i}.js`),
    linesAdded: 800, linesDeleted: 600,
    addedLines: Array.from({ length: 200 }, (_, i) => `function helper${i}() { return ${i}; }`),
  };
  const { score } = scoreCommit(commit, [commit]);
  assert.ok(score < SCAR_THRESHOLD, `refactor should not be a scar, got ${score}`);
});

test('scoreCommit: feat with hidden fix gets reduced credit', () => {
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z', subject: 'feat: new dashboard, fix login bug',
    filesChanged: ['src/dashboard.js'],
    linesAdded: 50, linesDeleted: 5,
    addedLines: [
      'function newDashboard() {',
      '  return view;',
      '}',
    ],
  };
  const { signals } = scoreCommit(commit, [commit]);
  assert.ok(signals.mixedFixKeyword === 0.20);
  assert.ok(!signals.cleanFixKeyword);
});

test('scoreCommit: pure feat without fix gets nothing', () => {
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z', subject: 'feat: add user profile page',
    filesChanged: ['src/profile.js'],
    linesAdded: 80, linesDeleted: 0,
    addedLines: ['function profile() { return {}; }'],
  };
  const { score } = scoreCommit(commit, [commit]);
  assert.ok(score < SCAR_THRESHOLD);
});

// ─── REGRESSION: AlphaClaw "feat: Sentry monitoring..." false positive ──
// This was a feat commit with a sub-bullet "fix free-count route" that
// scored 0.55 with the original heuristic and contributed 174 scars.
// The combined mixed+large penalty must filter it out.
test('scoreCommit: large feat-with-sub-fix is filtered by combined penalty', () => {
  const commit = {
    sha: 'a',
    date: '2026-04-02T03:00:00Z',
    subject: 'feat: Sentry monitoring, unit tests, render.js modularization, fix free-count route',
    filesChanged: ['static/index.js', 'tests/sentry.test.js', 'package.json', 'routes/api.js'],
    linesAdded: 600,
    linesDeleted: 200,
    addedLines: [
      'function initSentry() {',
      '  Sentry.init({',
      '    dsn: process.env.SENTRY_DSN,',
      '  });',
      '  if (!window.sentryReady) throw new Error("not ready");',
      '}',
    ],
  };
  const allCommits = [
    commit,
    { sha: 'b', date: '2026-04-01T10:00:00Z', subject: 'Revert "broken feature"' },
  ];
  const { score, signals } = scoreCommit(commit, allCommits);
  assert.ok(signals.mixedFixKeyword === 0.20);
  assert.ok(signals.largeDiff === -0.20);
  assert.ok(signals.mixedLargeFalsePositive === -0.25);
  assert.ok(score < SCAR_THRESHOLD,
    `large feat-with-fix should be filtered, got ${score}`);
});

// Make sure the combined penalty does NOT affect clean large fixes
test('scoreCommit: clean large security fix still passes', () => {
  const commit = {
    sha: 'a',
    date: '2026-04-08T03:00:00Z',
    subject: 'fix: critical SQL injection across all endpoints',
    filesChanged: ['src/db.js', 'src/api.js', 'tests/db.test.js'],
    linesAdded: 250,
    linesDeleted: 100,
    addedLines: Array.from({ length: 50 }, () => 'if (!isValid(input)) throw new Error("bad input")'),
  };
  const { score, signals } = scoreCommit(commit, [commit]);
  assert.ok(signals.cleanFixKeyword === 0.40);
  assert.ok(signals.largeDiff === -0.20);
  assert.ok(!signals.mixedLargeFalsePositive);
  assert.ok(score >= SCAR_THRESHOLD,
    `clean large security fix should pass, got ${score}`);
});
