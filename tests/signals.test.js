const test = require('node:test');
const assert = require('node:assert');
const {
  scoreCommit,
  diffShapeScore,
  isUnusualTime,
  hasRecentRevert,
  buildFixRegex,
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

// ── REGRESSION: "fix + new test file" should not trip largeDiff ──────
// Discovered during fixguard self-application on 2026-04-09. A real fix
// commit that bundled a 113-line regression test file with a 4-line
// check.js modification scored 0.40 because totalDelta > 100 and the
// old logic treated new-file content as "large refactor." With the
// modified-delta-only size bucket, the same commit scores cleanly.
test('scoreCommit: fix + new test file uses modification delta only', () => {
  const commit = {
    sha: 'a',
    date: '2026-04-09T01:15:24Z',
    subject: 'fix: archived scars leaked into commit-time check',
    filesChanged: ['src/check.js', 'tests/check-archived.test.js'],
    // Back-compat total:
    linesAdded: 117, linesDeleted: 0,
    // New breakdown:
    modifiedLinesAdded: 4,     // the actual fix in check.js
    modifiedLinesDeleted: 0,
    newFileLinesAdded: 113,    // the brand-new test file
    addedLines: [
      '      if (s.archived) continue;',
      '  // respect weight-based archival',
    ],
  };
  const { score, signals } = scoreCommit(commit, [commit]);
  assert.equal(signals.smallDiff, 0.15, 'modified portion is small → smallDiff');
  assert.ok(!signals.largeDiff, 'must not penalize as large refactor');
  assert.equal(signals.cleanFixKeyword, 0.40);
  assert.equal(signals.testCoChange, 0.15);
  assert.ok(score >= SCAR_THRESHOLD, `expected ≥ ${SCAR_THRESHOLD}, got ${score}`);
});

// Ensure the fallback path (no breakdown provided) still works correctly —
// old test cases that predate the new-file tracking must keep passing.
test('scoreCommit: commits without new-file breakdown fall back to total delta', () => {
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z', subject: 'fix: tight fix',
    filesChanged: ['src/a.js'],
    linesAdded: 5, linesDeleted: 2,
    // no modifiedLinesAdded / newFileLinesAdded → fallback path
    addedLines: ['  if (!x) throw new Error("bad")'],
  };
  const { signals } = scoreCommit(commit, [commit]);
  assert.equal(signals.smallDiff, 0.15);
});

// ── buildFixRegex: Latin-boundary helper for non-English support ─
test('buildFixRegex: English "fix" matches inside "fix: jwt"', () => {
  const re = buildFixRegex('fix|bug');
  assert.ok(re.test('fix: jwt iat bypass'));
});

test('buildFixRegex: English "fix" does NOT match inside "prefix"', () => {
  const re = buildFixRegex('fix|bug');
  assert.ok(!re.test('prefix refactor'));
});

test('buildFixRegex: Chinese "修复" matches inside "修复登录bug"', () => {
  const re = buildFixRegex('修复|修正');
  assert.ok(re.test('修复登录bug'));
});

test('buildFixRegex: Japanese "バグ修正" matches inside full sentence', () => {
  const re = buildFixRegex('バグ修正|修正');
  assert.ok(re.test('バグ修正: ログインフォームの null チェック'));
});

test('buildFixRegex: Korean "버그" matches with space neighbors', () => {
  const re = buildFixRegex('버그|수정');
  assert.ok(re.test('버그 수정: 로그인 문제'));
});

test('buildFixRegex: mixing English and CJK in one pattern', () => {
  const re = buildFixRegex('fix|bug|修复|バグ修正|Fehler');
  assert.ok(re.test('fix: something'));
  assert.ok(re.test('修复登录'));
  assert.ok(re.test('バグ修正'));
  assert.ok(re.test('Fehler behoben'));
  assert.ok(!re.test('prefix only'));
  assert.ok(!re.test('no keyword here'));
});

// ── i18n: custom fix-keyword regex lets non-English teams work ───
// Discovered as a silent-failure mode on 2026-04-09 discussion: the
// default English regex fails entirely on Chinese / Japanese / German
// commit messages. These tests lock in the opts.fixKeywords override
// path so non-English teams can use fixguard without forking it.
test('scoreCommit: Chinese commit matches custom Chinese fixKeywords regex', () => {
  const customRe = buildFixRegex('fix|bug|修复|修正');
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z',
    subject: '修复登录页面的 race condition',
    filesChanged: ['src/auth.js', 'tests/auth.test.js'],
    modifiedLinesAdded: 5, modifiedLinesDeleted: 2, newFileLinesAdded: 0,
    linesAdded: 5, linesDeleted: 2,
    addedLines: ['  if (!token) throw new Error("no token")'],
  };
  const { score, signals } = scoreCommit(commit, [commit], { fixKeywords: customRe });
  assert.ok(signals.cleanFixKeyword === 0.40, 'Chinese "修复" must match custom regex');
  assert.ok(signals.smallDiff === 0.15);
  assert.ok(signals.testCoChange === 0.15);
  assert.ok(score >= SCAR_THRESHOLD);
});

test('scoreCommit: Chinese commit does NOT match default English-only regex', () => {
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z',
    subject: '修复登录页面的 race condition',
    filesChanged: ['src/auth.js'],
    modifiedLinesAdded: 5, modifiedLinesDeleted: 2, newFileLinesAdded: 0,
    linesAdded: 5, linesDeleted: 2,
    addedLines: ['  if (!token) throw new Error("no token")'],
  };
  const { signals } = scoreCommit(commit, [commit]); // no opts → default English regex
  assert.ok(!signals.cleanFixKeyword, 'default regex must not match Chinese-only subject');
  assert.ok(!signals.mixedFixKeyword);
  assert.ok(!signals.dirtyFixKeyword);
});

test('scoreCommit: custom regex with fallback English still matches English commits', () => {
  // Union pattern: user keeps English defaults AND adds their language
  const customRe = buildFixRegex('fix|bug|hotfix|修复|修正|バグ修正');
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z',
    subject: 'fix: english still works',
    filesChanged: ['src/a.js'],
    modifiedLinesAdded: 3, modifiedLinesDeleted: 0, newFileLinesAdded: 0,
    linesAdded: 3, linesDeleted: 0,
    addedLines: ['  if (!x) throw new Error("bad")'],
  };
  const { signals } = scoreCommit(commit, [commit], { fixKeywords: customRe });
  assert.ok(signals.cleanFixKeyword === 0.40);
});

test('scoreCommit: Japanese "バグ修正" matches when configured', () => {
  const customRe = buildFixRegex('fix|バグ修正|修正');
  const commit = {
    sha: 'a', date: '2026-04-08T14:00:00Z',
    subject: 'バグ修正: ログインフォームの null チェック',
    filesChanged: ['src/auth.js', 'tests/auth.test.js'],
    modifiedLinesAdded: 4, modifiedLinesDeleted: 0, newFileLinesAdded: 0,
    linesAdded: 4, linesDeleted: 0,
    addedLines: ['  if (!user) return null;'],
  };
  const { signals, score } = scoreCommit(commit, [commit], { fixKeywords: customRe });
  assert.ok(signals.cleanFixKeyword === 0.40);
  assert.ok(score >= SCAR_THRESHOLD);
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
