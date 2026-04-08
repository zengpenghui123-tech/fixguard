// diff.js — parse git diff into per-file changed line ranges
const { execSync } = require('child_process');

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Returns Map<relPath, Array<[startLine, endLine]>> of NEW (post-image) hunks
function getStagedChanges(cwd) {
  const map = new Map();
  let raw;
  try {
    raw = git('diff --cached --unified=0 --no-color', cwd);
  } catch (e) {
    throw new Error(`git diff failed: ${e.message}`);
  }
  if (!raw.trim()) return map;

  let currentFile = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      if (currentFile === '/dev/null') currentFile = null;
      else if (!map.has(currentFile)) map.set(currentFile, []);
    } else if (line.startsWith('@@') && currentFile) {
      // @@ -a,b +c,d @@
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (m) {
        const start = parseInt(m[1], 10);
        const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
        if (count > 0) map.get(currentFile).push([start, start + count - 1]);
        else map.get(currentFile).push([start, start]); // pure deletion at line `start`
      }
    }
  }
  return map;
}

// For deletions, we also need the OLD line ranges (the lines being removed)
function getStagedDeletions(cwd) {
  const map = new Map();
  let raw;
  try {
    raw = git('diff --cached --unified=0 --no-color', cwd);
  } catch { return map; }

  let currentFile = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('--- a/')) {
      currentFile = line.slice(6).trim();
      if (currentFile === '/dev/null') currentFile = null;
      else if (!map.has(currentFile)) map.set(currentFile, []);
    } else if (line.startsWith('@@') && currentFile) {
      const m = line.match(/-(\d+)(?:,(\d+))?/);
      if (m) {
        const start = parseInt(m[1], 10);
        const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
        if (count > 0) map.get(currentFile).push([start, start + count - 1]);
      }
    }
  }
  return map;
}

function rangesOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

module.exports = { getStagedChanges, getStagedDeletions, rangesOverlap, git };
