// scars.js — detect scar tissue from git history
// "Scar tissue" = code currently in the repo that was born in a high-confidence
// fix commit, where confidence is computed from multiple independent signals
// (subject keywords + diff shape + diff size + test co-change + recent revert
// proximity + commit timing). No @fix markers, no human triage required.
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { scoreCommit, SCAR_THRESHOLD, FIX_KEYWORDS_SOURCE } = require('./signals');
const { loadConfig } = require('./config');
const { appendEvent } = require('./events');

const execAsync = promisify(exec);

const SKIP_EXT = new Set([
  '.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.svg',
  '.pdf','.zip','.gz','.tar','.7z','.rar',
  '.bin','.exe','.dll','.so','.dylib','.class','.jar',
  '.woff','.woff2','.ttf','.eot','.otf',
  '.mp3','.mp4','.mov','.wav','.ogg','.flac',
  '.lock','.map',
]);

// Generated / vendored / lockfile patterns — never carry meaningful "scars"
const BUILTIN_SKIP_PATTERNS = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)asset-manifest\.json$/i,
  /(^|\/)dist\//i,
  /(^|\/)build\//i,
  /(^|\/)out\//i,
  /(^|\/)\.next\//i,
  /(^|\/)node_modules\//i,
  /(^|\/)vendor\//i,
  /(^|\/)coverage\//i,
  /\.min\.(js|css)$/i,
  /\.bundle\.(js|css)$/i,
  /\.generated\./i,
];

// Turn a user-supplied glob-ish string into a case-insensitive RegExp.
// Supports `*` (non-slash wildcard), `**` (any), and trailing `/` for dirs.
function globToRegex(pattern) {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp(esc, 'i');
}

function userIgnorePatterns(cwd) {
  const cfg = loadConfig(cwd);
  return (cfg.ignore || []).map(globToRegex);
}

function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 100 * 1024 * 1024,
  });
}

// Step 1: list ALL commits (not just fix-keyword ones) with metadata
function listAllCommits(cwd) {
  const raw = git('log --all --no-merges --format=%H%x09%cI%x09%s', cwd);
  const commits = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [sha, date, ...subjParts] = parts;
    const subject = subjParts.join('\t').trim();
    commits.push({ sha, date, subject });
  }
  return commits;
}

// Parse a single commit's diff block from a `git log -p` stream.
// Tracks TWO kinds of added content separately:
//   - modifiedLinesAdded: lines added to EXISTING files (true edits)
//   - newFileLinesAdded:  lines that arrived as part of brand-new files
//
// This separation prevents the "fix commit alongside a new test file"
// edge case from tripping the largeDiff penalty. A 4-line bug fix that
// also adds a 100-line regression test should still be scored as a
// small targeted fix, not a 104-line refactor. See DESIGN.md §9 for
// the incident that motivated this breakdown.
function parseDiffBlock(diffText) {
  const filesChanged = [];
  let modifiedLinesAdded = 0;
  let modifiedLinesDeleted = 0;
  let newFileLinesAdded = 0;
  const addedLines = [];
  let currentIsNewFile = false;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      currentIsNewFile = false; // reset on every file boundary
    } else if (line.startsWith('new file mode')) {
      currentIsNewFile = true;
    } else if (line.startsWith('+++ b/')) {
      filesChanged.push(line.slice(6));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentIsNewFile) {
        newFileLinesAdded++;
      } else {
        modifiedLinesAdded++;
      }
      if (addedLines.length < 200) addedLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      if (!currentIsNewFile) modifiedLinesDeleted++;
    }
  }

  return {
    filesChanged,
    // Back-compat aggregates (still summed for scoreCommit fallback path)
    linesAdded: modifiedLinesAdded + newFileLinesAdded,
    linesDeleted: modifiedLinesDeleted,
    // New breakdown used by the size-bucket logic
    modifiedLinesAdded,
    modifiedLinesDeleted,
    newFileLinesAdded,
    addedLines,
  };
}

// Single-pass commit analysis using `git log -p` narrowed by --grep.
// Replaces the previous N+1 pattern (one `git show` per candidate commit).
// Returns Map<sha, { subject, date, score, signals }> of commits that
// cross the SCAR_THRESHOLD.
function analyzeAllCommits(cwd, opts = {}) {
  const verbose = opts.verbose === true;

  // Cheap pass: all commits, needed by hasRecentRevert (looks at surrounding
  // commits to see if a revert happened in a window before each candidate).
  const allCommits = listAllCommits(cwd);

  // Single expensive call: git log -p, filtered server-side to fix-keyword
  // commits only. A unique sentinel starts each record so we can split
  // reliably even when subjects contain tabs/newlines.
  const SENTINEL = '___FXG_CMT___';
  // Single source of truth: same pattern signals.js uses for FIX_KEYWORDS.
  const grepRegex = FIX_KEYWORDS_SOURCE;
  let raw;
  try {
    raw = git(
      `log --all --no-merges -E --grep="${grepRegex}" -i ` +
      `--format="${SENTINEL}%x09%H%x09%cI%x09%s" ` +
      `-p --unified=0 --no-color`,
      cwd
    );
  } catch {
    return new Map();
  }

  // Split the stream by sentinel. First chunk is empty (stream starts with it).
  const blocks = raw.split(SENTINEL + '\t').slice(1);

  const scarCommits = new Map();
  let analyzed = 0;

  for (const block of blocks) {
    const nlIdx = block.indexOf('\n');
    if (nlIdx === -1) continue;
    const header = block.slice(0, nlIdx);
    const body = block.slice(nlIdx + 1);

    const parts = header.split('\t');
    if (parts.length < 3) continue;
    const sha = parts[0];
    const date = parts[1];
    const subject = parts.slice(2).join('\t').trim();

    const diffStats = parseDiffBlock(body);

    const commit = {
      sha, date, subject,
      filesChanged: diffStats.filesChanged,
      linesAdded: diffStats.linesAdded,
      linesDeleted: diffStats.linesDeleted,
      modifiedLinesAdded: diffStats.modifiedLinesAdded,
      modifiedLinesDeleted: diffStats.modifiedLinesDeleted,
      newFileLinesAdded: diffStats.newFileLinesAdded,
      addedLines: diffStats.addedLines,
    };

    const { score, signals } = scoreCommit(commit, allCommits);
    analyzed++;
    // Honor user-configured threshold (defaults to SCAR_THRESHOLD)
    const threshold = loadConfig(cwd).scarThreshold;
    if (score >= threshold) {
      scarCommits.set(sha, { subject, date, score, signals });
    }
  }

  if (verbose) {
    const threshold = loadConfig(cwd).scarThreshold;
    console.error(`signals: analyzed ${analyzed} candidate commits in single pass, ${scarCommits.size} crossed threshold ${threshold}`);
  }
  return scarCommits;
}

function listTrackedFiles(cwd) {
  return git('ls-files', cwd).split('\n').filter(Boolean);
}

function shouldSkipFile(file, cwd, userPatterns) {
  const cfg = loadConfig(cwd);
  const lower = file.toLowerCase();
  for (const ext of SKIP_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  for (const pat of BUILTIN_SKIP_PATTERNS) {
    if (pat.test(file)) return true;
  }
  // User-defined ignore patterns from .fixguardrc.json
  if (userPatterns) {
    for (const pat of userPatterns) {
      if (pat.test(file)) return true;
    }
  }
  try {
    const st = fs.statSync(path.join(cwd, file));
    if (!st.isFile()) return true;
    if (st.size > cfg.maxFileBytes) return true;
  } catch { return true; }
  return false;
}

// Parse `git blame --line-porcelain` output → array of { line, sha }
function parseBlameOutput(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    // Header lines: "<40-hex-sha> <orig_line> <final_line> [<num_lines>]"
    const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (m) out.push({ line: parseInt(m[2], 10), sha: m[1] });
  }
  return out;
}

// Async variant of blame — used by the parallel worker pool.
async function blameLinesAsync(file, cwd) {
  try {
    const { stdout } = await execAsync(
      `git blame --line-porcelain -- "${file}"`,
      { cwd, maxBuffer: 50 * 1024 * 1024 }
    );
    return parseBlameOutput(stdout);
  } catch {
    return [];
  }
}

// Run blame across many files in parallel with bounded concurrency.
// Returns Map<file, array of {line, sha}>.
async function blameFilesParallel(files, cwd, concurrency = BLAME_CONCURRENCY) {
  const results = new Map();
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= files.length) return;
      results.set(files[idx], await blameLinesAsync(files[idx], cwd));
    }
  }
  const n = Math.min(concurrency, Math.max(1, files.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

// Group consecutive scar lines (same commit, contiguous) into regions
function groupRegions(scarLines) {
  if (scarLines.length === 0) return [];
  scarLines.sort((a, b) => a.line - b.line);
  const out = [];
  let cur = { startLine: scarLines[0].line, endLine: scarLines[0].line, sha: scarLines[0].sha };
  for (let i = 1; i < scarLines.length; i++) {
    const s = scarLines[i];
    if (s.sha === cur.sha && s.line === cur.endLine + 1) {
      cur.endLine = s.line;
    } else {
      out.push(cur);
      cur = { startLine: s.line, endLine: s.line, sha: s.sha };
    }
  }
  out.push(cur);
  return out;
}

// Main: scan repo, return scar map
async function detectScars(cwd, opts = {}) {
  try { git('rev-parse --git-dir', cwd); }
  catch { throw new Error('not a git repository'); }

  const fixCommits = analyzeAllCommits(cwd, opts);
  if (fixCommits.size === 0) {
    return { scars: [], fixCommitCount: 0, scannedFiles: 0 };
  }

  // Filter tracked files to only the ones worth blaming (text, reasonable size)
  const allFiles = listTrackedFiles(cwd);
  const userPatterns = userIgnorePatterns(cwd);
  const filesToBlame = allFiles.filter(f => !shouldSkipFile(f, cwd, userPatterns));

  // Parallel blame — user-configurable concurrency
  const cfg = loadConfig(cwd);
  const blameMap = await blameFilesParallel(filesToBlame, cwd, cfg.blameConcurrency);

  const scars = [];
  for (const file of filesToBlame) {
    const blame = blameMap.get(file) || [];
    const scarLines = blame.filter(b => fixCommits.has(b.sha));
    if (scarLines.length === 0) continue;

    for (const r of groupRegions(scarLines)) {
      const fix = fixCommits.get(r.sha);
      scars.push({
        file,
        startLine: r.startLine,
        endLine: r.endLine,
        sha: r.sha.slice(0, 8),
        fullSha: r.sha,
        story: fix.subject,
        date: fix.date,
        score: fix.score,
        signals: fix.signals,
      });
    }
  }

  return { scars, fixCommitCount: fixCommits.size, scannedFiles: filesToBlame.length };
}

// Get the current HEAD sha (or null if not a repo / detached / unborn)
function getHeadSha(cwd) {
  try {
    return git('rev-parse HEAD', cwd).trim();
  } catch {
    return null;
  }
}

// Persist a scar map to .fixguard/scars.json
function writeScarMap(cwd, result) {
  const dir = path.join(cwd, '.fixguard');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'scars.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    headSha: getHeadSha(cwd),
    fixCommitCount: result.fixCommitCount,
    scannedFiles: result.scannedFiles,
    scars: result.scars,
  }, null, 2));

  // Make sure .fixguard/ stays out of git
  const giPath = path.join(cwd, '.gitignore');
  let gi = '';
  try { gi = fs.readFileSync(giPath, 'utf8'); } catch { /* none */ }
  if (!/^\.fixguard\/?$/m.test(gi)) {
    fs.writeFileSync(giPath, (gi.endsWith('\n') || gi === '' ? gi : gi + '\n') + '.fixguard/\n');
  }
  return outPath;
}

// ─── Hot-path cache for loadScarMap ─────────────────────────────
// hook.js calls this on every AI tool use; without the cache each call
// does a sync fs read + JSON parse. The cache keys by (path, mtimeMs +
// weights-mtimeMs), so editing either scars.json or weights.json
// invalidates cleanly.
const _scarMapCache = new Map(); // path → { scarMtime, weightMtime, data }

function loadScarMap(cwd) {
  const p = path.join(cwd, '.fixguard', 'scars.json');
  const wp = path.join(cwd, '.fixguard', 'weights.json');
  let st;
  try { st = fs.statSync(p); }
  catch { return null; }
  let wst = null;
  try { wst = fs.statSync(wp); }
  catch { /* weights file is optional */ }

  const cached = _scarMapCache.get(p);
  const wMtime = wst ? wst.mtimeMs : 0;
  if (cached && cached.scarMtime === st.mtimeMs && cached.weightMtime === wMtime) {
    return cached.data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Enrich with weights (archived, weight, blockCount, bypassCount)
    const { enrichWithWeights } = require('./weights');
    enrichWithWeights(cwd, data);
    _scarMapCache.set(p, { scarMtime: st.mtimeMs, weightMtime: wMtime, data });
    return data;
  } catch {
    return null;
  }
}

// Return true if the saved scar map was generated at a different git HEAD
// than the current one — indicating the map is potentially stale.
function isScarMapStale(cwd, scarMap) {
  if (!scarMap || !scarMap.headSha) return false;
  const current = getHeadSha(cwd);
  if (!current) return false;
  return current !== scarMap.headSha;
}

const DIM = s => `\x1b[2m${s}\x1b[0m`;
const BOLD = s => `\x1b[1m${s}\x1b[0m`;

// CLI handler: `fixguard scars`
async function scarsCommand(cwd) {
  const result = await detectScars(cwd);
  const { scars, fixCommitCount, scannedFiles } = result;
  console.log(`fixguard: scanned ${scannedFiles} file(s), ${fixCommitCount} fix-commit(s) → ${BOLD(scars.length)} scar region(s)`);
  if (scars.length === 0) {
    if (fixCommitCount === 0) {
      console.log(DIM('  no commits matched fix-keywords. either this is a young repo, or your team uses different commit conventions.'));
    }
    return;
  }

  // Group by file, sort by scar density
  const byFile = new Map();
  for (const s of scars) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }
  const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log('');
  console.log(BOLD('Top scarred files:'));
  for (const [file, list] of sorted.slice(0, 15)) {
    console.log(`  ${file}  ${DIM(`(${list.length} scar${list.length > 1 ? 's' : ''})`)}`);
    for (const s of list.slice(0, 3)) {
      console.log(`    L${s.startLine}-${s.endLine}  ${DIM(s.sha)}  ${s.story}`);
    }
    if (list.length > 3) console.log(DIM(`    ... ${list.length - 3} more`));
  }

  const outPath = writeScarMap(cwd, result);
  appendEvent(cwd, {
    type: 'scars.scan',
    scarCount: scars.length,
    fixCommits: fixCommitCount,
    scannedFiles,
  });
  console.log('');
  console.log(DIM(`  → ${path.relative(cwd, outPath)}`));
}

module.exports = {
  detectScars, scarsCommand, loadScarMap, writeScarMap,
  isScarMapStale, getHeadSha,
};
