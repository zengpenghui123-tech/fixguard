// review.js — generate a HUMAN-readable scar review.
// Goal: a person can scroll through 30 entries in 5 minutes and judge each one
// without ever opening their editor or running git show.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { detectScars } = require('./scars');

const TOP_N_DEFAULT = 30;

function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
}

function langOf(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
    '.ts': 'ts', '.tsx': 'tsx',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp', '.php': 'php', '.sh': 'bash', '.bash': 'bash',
    '.html': 'html', '.css': 'css', '.scss': 'scss',
    '.yml': 'yaml', '.yaml': 'yaml', '.json': 'json',
    '.sql': 'sql', '.md': 'markdown',
  })[ext] || '';
}

// Pull a small representative snippet of the +added lines from a commit
// for the given file. Skip pure-blank or pure-brace lines, prefer "meaty" code.
function extractSnippet(sha, file, cwd, maxLines = 8) {
  let raw;
  try {
    raw = git(`show --no-color --unified=0 ${sha} -- "${file}"`, cwd);
  } catch { return null; }

  const addedLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const code = line.slice(1);
      // Skip pure-whitespace, lone braces, separators
      const stripped = code.trim();
      if (!stripped) continue;
      if (/^[{}();,]+$/.test(stripped)) continue;
      addedLines.push(code);
      if (addedLines.length >= maxLines) break;
    }
  }
  return addedLines.length ? addedLines : null;
}

function relDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

// Translate a commit subject into a one-line plain Chinese summary if possible
// (best effort — we just clean it up, not translate)
function cleanSubject(s) {
  return s
    .replace(/^(fix|bug|hotfix|patch|revert|emergency)[:\s(\[]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function reviewCommand(cwd, opts = {}) {
  const topN = opts.top || TOP_N_DEFAULT;

  console.log('fixguard: scanning for review…');
  const result = await detectScars(cwd);
  const { scars, fixCommitCount, scannedFiles } = result;

  if (scars.length === 0) {
    console.log('  (no scars detected)');
    return;
  }

  // Group by commit
  const byCommit = new Map();
  for (const s of scars) {
    const k = s.fullSha || s.sha;
    if (!byCommit.has(k)) {
      byCommit.set(k, {
        sha: s.sha,
        fullSha: s.fullSha || s.sha,
        story: s.story,
        date: s.date,
        files: new Map(),
        totalLines: 0,
      });
    }
    const c = byCommit.get(k);
    if (!c.files.has(s.file)) c.files.set(s.file, []);
    c.files.get(s.file).push([s.startLine, s.endLine]);
    c.totalLines += (s.endLine - s.startLine + 1);
  }

  // Sort by total scar weight, take top N for the readable section
  const allCommits = [...byCommit.values()].sort((a, b) => b.totalLines - a.totalLines);
  const headCommits = allCommits.slice(0, topN);
  const tailCommits = allCommits.slice(topN);

  // Top scarred files
  const fileCounts = new Map();
  for (const s of scars) fileCounts.set(s.file, (fileCounts.get(s.file) || 0) + 1);
  const topFiles = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ─── Build markdown ─────────────────────────────────────────
  const out = [];

  out.push(`# 疤痕审阅 · Scar Review`);
  out.push('');
  out.push(`> 自动生成 · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  out.push(`>`);
  out.push(`> 这份文件是给**人**看的。你只需要扫一遍，对每条点 \`[x]\`。`);
  out.push(`> 不需要打开任何文件——下面已经把代码片段贴出来了。`);
  out.push('');
  out.push(`---`);
  out.push('');
  out.push(`## 总览`);
  out.push('');
  out.push(`- 扫描了 **${scannedFiles}** 个代码文件`);
  out.push(`- 找到 **${fixCommitCount}** 个看起来像 fix 的 commit`);
  out.push(`- 它们留下了 **${scars.length}** 段疤痕组织`);
  out.push(`- 这 ${scars.length} 段疤痕来自 **${allCommits.length}** 个不同的 commit`);
  out.push('');
  out.push(`下面**只列前 ${headCommits.length} 个最重的 commit**——它们占了大部分疤痕。剩下的 ${tailCommits.length} 个在最底下，简略列出。`);
  out.push('');

  // Top files quick scan
  out.push(`## 流血最多的文件`);
  out.push('');
  out.push(`如果下面这些文件你一眼看出来是"自动生成 / 不该被记忆"的，告诉我，我把它们加进忽略名单：`);
  out.push('');
  for (const [file, count] of topFiles) {
    out.push(`- \`${file}\` — ${count} 段疤`);
  }
  out.push('');
  out.push(`---`);
  out.push('');

  // The main reviewable section
  out.push(`## 一个一个看 (前 ${headCommits.length} 个，按受伤程度排序)`);
  out.push('');

  let i = 0;
  for (const c of headCommits) {
    i++;
    const cleanStory = cleanSubject(c.story);
    const fileList = [...c.files.entries()];
    const topFile = fileList[0];

    out.push(`### ${i}. ${cleanStory}`);
    out.push('');
    out.push(`\`${c.sha}\` · ${relDate(c.date)} · **${c.totalLines} 行** 散布在 **${c.files.size}** 个文件`);
    out.push('');

    // Show actual code snippet from the most-affected file in this commit
    const snippet = extractSnippet(c.fullSha, topFile[0], cwd, 8);
    if (snippet && snippet.length) {
      out.push(`**这次加进去的代码** (\`${topFile[0]}\`):`);
      out.push('');
      out.push('```' + langOf(topFile[0]));
      for (const line of snippet) out.push(line);
      out.push('```');
      out.push('');
    }

    // File breakdown
    if (c.files.size > 1) {
      out.push(`涉及的其它文件：`);
      for (const [f, ranges] of fileList.slice(1, 6)) {
        const total = ranges.reduce((acc, [a, b]) => acc + (b - a + 1), 0);
        out.push(`- \`${f}\` (${total} 行)`);
      }
      if (c.files.size > 6) out.push(`- …还有 ${c.files.size - 6} 个文件`);
      out.push('');
    }

    // The decision
    out.push(`**这是个真的需要被记住的 fix 吗？**`);
    out.push('');
    out.push(`- [ ] **真疤** — 是真 bug 修复，未来 AI 改这里要小心`);
    out.push(`- [ ] **噪音** — 不算 bug（顺手 typo / refactor / 加 feature 时带的"fix"），别记`);
    out.push(`- [ ] **混杂** — 一部分是真的，一部分不是（细节我先不管）`);
    out.push('');
    out.push(`---`);
    out.push('');
  }

  // Tail section: just list briefly
  if (tailCommits.length) {
    out.push(`## 剩下的 ${tailCommits.length} 个 commit (简略)`);
    out.push('');
    out.push(`这些每个都只贡献了少量疤痕。如果上面前 ${headCommits.length} 个判断完了，启发式调整后再看这一批就行。`);
    out.push('');
    out.push(`<details><summary>展开看</summary>`);
    out.push('');
    for (const c of tailCommits) {
      out.push(`- \`${c.sha}\` · ${c.totalLines} 行 · ${cleanSubject(c.story)}`);
    }
    out.push('');
    out.push(`</details>`);
    out.push('');
  }

  // Footer
  out.push(`---`);
  out.push('');
  out.push(`## 你看完之后`);
  out.push('');
  out.push(`告诉我两件事：`);
  out.push(`1. 前 ${headCommits.length} 个里大概多少是 **真疤** / 多少是 **噪音** / 多少 **混杂**`);
  out.push(`2. "流血最多的文件"那一节里有没有应该被加进忽略名单的`);
  out.push('');
  out.push(`这两件事会直接告诉我下一步怎么调启发式。`);
  out.push('');

  // Write
  const dir = path.join(cwd, '.fixguard');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'review.md');
  fs.writeFileSync(outPath, out.join('\n'));

  console.log('');
  console.log(`  → ${path.relative(cwd, outPath)}`);
  console.log(`  ${headCommits.length} commits in the readable section (out of ${allCommits.length} total)`);
  console.log(`  estimated review time: ~${Math.ceil(headCommits.length * 12 / 60)} 分钟`);
  console.log('');
  console.log(`  在编辑器里打开 review.md，从上往下扫，对每条点 [x]。`);
}

module.exports = { reviewCommand };
