// signals.js — multi-signal commit scoring
// Each commit gets evaluated against ~7 independent signals.
// A commit becomes a "scar source" only when its combined score passes
// the threshold. No single keyword can carry the decision alone.
//
// Design principle: bias toward recall (false positives are cheaper than
// false negatives — a missed scar = a real wound the AI doesn't see).
// But filter out obvious noise so the signal-to-noise ratio is usable.

// Single source of truth for the fix-keyword set. The SOURCE string is
// re-used by scars.js to build the `git log --grep` regex, which means
// the CLI's commit pre-filter and the scoring engine's keyword check can
// never drift apart.
const FIX_KEYWORDS_SOURCE = 'fix|bug|hotfix|patch|crash|broken|incident|emergency|regression|issue';
const FIX_KEYWORDS  = new RegExp(`\\b(${FIX_KEYWORDS_SOURCE})\\b`, 'i');
const REVERT_KEYWORDS = /\b(revert|rollback|undo)\b/i;
const NOISE_KEYWORDS = /\b(typo|lint|format|style|indent|whitespace|rename|cleanup|chore|comment|docs?)\b/i;
const MIXED_KEYWORDS = /\b(feat|feature|refactor|wip|merge)\b/i;

const TEST_FILE_PATTERN = /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.(js|ts|jsx|tsx|py|rb|go|java|rs)$/i;

// Guard-clause shapes — language-agnostic patterns of "defensive code"
// Returns are intentionally restrictive: a real guard returns a sentinel
// (null, error, false, bare return), not a computed value.
const GUARD_LINE_PATTERNS = [
  /^\s*if\s*[\(!]/,                           // if (...) / if !...
  /^\s*throw\b/,                              // throw new Error
  /^\s*raise\b/,                              // raise (python)
  /^\s*return\s*;/,                           // bare return;
  /^\s*return\s+(null|undefined|false|nil|None|err|error|new\s+Error)\b/i, // sentinel return
  /^\s*assert\b/,                             // assert
  /^\s*panic[\(!]/,                           // panic (rust/go)
  /^\s*abort\b/,                              // abort
  /^\s*\}\s*catch\b/,                         // } catch
  /^\s*except\b/,                             // python except
  /^\s*rescue\b/,                             // ruby rescue
];

const FUNC_LINE_PATTERNS = [
  /^\s*function\s+\w/,
  /^\s*(public|private|protected|static)?\s*(async\s+)?\w+\s*\([^)]*\)\s*[{:]/,
  /^\s*def\s+\w/,
  /^\s*func\s+\w/,
  /^\s*fn\s+\w/,
  /^\s*class\s+\w/,
];

const SCAR_THRESHOLD = 0.50; // commits scoring at or above this are scars

/**
 * Compute the diff shape — given the +added lines of a commit, classify
 * whether the commit is "guard-shaped" (defensive code) or "feature-shaped"
 * (new functions, broad expansion).
 *
 * Returns a number in [0, 1]: 0 = pure feature, 1 = pure guard.
 */
function diffShapeScore(addedLines) {
  if (!addedLines || addedLines.length === 0) return 0;
  let guard = 0;
  let func = 0;
  let total = 0;
  for (const raw of addedLines) {
    const stripped = raw.replace(/^\s+/, '');
    if (!stripped) continue;
    total++;
    for (const p of GUARD_LINE_PATTERNS) {
      if (p.test(raw)) { guard++; break; }
    }
    for (const p of FUNC_LINE_PATTERNS) {
      if (p.test(raw)) { func++; break; }
    }
  }
  if (total === 0) return 0;
  // Pure ratio: guards over (guards + functions)
  const denom = guard + func;
  if (denom === 0) {
    // No structural signal either way — neutral, lean slightly toward "not guard"
    return 0;
  }
  return guard / denom;
}

/**
 * Decide if a commit happens at an "unusual" time — late night or weekend.
 * Returns true if so. Uses local time of the iso string (best-effort).
 */
function isUnusualTime(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const day = d.getUTCDay(); // 0 = Sun, 6 = Sat (UTC — close enough)
  const hour = d.getUTCHours();
  const isWeekend = day === 0 || day === 6;
  const isNight = hour < 6 || hour >= 22;
  return isWeekend || isNight;
}

/**
 * Look at all commits sorted by date and check whether the given commit
 * was preceded by a revert within the last `daysWindow` days.
 */
function hasRecentRevert(commit, allCommitsByDate, daysWindow = 7) {
  const t = new Date(commit.date).getTime();
  if (isNaN(t)) return false;
  const windowMs = daysWindow * 24 * 60 * 60 * 1000;
  for (const c of allCommitsByDate) {
    if (c.sha === commit.sha) continue;
    const ct = new Date(c.date).getTime();
    if (isNaN(ct)) continue;
    if (ct >= t) continue;            // future or self
    if (ct < t - windowMs) continue;  // out of window (continue, not break — list isn't guaranteed sorted)
    if (REVERT_KEYWORDS.test(c.subject)) return true;
  }
  return false;
}

/**
 * Score one commit. Returns:
 *   { score, signals: { name: contribution, ... } }
 */
function scoreCommit(commit, allCommits) {
  const subject = commit.subject || '';
  const filesChanged = commit.filesChanged || [];
  const addedLines = commit.addedLines || [];
  const totalLineDelta = (commit.linesAdded || 0) + (commit.linesDeleted || 0);

  const signals = {};

  // ── Subject signals ────────────────────────────────────────────────
  const hasFix    = FIX_KEYWORDS.test(subject);
  const hasNoise  = NOISE_KEYWORDS.test(subject);
  const hasMixed  = MIXED_KEYWORDS.test(subject);

  if (hasFix && !hasNoise && !hasMixed)      signals.cleanFixKeyword = 0.40;
  else if (hasFix && hasMixed && !hasNoise)  signals.mixedFixKeyword = 0.20;
  else if (hasFix && hasNoise)               signals.dirtyFixKeyword = 0.05;

  if (hasNoise) signals.noisePenalty = -0.20;

  // ── Diff size signal ───────────────────────────────────────────────
  const isLarge = totalLineDelta >= 200;
  if (totalLineDelta > 0 && totalLineDelta < 30)        signals.smallDiff = 0.15;
  else if (totalLineDelta >= 30 && totalLineDelta < 100) signals.mediumDiff = 0.05;
  else if (isLarge)                                      signals.largeDiff = -0.20;

  // ── Combined penalty: a feat/refactor labeled commit with a large diff
  //    is almost always a feature, even if "fix" appears as a sub-bullet.
  //    Targeted at mixed-keyword + large-diff false positives.
  if (signals.mixedFixKeyword && isLarge) {
    signals.mixedLargeFalsePositive = -0.25;
  }

  // ── Diff shape signal (guard vs feature) ──────────────────────────
  if (addedLines.length > 0) {
    const shape = diffShapeScore(addedLines);
    if (shape > 0.6)      signals.guardShape   = 0.20;
    else if (shape > 0.3) signals.mixedShape   = 0.05;
    else if (shape < 0.1 && (commit.linesAdded || 0) > 50) signals.featureShape = -0.10;
  }

  // ── Test co-change ────────────────────────────────────────────────
  const touchesTest = filesChanged.some(f => TEST_FILE_PATTERN.test(f));
  const touchesSrc  = filesChanged.some(f => !TEST_FILE_PATTERN.test(f));
  if (touchesTest && touchesSrc) signals.testCoChange = 0.15;

  // ── Recent revert nearby ──────────────────────────────────────────
  if (allCommits && hasRecentRevert(commit, allCommits, 7)) {
    signals.recentRevert = 0.15;
  }

  // ── Unusual time (weekend/late-night) ─────────────────────────────
  if (isUnusualTime(commit.date) && hasFix) {
    signals.unusualTime = 0.05;
  }

  const score = Object.values(signals).reduce((a, b) => a + b, 0);
  return { score, signals };
}

module.exports = {
  scoreCommit,
  diffShapeScore,
  isUnusualTime,
  hasRecentRevert,
  SCAR_THRESHOLD,
  FIX_KEYWORDS,
  FIX_KEYWORDS_SOURCE,
  NOISE_KEYWORDS,
  REVERT_KEYWORDS,
  TEST_FILE_PATTERN,
};
