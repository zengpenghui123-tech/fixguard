// hook.js — Claude Code PreToolUse hook entry point.
//
// Reads the tool invocation payload from stdin, looks up scars for the
// target file, and decides whether to allow/deny/annotate the call.
//
// Output shape follows Claude Code hook spec:
//   https://code.claude.com/docs/en/hooks
//
// For Read → allow + additionalContext (warning)
// For Edit → check old_string's line range; deny if it overlaps a scar
// For MultiEdit → check all edits; deny if any overlaps
// For Write → deny if file has any scars (whole-file replacement)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadScarMap, isScarMapStale } = require('./scars');
const { loadConfig } = require('./config');
const { appendEvent } = require('./events');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    // Safety: if stdin is TTY (not piped), resolve immediately
    if (process.stdin.isTTY) resolve('');
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// Thin context captured from the inbound payload so allow()/deny() can
// log without threading parameters through every call site.
let _eventCtx = { cwd: null, tool: null, file: null, scarCount: 0, sessionId: null };

function allow(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
  if (additionalContext) out.hookSpecificOutput.additionalContext = additionalContext;
  emit(out);

  // Only log "interesting" allows — when context was actually injected.
  // Silent allows (no scars, unknown tools) would flood the log.
  if (additionalContext && _eventCtx.cwd) {
    appendEvent(_eventCtx.cwd, {
      type: 'hook.allow_with_context',
      tool: _eventCtx.tool,
      file: _eventCtx.file,
      scars: _eventCtx.scarCount,
      session: _eventCtx.sessionId,
    });
  }
}

function deny(reason, scarIds) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  if (_eventCtx.cwd) {
    const evt = {
      type: 'hook.deny',
      tool: _eventCtx.tool,
      file: _eventCtx.file,
      scars: _eventCtx.scarCount,
      session: _eventCtx.sessionId,
      reason: reason.slice(0, 200),
    };
    // Include list of full-sha scarIds that triggered the deny so
    // weights.js can attribute reinforcement to the right scars.
    if (Array.isArray(scarIds) && scarIds.length) {
      evt.scarIds = scarIds;
    }
    appendEvent(_eventCtx.cwd, evt);
  }
}

function formatScarList(scars) {
  return scars.map(s =>
    `  · ${s.file}:${s.startLine}-${s.endLine}  [${s.sha}]  ${s.story}`
  ).join('\n');
}

// Rank scars by (confidence × recency decay).
// Recency uses an exponential decay with configurable half-life, so a scar
// twice as old as the half-life has ~25% the weight of a fresh one.
function rankScarsByRelevance(scars, limit, halfLifeDays = 180) {
  const now = Date.now();
  const decayMs = halfLifeDays * 24 * 60 * 60 * 1000;
  const scored = scars.map(s => {
    let ageMs = decayMs; // default: one half-life if date is missing
    if (s.date) {
      const t = new Date(s.date).getTime();
      if (!isNaN(t)) ageMs = Math.max(0, now - t);
    }
    const recency = Math.pow(0.5, ageMs / decayMs);
    const confidence = typeof s.score === 'number' ? s.score : 0.5;
    return { scar: s, rank: confidence * recency };
  });
  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit).map(x => x.scar);
}

// Rank scars by proximity to a target line range. Used when an Edit doesn't
// overlap any scar but the file has scars elsewhere — shows the *nearest*
// scars rather than an arbitrary slice.
function rankScarsByProximity(scars, targetRange, limit) {
  const [ts, te] = targetRange;
  const scored = scars.map(s => {
    const distance = Math.max(0, s.startLine - te, ts - s.endLine);
    return { scar: s, dist: distance };
  });
  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, limit).map(x => x.scar);
}

function resolveRelPath(cwd, filePathArg) {
  if (!filePathArg) return null;
  let p = filePathArg;
  if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
  const rel = path.relative(cwd, p).replace(/\\/g, '/');
  return rel;
}

function scarsForFile(scarMap, relPath) {
  if (!scarMap || !Array.isArray(scarMap.scars)) return [];
  // Skip archived scars — they've decayed below the threshold and should
  // not be injected into AI context until (if ever) they re-activate.
  return scarMap.scars.filter(s => s.file === relPath && !s.archived);
}

// Find the line range of `needle` inside `haystack`. Returns:
//   { range: [startLine, endLine], ambiguous: bool }  (1-indexed)
//   or null if not found.
// Handles CRLF/LF mismatch by normalizing both sides.
// Flags `ambiguous: true` when needle appears more than once — in that case
// the caller should be conservative (treat as affecting the whole file).
function findLineRange(haystack, needle) {
  if (!needle) return null;

  // Normalize line endings on both sides
  const hNorm = haystack.replace(/\r\n/g, '\n');
  const nNorm = needle.replace(/\r\n/g, '\n');

  let idx = hNorm.indexOf(nNorm);
  if (idx === -1) return null;

  // Check ambiguity: does needle appear more than once?
  const next = hNorm.indexOf(nNorm, idx + 1);
  const ambiguous = next !== -1;

  let startLine = 1;
  for (let i = 0; i < idx; i++) if (hNorm[i] === '\n') startLine++;
  let lines = 0;
  for (const ch of nNorm) if (ch === '\n') lines++;
  return { range: [startLine, startLine + lines], ambiguous };
}

function rangesOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

// ─── Per-session injection dedup ─────────────────────────────
// Claude Code sends a session_id on every hook call. We track which
// (session, file) pairs have already received a full scar-context
// injection, so repeated Reads of the same file in one session get a
// brief pointer instead of the full payload.
const SESSION_CACHE_DIR = path.join(os.tmpdir(), 'fixguard-sessions');

// GC old session files. Called lazily at most once per process invocation.
// Session caches older than `sessionCacheTtlDays` (default 7) get deleted so
// the tmpdir doesn't grow without bound over weeks/months of AI use.
let _sessionGcDone = false;
function gcSessionCache(cwd) {
  if (_sessionGcDone) return;
  _sessionGcDone = true;
  let files;
  try { files = fs.readdirSync(SESSION_CACHE_DIR); }
  catch { return; }
  const ttlDays = (loadConfig(cwd).sessionCacheTtlDays) || 7;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  for (const name of files) {
    const p = path.join(SESSION_CACHE_DIR, name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) fs.unlinkSync(p);
    } catch { /* best effort */ }
  }
}

function sessionCachePath(sessionId) {
  if (!sessionId) return null;
  // Sanitize sessionId to avoid path traversal
  const safe = String(sessionId).replace(/[^a-z0-9\-]/gi, '_').slice(0, 64);
  return path.join(SESSION_CACHE_DIR, `${safe}.json`);
}

function loadSessionCache(sessionId) {
  const p = sessionCachePath(sessionId);
  if (!p || !fs.existsSync(p)) return { injected: {} };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { injected: {} }; }
}

function saveSessionCache(sessionId, cache) {
  const p = sessionCachePath(sessionId);
  if (!p) return;
  try {
    fs.mkdirSync(SESSION_CACHE_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache));
  } catch { /* best effort */ }
}

function wasInjected(cache, relPath) {
  return Boolean(cache.injected && cache.injected[relPath]);
}

function markInjected(cache, relPath) {
  if (!cache.injected) cache.injected = {};
  cache.injected[relPath] = Date.now();
}

async function runHook() {
  // Hard bypass — still audited in the blood log so repeated bypassing
  // shows up in the dream report and is not silent.
  if (process.env.FIXGUARD_BYPASS === '1') {
    // Peek at stdin non-destructively to log what was being bypassed.
    // Best-effort: if parse fails, log the bypass without details.
    let ctx = {};
    try {
      const raw = await readStdin();
      if (raw && raw.trim()) {
        const payload = JSON.parse(raw);
        ctx = {
          tool: payload.tool_name,
          file: payload.tool_input && payload.tool_input.file_path,
          cwd: payload.cwd,
          session: payload.session_id,
        };
      }
    } catch { /* ignore */ }
    if (ctx.cwd) {
      appendEvent(ctx.cwd, {
        type: 'hook.bypassed',
        tool: ctx.tool,
        file: ctx.file,
        session: ctx.session,
      });
    }
    allow();
    return;
  }

  let payload;
  try {
    const raw = await readStdin();
    if (!raw.trim()) { allow(); return; }
    payload = JSON.parse(raw);
  } catch {
    // Never block on parse failure — fail open
    allow();
    return;
  }

  const cwd = payload.cwd || process.cwd();
  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};
  const sessionId = payload.session_id || null;

  // GC stale session cache entries (runs at most once per process)
  gcSessionCache(cwd);

  const scarMap = loadScarMap(cwd);
  if (!scarMap) { allow(); return; }

  // Check staleness (scar map generated at a different HEAD than current).
  // We do NOT block on this — just include a note + emit one audit event
  // per hook invocation so the dream report can count "how often did we
  // run against a stale map this week."
  const stale = isScarMapStale(cwd, scarMap);
  const staleNote = stale
    ? `\n\n⚠ Note: this scar map was generated at a different HEAD. Consider running \`fixguard scars\` to refresh.`
    : '';
  if (stale) {
    appendEvent(cwd, {
      type: 'hook.stale_map',
      tool: toolName,
      file: toolInput.file_path,
      session: sessionId,
    });
  }

  const relPath = resolveRelPath(cwd, toolInput.file_path);
  if (!relPath) { allow(); return; }

  const scars = scarsForFile(scarMap, relPath);

  // Fill in the event context so allow()/deny() know what to log.
  _eventCtx = {
    cwd,
    tool: toolName,
    file: relPath,
    scarCount: scars.length,
    sessionId,
  };

  if (scars.length === 0) { allow(); return; }

  // ─── Read: advisory, inject context (session-dedup) ─────────────
  if (toolName === 'Read') {
    const sessionCache = loadSessionCache(sessionId);
    if (sessionId && wasInjected(sessionCache, relPath)) {
      // Already injected full context this session — emit a brief pointer
      allow(`[fixguard] Reminder: ${relPath} has ${scars.length} protected scar(s) (full list was injected earlier this session).${staleNote}`);
      return;
    }

    // Token-budget protection: if the file has more scars than we can sensibly
    // inject, rank by (score × recency) and show only the top N. Without this,
    // a heavily-patched file (e.g. 150 scars) would blow the context window,
    // recreating the very compression problem fixguard exists to defeat.
    const cfg = loadConfig(cwd);
    const maxInject = cfg.maxScarsPerInjection;
    const halfLife = cfg.recencyHalfLifeDays;
    const shown = scars.length > maxInject
      ? rankScarsByRelevance(scars, maxInject, halfLife)
      : scars;
    const hidden = scars.length - shown.length;

    const hiddenNote = hidden > 0
      ? `\n\n(${hidden} more scar region(s) in this file not shown — the above are the top ${shown.length} ranked by confidence + recency. Run \`fixguard scars\` to see the full map.)`
      : '';

    const ctx = [
      `[fixguard] ${relPath} contains ${scars.length} protected scar region(s) — code born from past bug fixes.`,
      `Read carefully. Do not silently remove or rewrite these lines without explicit justification.`,
      '',
      formatScarList(shown),
      '',
      `Each scar is a wound the project remembers. If you need to modify one, state your reason first.${hiddenNote}${staleNote}`,
    ].join('\n');

    if (sessionId) {
      markInjected(sessionCache, relPath);
      saveSessionCache(sessionId, sessionCache);
    }
    allow(ctx);
    return;
  }

  // ─── Write: whole-file overwrite → deny if file has any scars ───
  if (toolName === 'Write') {
    deny(
      `Write would overwrite ${relPath}, which contains ${scars.length} protected scar region(s) from past bug fixes:\n\n` +
      formatScarList(scars) +
      `\n\nUse Edit with targeted old_string → new_string replacements instead, and avoid touching these line ranges unless you intend to change a known fix. If you must overwrite, set FIXGUARD_BYPASS=1 and explain why.${staleNote}`,
      scars.map(s => s.fullSha || s.sha)
    );
    return;
  }

  // ─── Edit: resolve affected lines, check overlap ────────────────
  if (toolName === 'Edit') {
    const { file_path, old_string } = toolInput;
    if (!old_string) { allow(); return; }
    let text;
    try { text = fs.readFileSync(file_path, 'utf8'); }
    catch { allow(); return; }
    const found = findLineRange(text, old_string);
    if (!found) { allow(); return; }
    // Ambiguous match → be conservative: treat as affecting any scarred region
    if (found.ambiguous) {
      deny(
        `Edit's old_string appears more than once in ${relPath}, which has ${scars.length} protected scar region(s). ` +
        `Fixguard cannot determine which occurrence will be replaced. Make your old_string unique by including more surrounding context, then retry.`
      );
      return;
    }
    const range = found.range;
    const overlapping = scars.filter(s => rangesOverlap([s.startLine, s.endLine], range));
    if (overlapping.length === 0) {
      // Edit doesn't touch a scar, but file has scars elsewhere → gentle nudge.
      // Show the nearest scars to the edit target rather than arbitrary ones.
      const nearestLimit = Math.min(3, scars.length);
      const nearest = rankScarsByProximity(scars, range, nearestLimit);
      allow(
        `[fixguard] Your edit to ${relPath} (lines ${range[0]}-${range[1]}) does not touch any scars. ` +
        `Note: this file has ${scars.length} other scar region(s) — leave them alone. ` +
        `Nearest ${nearestLimit}:\n\n${formatScarList(nearest)}${staleNote}`
      );
      return;
    }
    deny(
      `Edit targets ${overlapping.length} protected scar region(s) in ${relPath} (your change covers lines ${range[0]}-${range[1]}):\n\n` +
      formatScarList(overlapping) +
      `\n\nThese are scars from real bug fixes. If you are intentionally changing this code (e.g. replacing with a better approach), state your reason in your next message and set FIXGUARD_BYPASS=1. Otherwise, leave these lines unchanged and modify something else.${staleNote}`,
      overlapping.map(s => s.fullSha || s.sha)
    );
    return;
  }

  // ─── MultiEdit: iterate all edits ───────────────────────────────
  if (toolName === 'MultiEdit') {
    const { file_path, edits } = toolInput;
    if (!Array.isArray(edits)) { allow(); return; }
    let text;
    try { text = fs.readFileSync(file_path, 'utf8'); }
    catch { allow(); return; }

    const hits = [];
    for (const edit of edits) {
      const found = findLineRange(text, edit.old_string);
      if (!found) continue;
      const range = found.range;
      for (const s of scars) {
        if (rangesOverlap([s.startLine, s.endLine], range)) hits.push(s);
      }
    }
    if (hits.length === 0) { allow(); return; }
    // Dedupe
    const seen = new Set();
    const unique = hits.filter(s => {
      const k = `${s.file}:${s.startLine}:${s.endLine}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    deny(
      `MultiEdit touches ${unique.length} protected scar region(s) in ${relPath}:\n\n` +
      formatScarList(unique) +
      `\n\nSplit your MultiEdit into separate Edits so unrelated changes don't get bundled with scarred-region changes. Or set FIXGUARD_BYPASS=1 and state your reason.`,
      unique.map(s => s.fullSha || s.sha)
    );
    return;
  }

  // Unknown / unhandled tool → allow silently
  allow();
}

module.exports = { runHook };
