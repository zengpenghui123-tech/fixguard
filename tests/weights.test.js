const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadWeights, saveWeights, updateWeightsFromEvents,
  enrichWithWeights, ARCHIVE_THRESHOLD, INITIAL_WEIGHT,
} = require('../src/weights');
const { appendEvent } = require('../src/events');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-weights-'));
  fs.mkdirSync(path.join(dir, '.fixguard'), { recursive: true });
  return dir;
}

function scarMap(scars) {
  return {
    scars: scars.map(s => ({
      file: s.file || 'auth.js',
      startLine: s.startLine || 1,
      endLine: s.endLine || 1,
      sha: (s.fullSha || 'abc').slice(0, 8),
      fullSha: s.fullSha || 'abc'.padEnd(40, 'a'),
      story: s.story || 'fix: test',
      date: s.date || '2025-12-01T00:00:00Z',
      score: 0.9,
    })),
  };
}

test('weights: first load returns empty', () => {
  const dir = setup();
  const w = loadWeights(dir);
  assert.equal(Object.keys(w.scars).length, 0);
});

test('weights: save + load round trip', () => {
  const dir = setup();
  saveWeights(dir, {
    scars: {
      'abc12345': { weight: 0.8, blockCount: 3, bypassCount: 0, allowCount: 5, archived: false, lastObserved: null },
    },
  });
  const w = loadWeights(dir);
  assert.equal(w.scars.abc12345.weight, 0.8);
  assert.equal(w.scars.abc12345.blockCount, 3);
});

test('weights: block events reinforce the matching scar', () => {
  const dir = setup();
  const map = scarMap([{ fullSha: 'deadbeef'.padEnd(40, 'a') }]);
  // Log 3 deny events targeting that scar
  for (let i = 0; i < 3; i++) {
    appendEvent(dir, {
      type: 'hook.deny',
      file: 'auth.js',
      scarIds: ['deadbeef'.padEnd(40, 'a')],
    });
  }
  const delta = updateWeightsFromEvents(dir, map, 0);
  assert.equal(delta.reinforced, 3);
  const w = loadWeights(dir);
  const entry = w.scars['deadbeef'.padEnd(40, 'a')];
  // 1.0 + 3*0.05 = 1.15, clamped to 1.0
  assert.ok(entry.weight <= 1.0);
  assert.ok(entry.weight > INITIAL_WEIGHT - 0.01); // at least held at 1.0
  assert.equal(entry.blockCount, 3);
});

test('weights: bypass events erode the matching file', () => {
  const dir = setup();
  const map = scarMap([{ fullSha: 'baadbeef'.padEnd(40, 'a') }]);
  // 2 bypass events — 2 × 0.15 = 0.30 erosion
  for (let i = 0; i < 2; i++) {
    appendEvent(dir, { type: 'hook.bypassed', file: 'auth.js' });
  }
  updateWeightsFromEvents(dir, map, 0);
  const w = loadWeights(dir);
  const entry = w.scars['baadbeef'.padEnd(40, 'a')];
  assert.ok(entry.weight < INITIAL_WEIGHT);
  // 1.0 - 0.30 - 0.02 (base decay) = 0.68, within tolerance
  assert.ok(Math.abs(entry.weight - 0.68) < 0.01, `expected ~0.68, got ${entry.weight}`);
  assert.equal(entry.bypassCount, 2);
});

test('weights: heavy bypass auto-archives the scar', () => {
  const dir = setup();
  const map = scarMap([{ fullSha: 'gone1234'.padEnd(40, 'a') }]);
  // 5 bypasses × 0.15 = 0.75 erosion → 1.0 - 0.75 - 0.02 = 0.23 → below 0.30 threshold
  for (let i = 0; i < 5; i++) {
    appendEvent(dir, { type: 'hook.bypassed', file: 'auth.js' });
  }
  const delta = updateWeightsFromEvents(dir, map, 0);
  assert.equal(delta.archived, 1);
  const w = loadWeights(dir);
  const entry = w.scars['gone1234'.padEnd(40, 'a')];
  assert.ok(entry.archived);
  assert.ok(entry.weight < ARCHIVE_THRESHOLD);
});

test('weights: base decay on quiet scars (no events)', () => {
  const dir = setup();
  const map = scarMap([{ fullSha: 'quiet123'.padEnd(40, 'a') }]);
  // Pre-seed the weight so decay has something to chew on
  saveWeights(dir, { scars: { ['quiet123'.padEnd(40, 'a')]: { weight: 0.9, blockCount: 0, bypassCount: 0, allowCount: 0, archived: false, lastObserved: null } } });
  const delta = updateWeightsFromEvents(dir, map, Date.now() + 10);
  assert.ok(delta.decayed >= 1);
  const w = loadWeights(dir);
  // Should drop by ~0.02
  assert.ok(Math.abs(w.scars['quiet123'.padEnd(40, 'a')].weight - 0.88) < 0.001);
});

test('weights: enrichWithWeights populates scars with stored weights', () => {
  const dir = setup();
  const fullSha = 'enrich12'.padEnd(40, 'a');
  saveWeights(dir, { scars: { [fullSha]: { weight: 0.5, blockCount: 2, bypassCount: 1, allowCount: 10, archived: false, lastObserved: null } } });
  const map = scarMap([{ fullSha }]);
  enrichWithWeights(dir, map);
  assert.equal(map.scars[0].weight, 0.5);
  assert.equal(map.scars[0].blockCount, 2);
  assert.equal(map.scars[0].bypassCount, 1);
  assert.equal(map.scars[0].archived, false);
});

test('weights: reinforced scar escapes base decay in the same cycle', () => {
  const dir = setup();
  const fullSha = 'keep1234'.padEnd(40, 'a');
  const map = scarMap([{ fullSha }]);
  // Pre-seed
  saveWeights(dir, { scars: { [fullSha]: { weight: 0.90, blockCount: 0, bypassCount: 0, allowCount: 0, archived: false, lastObserved: null } } });
  // One block event
  appendEvent(dir, { type: 'hook.deny', file: 'auth.js', scarIds: [fullSha] });
  updateWeightsFromEvents(dir, map, 0);
  const w = loadWeights(dir);
  // Should be 0.90 + 0.05 = 0.95 (NOT 0.93 = 0.90 + 0.05 - 0.02)
  assert.ok(Math.abs(w.scars[fullSha].weight - 0.95) < 0.001,
    `expected 0.95 (reinforced without base decay), got ${w.scars[fullSha].weight}`);
});
