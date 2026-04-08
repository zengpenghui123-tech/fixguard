// weights.js — mutable learned state for each scar.
//
// scars.json is a DERIVED file (rebuilt from git history on every scan).
// Weights and hit-counts need to survive scan regenerations, so they live
// in a separate file keyed by full scar sha.
//
// This is the "self-correction" layer: scars that keep being blocked get
// reinforced; scars that keep being bypassed decay and eventually archive.
const fs = require('fs');
const path = require('path');
const { readEvents } = require('./events');

const WEIGHTS_VERSION = 1;

// Tunables (could move to config later if user wants to override)
const BASE_DECAY_PER_SLEEP  = 0.02;   // natural forgetting
const BLOCK_REINFORCEMENT   = 0.05;   // per deny event touching this scar
const BYPASS_EROSION        = 0.15;   // per bypass event on this scar's file
const ARCHIVE_THRESHOLD     = 0.30;   // hook stops injecting below this
const INITIAL_WEIGHT        = 1.00;

function weightsPath(cwd) {
  return path.join(cwd, '.fixguard', 'weights.json');
}

function loadWeights(cwd) {
  const p = weightsPath(cwd);
  if (!fs.existsSync(p)) {
    return { version: WEIGHTS_VERSION, scars: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed.scars) parsed.scars = {};
    return parsed;
  } catch {
    return { version: WEIGHTS_VERSION, scars: {} };
  }
}

function saveWeights(cwd, data) {
  const p = weightsPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: WEIGHTS_VERSION,
    generatedAt: new Date().toISOString(),
    scars: data.scars || {},
  }, null, 2));
}

// Return a weight entry for a given scar sha, creating it at default if missing.
function ensureEntry(weights, fullSha) {
  if (!weights.scars[fullSha]) {
    weights.scars[fullSha] = {
      weight: INITIAL_WEIGHT,
      blockCount: 0,
      bypassCount: 0,
      allowCount: 0,
      lastObserved: null,
      archived: false,
    };
  }
  return weights.scars[fullSha];
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Apply one sleep cycle's updates to the weights, using events in the
// given time window. Returns summary of what changed.
function updateWeightsFromEvents(cwd, scarMap, sinceMs) {
  const weights = loadWeights(cwd);
  const events = readEvents(cwd, { since: sinceMs });

  // Build a lookup: file → [scars in that file]
  const scarsByFile = new Map();
  if (scarMap && Array.isArray(scarMap.scars)) {
    for (const s of scarMap.scars) {
      if (!scarsByFile.has(s.file)) scarsByFile.set(s.file, []);
      scarsByFile.get(s.file).push(s);
    }
  }

  let reinforced = 0, eroded = 0, decayed = 0, archived = 0, unarchived = 0;

  // Process each event that affects weights
  for (const e of events) {
    const ts = typeof e.t === 'number' ? new Date(e.t).toISOString() : null;
    if (e.type === 'hook.deny' && Array.isArray(e.scarIds)) {
      for (const sha of e.scarIds) {
        const entry = ensureEntry(weights, sha);
        entry.blockCount++;
        entry.weight = clamp01(entry.weight + BLOCK_REINFORCEMENT);
        entry.lastObserved = ts;
        reinforced++;
      }
    } else if (e.type === 'hook.allow_with_context' && e.file) {
      for (const s of scarsByFile.get(e.file) || []) {
        const entry = ensureEntry(weights, s.fullSha || s.sha);
        entry.allowCount++;
        entry.lastObserved = ts;
      }
    } else if (e.type === 'hook.bypassed' && e.file) {
      // Bypass is file-level — penalize every scar in that file, slightly.
      // Heavier penalty than base decay so repeated bypasses archive fast.
      for (const s of scarsByFile.get(e.file) || []) {
        const entry = ensureEntry(weights, s.fullSha || s.sha);
        entry.bypassCount++;
        entry.weight = clamp01(entry.weight - BYPASS_EROSION);
        entry.lastObserved = ts;
        eroded++;
      }
    }
  }

  // Base decay — every known scar loses a little weight per sleep,
  // representing natural forgetting. Only scars that were reinforced this
  // cycle escape the decay.
  const nowIso = new Date().toISOString();
  const reinforcedThisCycle = new Set();
  for (const e of events) {
    if (e.type === 'hook.deny' && Array.isArray(e.scarIds)) {
      for (const sha of e.scarIds) reinforcedThisCycle.add(sha);
    }
  }
  for (const sha of Object.keys(weights.scars)) {
    if (reinforcedThisCycle.has(sha)) continue;
    const entry = weights.scars[sha];
    entry.weight = clamp01(entry.weight - BASE_DECAY_PER_SLEEP);
    decayed++;
  }

  // Archive scars below threshold; unarchive if they climb back
  for (const sha of Object.keys(weights.scars)) {
    const entry = weights.scars[sha];
    const shouldArchive = entry.weight < ARCHIVE_THRESHOLD;
    if (shouldArchive && !entry.archived) {
      entry.archived = true;
      archived++;
    } else if (!shouldArchive && entry.archived) {
      entry.archived = false;
      unarchived++;
    }
  }

  saveWeights(cwd, weights);

  return {
    eventsProcessed: events.length,
    reinforced, eroded, decayed, archived, unarchived,
    totalTracked: Object.keys(weights.scars).length,
  };
}

// Enrich a scar map's array with weight data in-place.
// Each scar gets: .weight (default 1.0), .archived (default false), .blockCount, .bypassCount.
function enrichWithWeights(cwd, scarMap) {
  if (!scarMap || !Array.isArray(scarMap.scars)) return scarMap;
  const weights = loadWeights(cwd);
  for (const s of scarMap.scars) {
    const entry = weights.scars[s.fullSha || s.sha];
    if (entry) {
      s.weight = entry.weight;
      s.archived = entry.archived;
      s.blockCount = entry.blockCount;
      s.bypassCount = entry.bypassCount;
    } else {
      s.weight = INITIAL_WEIGHT;
      s.archived = false;
      s.blockCount = 0;
      s.bypassCount = 0;
    }
  }
  return scarMap;
}

module.exports = {
  loadWeights,
  saveWeights,
  updateWeightsFromEvents,
  enrichWithWeights,
  WEIGHTS_VERSION,
  ARCHIVE_THRESHOLD,
  INITIAL_WEIGHT,
};
