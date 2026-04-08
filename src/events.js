// events.js — append-only event log ("blood layer").
//
// Every meaningful fixguard action emits a line to .fixguard/events.jsonl.
// This is the single structural entry point for real-time signals: hook
// decisions, scans, sleeps, and (eventually) test outcomes + commit events.
//
// Read side is intentionally small for v1 — sleep.js and future analytics
// will consume the stream via readEvents(). The point of introducing the
// layer now is to make future organs possible without retrofitting.
const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 10 * 1024 * 1024; // rotate when > 10MB
const KEEP_ROTATIONS = 3;

function eventsPath(cwd) {
  return path.join(cwd, '.fixguard', 'events.jsonl');
}

// Write one event. Best-effort: a failing append must never block fixguard
// from doing its actual job.
function appendEvent(cwd, event) {
  if (!cwd || !event || !event.type) return;
  const p = eventsPath(cwd);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({ t: Date.now(), ...event }) + '\n';
    fs.appendFileSync(p, line);
    maybeRotate(p);
  } catch { /* swallow */ }
}

function maybeRotate(p) {
  let st;
  try { st = fs.statSync(p); }
  catch { return; }
  if (st.size < MAX_LOG_BYTES) return;

  const dir = path.dirname(p);
  // Shift: events.N.jsonl → events.N+1.jsonl, deleting the oldest
  for (let i = KEEP_ROTATIONS; i >= 1; i--) {
    const from = i === 1 ? p : path.join(dir, `events.${i - 1}.jsonl`);
    const to = path.join(dir, `events.${i}.jsonl`);
    if (!fs.existsSync(from)) continue;
    if (i === KEEP_ROTATIONS && fs.existsSync(to)) {
      try { fs.unlinkSync(to); } catch {}
    }
    try { fs.renameSync(from, to); } catch {}
  }
}

// Read all events from the current log (rotations are not included).
// Returns array of parsed event objects, oldest first.
function readEvents(cwd, opts = {}) {
  const p = eventsPath(cwd);
  if (!fs.existsSync(p)) return [];
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); }
    catch { /* skip malformed line */ }
  }
  let filtered = out;
  if (typeof opts.since === 'number') {
    filtered = filtered.filter(e => e.t >= opts.since);
  }
  if (opts.type) {
    const t = opts.type;
    filtered = filtered.filter(e => e.type === t || (Array.isArray(t) && t.includes(e.type)));
  }
  if (typeof opts.limit === 'number') {
    filtered = filtered.slice(-opts.limit);
  }
  return filtered;
}

// Count-only helper for cheap analytics (sleep cycle summaries, etc.)
function countEvents(cwd, opts = {}) {
  return readEvents(cwd, opts).length;
}

module.exports = { appendEvent, readEvents, countEvents, eventsPath };
