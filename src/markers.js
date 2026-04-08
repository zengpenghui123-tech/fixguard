// markers.js — parse @fix markers from source files
const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', 'vendor', '__pycache__', '.venv', 'venv',
  'target', '.idea', '.vscode',
];

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh',
  '.lua', '.sql', '.html', '.htm', '.css', '.scss', '.less',
  '.yml', '.yaml', '.toml', '.md', '.r', '.dart', '.ex', '.exs',
]);

const DEFAULT_BLOCK_LINES = 20;

// Match @fix markers in any comment style.
// Captures: kind (fix|fix-start|fix-end), tag, opts (key=value tokens), reason
const MARKER_RE = /@(fix-start|fix-end|fix)\b(?:\s*\[([^\]\n]+)\])?([^"\n]*?)(?:"([^"]*)")?\s*(?:\*\/|-->|$)/;

function loadConfig(root) {
  const cfgPath = path.join(root, '.fixguardrc.json');
  if (fs.existsSync(cfgPath)) {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch { /* ignore */ }
  }
  return {};
}

function shouldIgnore(rel, ignore) {
  const parts = rel.split(/[\\/]/);
  return parts.some(p => ignore.includes(p));
}

function* walk(dir, root, ignore) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    if (shouldIgnore(rel, ignore)) continue;
    if (e.isDirectory()) {
      yield* walk(full, root, ignore);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXT.has(ext)) yield full;
    }
  }
}

function parseOpts(raw) {
  const opts = {};
  if (!raw) return opts;
  for (const m of raw.matchAll(/(\w+)=(\S+)/g)) {
    opts[m[1]] = m[2];
  }
  return opts;
}

// Parse one file → array of protected regions
function parseFile(filePath, root) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  const regions = [];
  const openStack = []; // stack of @fix-start awaiting @fix-end

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('@fix')) continue;
    const m = line.match(MARKER_RE);
    if (!m) continue;
    const kind = m[1]; // fix | fix-start | fix-end
    const tag = (m[2] || '').trim() || 'untagged';
    const opts = parseOpts(m[3] || '');
    const reason = (m[4] || '').trim();
    const lineNum = i + 1;

    if (kind === 'fix-start') {
      openStack.push({ file: rel, tag, reason, startLine: lineNum, opts });
    } else if (kind === 'fix-end') {
      const open = openStack.pop();
      if (open) {
        regions.push({ ...open, endLine: lineNum });
      }
    } else {
      // shorthand @fix → protect next N lines or next block
      const span = parseInt(opts.lines, 10) || DEFAULT_BLOCK_LINES;
      const startLine = lineNum;
      const endLine = Math.min(lines.length, lineNum + span);
      regions.push({ file: rel, tag, reason, startLine, endLine, opts });
    }
  }
  // unclosed fix-start → protect till EOF
  for (const open of openStack) {
    regions.push({ ...open, endLine: lines.length });
  }
  return regions;
}

async function listProtected(root) {
  const cfg = loadConfig(root);
  const ignore = [...DEFAULT_IGNORE, ...(cfg.ignore || [])];
  const all = [];
  for (const file of walk(root, root, ignore)) {
    try {
      const regions = parseFile(file, root);
      if (regions.length) all.push(...regions);
    } catch { /* skip unreadable */ }
  }
  return all;
}

module.exports = { listProtected, parseFile, loadConfig, DEFAULT_IGNORE };
