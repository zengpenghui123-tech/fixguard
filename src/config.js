// config.js — single source of truth for user-tunable settings.
// Reads .fixguardrc.json if present, falls back to defaults. Cached per cwd.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Extra file patterns the user wants to skip (in addition to built-ins)
  ignore: [],
  // Scar confidence threshold. Lower = more sensitive (more scars, maybe noisier).
  scarThreshold: 0.50,
  // How many git blame processes to run in parallel during a scan
  blameConcurrency: 8,
  // Max size of a file we'll run blame on (bytes). Large files are usually generated.
  maxFileBytes: 512 * 1024,
  // How many days a session cache entry survives before GC
  sessionCacheTtlDays: 7,
  // For marker-based (@fix) protection: default lines-to-protect after a shorthand marker
  defaultBlockLines: 20,
  // Max scars per injection — if a file has more than this, the hook ranks by
  // (confidence * recency) and only shows the top N, preventing context bloat.
  maxScarsPerInjection: 5,
  // Recency half-life in days for scar ranking (older scars decay exponentially)
  recencyHalfLifeDays: 180,
};

const _cache = new Map(); // cwd → merged config

function loadConfig(cwd) {
  if (_cache.has(cwd)) return _cache.get(cwd);
  const rcPath = path.join(cwd, '.fixguardrc.json');
  let user = {};
  if (fs.existsSync(rcPath)) {
    try {
      user = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
    } catch {
      // Malformed → ignore silently rather than blocking anyone's work
    }
  }
  const merged = { ...DEFAULTS, ...user };
  // Always arrays, even if user wrote something weird
  if (!Array.isArray(merged.ignore)) merged.ignore = [];
  _cache.set(cwd, merged);
  return merged;
}

// For tests / long-running processes that need to pick up config changes
function clearCache() { _cache.clear(); }

module.exports = { loadConfig, clearCache, DEFAULTS };
