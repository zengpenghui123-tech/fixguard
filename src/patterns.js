// patterns.js — REM-style cross-scar pattern detection.
//
// Looks at the blood log for scars that get blocked in the SAME session.
// A pair of scars that co-occurs in ≥2 distinct sessions is promoted to
// a "pattern" — suggesting architectural coupling, a shared root cause,
// or a bug that spans multiple files.
//
// Design principle (from DESIGN.md §6.3 / REM phase):
//   "A pattern found in only one session is a coincidence. A pattern
//    that repeats is signal."
//
// Storage is append-only style: patterns.json keeps cumulative
// co-occurrence counts and timestamps, never forgetting unless a pattern
// is explicitly cleared.
const fs = require('fs');
const path = require('path');
const { readEvents } = require('./events');

const PATTERN_CONFIRMATION_THRESHOLD = 2; // min distinct sessions
const PATTERNS_VERSION = 1;

function patternsPath(cwd) {
  return path.join(cwd, '.fixguard', 'patterns.json');
}

function loadPatterns(cwd) {
  const p = patternsPath(cwd);
  if (!fs.existsSync(p)) {
    return { version: PATTERNS_VERSION, pairs: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed.pairs) parsed.pairs = {};
    return parsed;
  } catch {
    return { version: PATTERNS_VERSION, pairs: {} };
  }
}

function savePatterns(cwd, data) {
  const p = patternsPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: PATTERNS_VERSION,
    generatedAt: new Date().toISOString(),
    pairs: data.pairs || {},
  }, null, 2));
}

// Canonicalize a pair of shas → sorted "short1|short2" key.
function pairKey(a, b) {
  const [x, y] = [a, b].sort();
  return `${x}|${y}`;
}

// Group deny events by session_id → Set<scarSha>.
// Only denies are used for pattern detection — they are the highest-
// confidence "these scars were both actively touched" signal.
function groupDeniesBySession(events) {
  const sessions = new Map();
  for (const e of events) {
    if (e.type !== 'hook.deny') continue;
    if (!Array.isArray(e.scarIds) || e.scarIds.length === 0) continue;
    const sid = e.session || '__no_session__';
    if (!sessions.has(sid)) sessions.set(sid, new Set());
    const set = sessions.get(sid);
    for (const sha of e.scarIds) set.add(sha);
  }
  return sessions;
}

// From a session → scar-set map, compute all pair co-occurrences.
// Returns Map<pairKey, { count, scarA, scarB }>.
function countCoOccurrences(sessions) {
  const pairs = new Map();
  for (const [sid, scarSet] of sessions) {
    const scars = [...scarSet];
    if (scars.length < 2) continue;
    for (let i = 0; i < scars.length; i++) {
      for (let j = i + 1; j < scars.length; j++) {
        const a = scars[i];
        const b = scars[j];
        const key = pairKey(a, b);
        if (!pairs.has(key)) {
          const [x, y] = [a, b].sort();
          pairs.set(key, { count: 0, scarA: x, scarB: y });
        }
        pairs.get(key).count++;
      }
    }
  }
  return pairs;
}

// Main REM pass: fold new events into cumulative patterns.
// Patterns that cross the confirmation threshold are returned separately
// so the dream report can flag them as "newly confirmed."
function updatePatternsFromEvents(cwd, sinceMs) {
  const events = readEvents(cwd, { since: sinceMs, type: 'hook.deny' });
  const sessions = groupDeniesBySession(events);
  const newPairs = countCoOccurrences(sessions);

  const stored = loadPatterns(cwd);
  const newlyConfirmed = [];
  const now = new Date().toISOString();

  for (const [key, data] of newPairs) {
    const existing = stored.pairs[key];
    if (existing) {
      const wasBelowThreshold = existing.count < PATTERN_CONFIRMATION_THRESHOLD;
      existing.count += data.count;
      existing.lastSeen = now;
      if (wasBelowThreshold && existing.count >= PATTERN_CONFIRMATION_THRESHOLD) {
        newlyConfirmed.push({ ...existing });
      }
    } else {
      stored.pairs[key] = {
        scarA: data.scarA,
        scarB: data.scarB,
        count: data.count,
        firstSeen: now,
        lastSeen: now,
      };
      if (data.count >= PATTERN_CONFIRMATION_THRESHOLD) {
        newlyConfirmed.push({ ...stored.pairs[key] });
      }
    }
  }

  savePatterns(cwd, stored);

  const confirmedPatterns = Object.values(stored.pairs)
    .filter(p => p.count >= PATTERN_CONFIRMATION_THRESHOLD)
    .sort((a, b) => b.count - a.count);

  return {
    totalPairsSeen: Object.keys(stored.pairs).length,
    confirmedCount: confirmedPatterns.length,
    newlyConfirmed,
    topPatterns: confirmedPatterns.slice(0, 10),
  };
}

// Look up scar objects for a pair of full-shas (for dream report rendering).
function resolvePair(pair, scarMap) {
  if (!scarMap || !Array.isArray(scarMap.scars)) return null;
  const findBy = sha => scarMap.scars.find(s => (s.fullSha || s.sha) === sha || (s.fullSha || s.sha).startsWith(sha));
  return {
    a: findBy(pair.scarA),
    b: findBy(pair.scarB),
    count: pair.count,
  };
}

module.exports = {
  updatePatternsFromEvents,
  loadPatterns,
  savePatterns,
  resolvePair,
  pairKey,
  PATTERN_CONFIRMATION_THRESHOLD,
};
