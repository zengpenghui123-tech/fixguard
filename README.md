# fixguard

> Stop AI coding assistants from silently reverting your hard-won bug fixes.
> Zero manual marking. Zero human triage. The tool learns from your git
> history and your AI's behaviour, automatically.

## Try it in 60 seconds

One command sets up everything:

```bash
cd your-project                   # any git repo with some "fix:" commits in it
fixguard bootstrap                # ★ install + auto-commit + scan, all at once
```

That's it. `bootstrap` does four things in order:

1. **Installs hooks** — git pre-commit hook + Claude Code PreToolUse hook
2. **Auto-commits** the hook changes (so they survive `git stash` / `checkout` / rebase)
3. **Scans your git history** for real bug fixes and generates the scar map
4. **Confirms protection is live** and tells you how to inspect it

Only the files fixguard creates or modifies are staged — **your unrelated
uncommitted work is never touched**. Your source code is never modified either;
scars live in a local `.fixguard/` directory that's automatically added to
`.gitignore`.

> **Note on Husky projects:** `bootstrap` detects Husky automatically and
> appends fixguard's check to `.husky/pre-commit` (the tracked file), then
> commits it. If you don't use Husky, it writes to `.git/hooks/pre-commit`
> (untracked) and skips the hook-file commit step entirely.

Manual alternative (if you want to control each step yourself):

```bash
fixguard init                     # install only, no commit, no scan
git add .husky/pre-commit         # commit the hook yourself (Husky projects)
git commit -m "chore: install fixguard"
fixguard scars                    # scan git history
```

You should see something like:

```
fixguard: scanned 184 file(s), 212 fix-commit(s) → 438 scar region(s)

Top scarred files:
  src/core/engine.js   (94 scars)
  src/api/handlers.js  (46 scars)
  ...

What this means:
  Your git history has 212 commits that look like real bug fixes.
  Those fixes added 438 lines of code that are now protected.
  If an AI (or a human) tries to delete any of those lines, fixguard will intervene.

  Example: src/api/handlers.js line 42
  was added in commit a1b2c3d with the message:
    "fix: jwt claim validation edge case on refresh"
  From now on, any Claude Code session trying to delete that line will be blocked.
```

**That's the whole pitch**: those 438 lines are the places your team bled for.
fixguard now protects them from silent AI overwrites.

Want to see what's protected in a specific file?

```bash
fixguard explain src/auth.js
```

Want to see the overall health?

```bash
fixguard status
```

That's it. You're done. From now on any Claude Code session in this directory
reads a scar warning before editing, and any attempt to delete a scarred line
gets blocked with a reference to the original commit that introduced it.

---

## The problem

You spent four hours tracking down a subtle race condition. You fixed it.
Three weeks later, Claude Code / Cursor / Copilot — having no memory of that
battle — "refactors" the file and quietly removes your fix. Production
breaks. You spend four more hours rediscovering the same bug.

This isn't a bug in any single AI tool. It's a **structural property** of
how this generation of AI assistants relate to code:

1. Limited context, lossy compression — the reason a line exists is often
   dropped long before the AI decides to remove it.
2. Statistical bias toward "cleaning" — a defensive check with no comment
   looks, to the model, like dead code.
3. Session isolation — yesterday's Claude is not today's Claude.
4. Whole-file rewrite preference — lines the model doesn't understand
   simply don't get regenerated.
5. Review asymmetry — 200 lines generated in 30 seconds, a 3-line fix
   removed inside is invisible.

No smarter model will fix this. The information has to live somewhere the
AI **must** see it, every time, without depending on its memory.

## What is a "scar"

You spend 4 hours tracking down a bug. You find it — JWT validation is
missing an `iat` check. You add 3 lines of code to fix it. You commit.

Those 3 lines are a **scar**.

They aren't feature code — they don't exist to "do something." They exist
to **prevent something bad from happening again.** Like a scar on skin:
it's different from the surrounding tissue. Harder. More sensitive. It
*remembers* the wound.

Your git history is full of scars — dozens or hundreds of lines added
during late-night debugging sessions, post-incident hotfixes, and careful
security patches. Each one is a piece of defensive code your team bled for.

**The problem: AI doesn't know any of this.** It opens your file, sees an
"unnecessary if check," decides the code "could be cleaner," and deletes
your scar. It doesn't know those 3 lines represent 4 hours of debugging
and 1 production incident.

**fixguard finds every scar in your git history and makes sure no AI can
silently remove them.**

<p align="center">
  <img src="docs/before-after.png" alt="Without fixguard vs With fixguard" width="700">
</p>

<p align="center">
  <img src="docs/architecture.png" alt="fixguard architecture — three rings" width="500">
</p>

## How it works

fixguard organizes protection into three concentric rings:

### Static Ring — detect scars from git history

Every commit in your repo is scored against 7 independent signals:
fix-keywords in the subject, diff size, guard-clause shape, test
co-change, revert proximity, commit timing, and new-file vs modification
ratio. Commits scoring above 0.50 become "scar sources." `git blame` maps
each surviving line back to its birth commit — if that commit is a scar
source, the line is protected. Delete `scars.json` and regenerate it
identically. This ring is a pure function of your git history.

### Runtime Ring — protect on every AI action

Two enforcement points, zero gaps:
- **hook.js** intercepts every Claude Code `Read/Edit/Write` via
  PreToolUse. Reading a scarred file injects a warning into the AI's
  system context. Editing a scarred line is denied with the original
  commit message as the reason. Writing over a scarred file is blocked
  entirely.
- **check.js** runs as a git pre-commit hook (Husky-compatible). If the
  AI somehow bypassed the hook, the commit itself gets caught.

Every decision — deny, allow-with-context, bypass — is logged to
`events.jsonl`, the blood log.

### Learning Ring — self-correct over time

`fixguard sleep` reads the blood log and adjusts per-scar weights:
- Scars that get **blocked** (AI tried to delete, hook denied) → weight
  increases → reinforced
- Scars that get **bypassed** (`FIXGUARD_BYPASS=1`) → weight decreases
  → eroding
- Quiet scars slowly decay → natural forgetting
- Weight below 0.30 → **auto-archived**, no longer injected

Cross-scar patterns emerge when two scars are blocked together in multiple
sessions — a signal of structural coupling worth refactoring. The learning
ring feeds back into the static ring: `weights.json` enriches `scars.json`
on every load, so hook and check always see the same unified view.

## What fixguard does

fixguard treats your `git log` as the source of truth about what counts
as a real fix, and turns every line those fixes introduced into a
protected "scar region." Any AI editing your codebase then passes through
three layers:

```
 git history (your team's fix commits)
       ↓
 multi-signal scoring       →  scars.json
       ↓                         ↑
 Claude Code PreToolUse hook    enriched with
       ↓                         learned weights
   ┌───────────────────┬────────────────┐
   ↓                   ↓                ↓
  Read              Edit              Write
   ↓                   ↓                ↓
  Inject scar       Deny if edit     Deny if file
  context into      overlaps a        has any scar
  AI's next turn    scar region       (pick Edit)
```

**No manual markers. No config file to maintain. No human triage.**
Run `fixguard init` once, and the tool discovers every line added in a
real bug fix commit, ranks them by confidence + recency, and feeds the
relevant ones into your AI's perception path before every action.

## Install

```bash
git clone <this repo>
cd fixguard
npm link          # or add src/cli.js to your PATH
```

> **Status:** v1.1, not yet published to npm. Self-applied to its own
> repository (this directory is protected by fixguard). Ready to install
> on real projects, but expect tuning as the algorithm meets more
> codebases.

## Quick start

```bash
cd your-project
fixguard init          # install git hook + Claude Code hook + default rc
fixguard scars         # scan git history, generate .fixguard/scars.json
fixguard status        # one-screen health check
```

That's it. Any subsequent Claude Code session in this directory is now
gated by fixguard. Any `git commit` runs through the pre-commit hook.

## What `fixguard scars` actually finds

Each commit in your repo is scored against seven independent signals:

| Signal                       | Weight | Meaning                                                                  |
|------------------------------|-------:|--------------------------------------------------------------------------|
| Clean `fix:` keyword         | +0.40  | Subject has `fix/bug/hotfix/...`, no noise or feat words                 |
| Small diff (< 30 mod lines)  | +0.15  | A targeted, surgical change                                              |
| Guard clause shape           | +0.20  | Diff is dominated by `if` / `throw` / sentinel returns / assertions      |
| Test co-change               | +0.15  | Commit touches both src and test files (regression test added)           |
| Recent revert nearby         | +0.15  | A revert commit in the previous 7 days (responding to an incident)       |
| Unusual time                 | +0.05  | Weekend or late-night commit (hotfix correlation)                        |
| Mixed keyword (feat + fix)   | +0.20  | Only partial credit if "fix" is a sub-bullet of a feature commit         |
| Large diff (≥ 200 mod lines) | −0.20  | Probably a refactor, not a fix                                           |
| Noise keyword                | −0.20  | `typo`/`lint`/`format`/`cleanup` cancel the fix signal                   |

A commit becomes a scar source only when its total crosses **0.50**.
No single signal can carry the decision alone — the strongest one is
`+0.40`, and must be supplemented by at least one more.

**Validated on a real ~1,500-commit production web app:** ~80 unique
commits cross the threshold, producing hundreds of scar regions across
a few hundred files. The top ten are all textbook production bugs
(JWT validation, mobile touch handling, auth token lifecycle, i18n
edge cases, etc). Zero manual triage.

## The learning ring

fixguard doesn't just detect once — it watches how its own decisions are
used and adjusts:

### `events.jsonl` — the blood log
Every meaningful action appends one line. Hook denies, hook allows with
context, bypasses, scans, and stale-map detections. Rotated at 10 MB.
Queried by `fixguard events` and consumed by `fixguard sleep`.

### `weights.js` — self-correcting memory
Each scar carries a mutable weight (starts at 1.0). During each sleep
cycle:

- A scar that got **blocked** (AI tried to edit, hook denied) gains
  `+0.05` — defense is reinforced.
- A scar that got **bypassed** (`FIXGUARD_BYPASS=1` was used on its file)
  loses `-0.15` — probably outdated.
- Every scar loses `-0.02` per cycle (natural forgetting), unless it was
  touched this cycle.
- Weight < 0.30 → **archived**, hook and check both stop injecting it.
  Weight recovers → unarchived.

**This resolves the "memory becomes friction" problem.** Outdated scars
eventually go silent without any manual curation.

### `patterns.js` — REM-style cross-scar discovery
Pairs of scars blocked in the same session accumulate co-occurrence
counts. A pair confirmed in ≥2 distinct sessions is promoted to a
"pattern" and surfaced in the next dream report — suggesting
architectural coupling or a shared root cause.

### `fixguard sleep` — the consolidation cycle
Run manually (or via cron). Produces a dream report covering:
- New scars since last sleep, healed scars, recurring pain
- Blood-log activity: denies, surfaces, bypasses, stale-map warnings
- Memory dynamics: reinforced / eroded / archived / unarchived
- Cross-scar patterns confirmed this cycle

## Commands

| Command                   | What it does                                                    |
|---------------------------|------------------------------------------------------------------|
| `fixguard init`           | Install git pre-commit hook + `.claude/settings.json` hook + rc |
| `fixguard scars`          | Scan git history, write `.fixguard/scars.json`                  |
| `fixguard sleep`          | Run consolidation cycle, update weights, write dream report     |
| `fixguard hook`           | Claude Code PreToolUse entry (reads JSON on stdin)              |
| `fixguard check --staged` | Git pre-commit check against scars + `@fix` markers             |
| `fixguard events`         | Show recent blood-log entries                                    |
| `fixguard status`         | One-screen health check across all layers                       |
| `fixguard scan`           | (v0.1 compat) scan `@fix` markers, write `FIXES.md`             |

## `@fix` markers (optional, for negative-space memories)

Auto-detection handles the bulk case. For facts that **aren't in git
history** — "we deliberately don't retry here because upstream does,"
"this null check looks redundant but guards against a CDN race" —
fallback to the manual marker:

```js
// @fix [upstream-retry] "upstream handles retry; adding another causes dupes"
function fetchUpstream() { ... }
```

Markers are kept alongside auto-detected scars. Both paths feed the same
enforcement.

## Bypass

```bash
FIXGUARD_BYPASS=1 git commit ...
```

Loud, audited (emits a `hook.bypassed` event), and the weights layer
uses bypass events to automatically archive scars that are being
overridden repeatedly. You never need to manually remove a stale scar —
just keep bypassing it, and it will fade away within a few sleep cycles.

## Configuration (`.fixguardrc.json`)

Every field is optional:

```json
{
  "fixKeywords": "fix|bug|hotfix|修复|修正|バグ修正|correction|behoben",
  "ignore": ["legacy/**", "vendor/**", "*.pb.go"],
  "scarThreshold": 0.50,
  "blameConcurrency": 8,
  "maxFileBytes": 524288,
  "maxScarsPerInjection": 5,
  "recencyHalfLifeDays": 180,
  "sessionCacheTtlDays": 7
}
```

### Non-English commit messages

By default, fixguard recognizes these English fix-keywords:

```
fix | bug | hotfix | patch | crash | broken | incident | emergency |
regression | issue
```

If your team writes commits in a different language, fixguard will scan
successfully but find **zero** fix commits — a silent failure mode. In that
case `fixguard scars` prints a loud yellow warning explaining the cause, and
asks you to extend `fixKeywords` in `.fixguardrc.json`. Examples:

| Language | Suggested keyword addition |
|---|---|
| 中文 (Chinese) | `修复\|修正\|修复bug\|补丁\|紧急修复` |
| 日本語 (Japanese) | `バグ修正\|修正\|不具合修正\|緊急修正` |
| 한국어 (Korean) | `버그\|수정\|버그수정\|핫픽스` |
| Deutsch (German) | `Fehler\|behoben\|Fehlerbehebung\|Hotfix` |
| Français (French) | `correction\|correctif\|bogue\|erreur` |
| Español (Spanish) | `corrección\|corregir\|fallo\|error` |

Mix your language with the English defaults using `|`:

```json
{
  "fixKeywords": "fix|bug|hotfix|修复|修正|バグ修正|Fehler|correction"
}
```

fixguard handles CJK word boundaries correctly — `修复` will match inside
`修复登录bug` without needing spaces around it.

## Works well for / needs tuning for

fixguard is built on assumptions about git history and commit conventions.
Be honest about what works out of the box vs what requires tuning:

**Works well out of the box:**
- Projects with English `fix:` conventional commits
- JavaScript / TypeScript / Python / Go / Rust / Java codebases
- Projects using Husky (`fixguard bootstrap` auto-detects and commits)
- Repos with at least a few months of history and real bug fixes

**Needs `.fixguardrc.json` tuning:**
- Non-English commit messages (set `fixKeywords`)
- Custom generated-file directories (set `ignore`)
- Very large diffs that are actually fixes (lower `scarThreshold` to 0.40)
- Projects with hundreds of scars per file (raise `maxScarsPerInjection`)

**Doesn't work yet (future work):**
- HTML/CSS-only projects (no guard clause shapes to detect)
- SQL migration files (no code shape signals)
- Projects with fully squash-merged history (PR titles mask the fix keywords)
- Monorepos where generated dirs live in `packages/*/dist/` (the default
  ignore patterns assume top-level `dist/`)
- Repos with < 10 commits (not enough signal to score commits usefully)

## Performance

A 197-file / 1,500-commit project scans in ~6 seconds (single-pass
`git log -p --grep` + parallel `git blame` across 8 workers). The hook
itself runs in < 50 ms per tool call (cached `scars.json` load keyed
on mtime). Blood log rotates at 10 MB.

## Why not just write tests?

Tests catch regressions of behaviour you remembered to test. fixguard
catches the moment **the line itself** changes — before any test runs
— and gives the AI the **reason** the code looks the way it does. Tests
and fixguard solve adjacent problems. Use both.

## Why no human review step?

Earlier versions had a `fixguard review` command that generated a
triage markdown with checkboxes. It was abandoned because it violated
the project's core promise: "AI knows automatically." A tool that
requires periodic human curation becomes just another linter, and
linters get disabled.

**The rule:** any feedback loop in fixguard takes the form of "improve
the algorithm," not "improve the data." When a real bug shows the
detector missed a valid fix (as happened during self-application), the
fix is to add a new signal, not a manual allow-list.

## Self-application

fixguard is installed on its own git repository. The tests in this repo
protect the tests. The scars from the two real bug fixes in its own
history (`ca2bd9f` archived-scar leak and `120909f` size-bucket edge
case) are currently active and will block any AI from silently
reverting them. See `DESIGN.md` §12 for the timeline.

## Design document

`DESIGN.md` (in this repository) is the project's long-form memory —
the five mechanisms of AI amnesia, the biological metaphors and why
they're load-bearing, every dead end and how it was resolved, and the
full list of decisions with their rationale. Read it before adding a
new layer.

## License

MIT © Eason Zhen
