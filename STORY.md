# How fixguard was designed: the architecture of a tool that teaches AI to remember

> This is the story of how a 2-day conversation between a developer and an
> AI produced a tool that protects bug fixes from being silently reverted
> by other AI. The architecture wasn't planned in advance — it grew from
> a series of insights, each one reshaping what came before.

---

## The bug that happened twice

You spend four hours tracking down a race condition. You find it: a
missing `iat` check in the JWT validation path. You add three lines. You
commit. You move on.

Three weeks later, a new Claude Code session helps you refactor the auth
module. It has no memory of your four-hour debug marathon. It sees an
`if` statement that "looks redundant" and removes it — along with your
fix. The refactored code is cleaner, passes all existing tests, and
silently reintroduces the vulnerability you already spent four hours
diagnosing.

This isn't a bug in Claude Code. It's a structural property of every
AI coding assistant on the market today.

## Five mechanisms that make this inevitable

Not one failure mode — five, stacked:

1. **Context compression.** LLMs have finite windows. The reason a line
   exists — explained 3,000 tokens ago — is dropped by token 50,000.
   The line survives; its story doesn't.

2. **Statistical bias toward "clean."** A defensive check with no nearby
   comment looks, to the model's training distribution, like dead code.
   The prior is to remove it.

3. **Session isolation.** Yesterday's Claude is not today's Claude.
   There is no shared memory between sessions. Every conversation starts
   from scratch.

4. **Whole-file rewrite preference.** When asked to modify a function,
   the model's optimal output is to rewrite it whole. Lines it doesn't
   understand simply don't appear in the new version. They aren't
   "deleted" — they're never regenerated. This makes the failure
   invisible in diffs.

5. **Review asymmetry.** 200 lines generated in 30 seconds. A 3-line
   fix removed inside a 50-line green diff. You scan it in 30 seconds
   and say "looks good." The fix is gone.

No future model solves this. Mechanisms 1, 3, and 5 are architectural,
not intelligence-bound. The information has to live somewhere the AI
**must** encounter it, every time, without depending on its memory.

## First attempt: manual markers (and why it failed)

The obvious answer: put a comment above every fix.

```js
// @fix [auth-jwt] "Don't remove the iat check — bypass attack Dec 2025"
if (!payload.iat || payload.iat > now) throw new Error('bad iat');
```

We built this. It worked — for about a week. Then we stopped adding
markers, because humans forget. The tool's core assumption — "the
developer will remember to mark every fix" — was itself a form of the
amnesia problem. We were asking the forgetful to remember to remember.

## The insight that changed everything

The fix wasn't in adding markers. The fix was in **seeing what's already
there.**

Every `git log` contains the full record of which commits were bug
fixes. Every `git blame` maps each current line to the commit that
introduced it. If a line was born in a commit whose message says
`fix: jwt iat bypass`, that line is — by definition — code that exists
because of a past bug. It's a **scar**.

The memory was always in the codebase. Nobody was reading it.

## Building the eye: multi-signal scar detection

A commit message containing "fix" doesn't always mean "real bug fix."
It could be "fix typo," "fix lint," or "feat: new dashboard, fix
naming." Single-keyword detection produces false positives.

We built a multi-signal scoring engine. Each commit is evaluated against
seven independent signals:

- **Subject keywords** (fix/bug/hotfix) — but weighted down if mixed
  with feat/refactor
- **Diff size** — small, targeted changes score higher than sweeping
  rewrites
- **Guard-clause shape** — does the diff add `if/throw/return/assert`
  patterns? That's defensive code, not feature code
- **Test co-change** — did this commit also add a regression test?
  Strong signal.
- **Revert proximity** — was there a revert in the past 7 days?
  Incident response.
- **Commit timing** — weekend and late-night commits correlate with
  hotfixes
- **New-file vs modification** — a 4-line fix alongside a 100-line new
  test file should be scored on the 4 lines, not the 104

A commit becomes a "scar source" only when its combined score crosses
0.50. No single signal is strong enough alone. The system was validated
against a real ~1,500-commit production web app: ~80 commits crossed the
threshold, producing hundreds of scar regions across hundreds of files.
The top ten were all textbook production bugs.

## The biological metaphor (and why it's not decoration)

Throughout the design process, we used biological language: scar, blood,
hippocampus, sleep, eye. At several points we tried to switch to neutral
engineering terms. Each time, we lost a design constraint that the
metaphor had been carrying.

The metaphor turned out to be load-bearing on **three layers**:

**Layer 1 — Engineering constraints.** "Sleep cycle" forced us to design
consolidation as an explicit phase with a trigger, not continuous
background work. "Fail-open" became obvious once framed as "a numb limb
is safer than a seizure."

**Layer 2 — Human communication.** "Scar" vs "protected region" — one
sticks, one doesn't. Tools that feel coherent get used.

**Layer 3 — AI prior activation.** This is the subtlest layer. The word
"scar" carries billions of tokens of pretraining weight from medical and
biological corpora. When fixguard injects "this is a scar region" into
the AI's context, the model already knows — from prior training — that
scars exist because of healed damage, should not be removed casually,
and carry stories about past incidents. We didn't have to teach it any
of this. The vocabulary does the work for free.

If we had named the same concept `protected_region_abc1234`, the AI
would see a neutral identifier and rely entirely on explicit rules. With
"scar," it brings its own priors to bear. This is prompt engineering by
vocabulary choice.

## Three concentric rings

The architecture organized itself into three rings:

**Static ring** (derived from git, rebuildable):
`git log` → multi-signal scoring → `scars.json`. Delete the scar map
and regenerate it identically. This is a cache, not state.

**Runtime ring** (stateless, per-call):
Every Claude Code `Read/Edit/Write` passes through a PreToolUse hook.
The hook loads the scar map, checks for overlaps, and either injects a
warning into the AI's context (for reads) or blocks the operation with a
reason (for edits targeting scar regions). Every decision is logged to an
append-only event file — the "blood log."

**Learning ring** (self-correcting, durable):
A sleep cycle reads the blood log, updates per-scar weights (scars that
get blocked gain weight; scars that get bypassed lose weight), discovers
cross-scar patterns (pairs of scars blocked together in multiple
sessions suggest structural coupling), and produces a human-readable
"dream report."

The learning ring is what makes fixguard more than a static rule engine.
A scar that keeps getting bypassed will eventually cross the archive
threshold and silently retire — no manual curation needed. A scar that
keeps getting attacked will gain weight and stay prominent. The system
self-corrects based on observed usage.

## Self-application: the tool protecting itself

The strongest validation was installing fixguard on its own repository.
The scanner found its own bug-fix commits and created scar regions
protecting the code that does the scanning.

During self-application, two bugs were discovered that no external
testing had caught:

1. **A commit that bundles a fix with a new test file** looked like
   "large refactor" to the size-bucket heuristic. The fix: separate
   "modified lines" from "new-file lines" in the scoring logic.

2. **Husky compatibility.** Most modern JS projects use Husky, which
   redirects git hooks to `.husky/pre-commit`. fixguard was writing to
   `.git/hooks/pre-commit` — a location git silently ignores on Husky
   projects. The fix: detect `core.hooksPath` and install to the right
   place.

Both bugs were invisible in unit tests. They only surfaced when the tool
operated on its own codebase in realistic conditions. This is why
self-application is not a marketing stunt — it's a quality instrument.

## What it looks like in practice

```bash
$ fixguard bootstrap

fixguard bootstrap
  one-command install for this repo

  1/4 Installing hooks…
  2/4 Committing hook install…
      ✓ committed 3 file(s)
  3/4 Scanning git history for bug fixes…
      ✓ found 438 protected region(s) from 212 fix commit(s)
  4/4 Protection is live.
```

From this moment on, any Claude Code session that reads a scarred file
sees a system-level warning. Any attempt to edit a scarred line is
blocked with a reference to the original commit. Any `git commit` runs
through a pre-commit check. Every decision is logged, and the learning
ring adjusts weights on each sleep cycle.

The developer does nothing. No markers. No config. No triage. The tool
reads git history, scores commits, maps scars to current code via
`git blame`, and places the relevant ones in the AI's perception path
before every action.

## Why no one else has built this

Every major AI coding tool vendor — Anthropic, OpenAI, Cursor, Codeium
— has the primitives to build this. Claude Code ships `additionalContext`
injection. Cursor has `.cursorrules`. GitHub Copilot has knowledge
contexts. None of them ship an opinionated "protect your bug fixes"
product.

The gap exists because:

- Big companies build **platforms**, not **vertical tools**. They
  expose hook interfaces and expect the ecosystem to fill in the
  specifics.
- The problem is **loudest at the individual developer level**, which
  is the hardest market to monetize.
- A tool that **blocks an AI edit** has liability risk if it's wrong.
  Large companies are conservative about shipping blocking tools.
- The engineering is **boring** — git blame, regex, JSON, shell hooks.
  Top researchers don't do this. It's the kind of thing a solo
  developer builds after getting burned one too many times.

This is a gap that will close in 12-18 months as the AI coding market
matures. fixguard exists to fill it now.

## The product promise

> fixguard ensures that any AI editing your codebase cannot accidentally
> remove a line that was added to fix a real bug, by automatically
> discovering those lines from your git history and placing them in the
> AI's perception path before every edit.

Everything in the architecture — every signal weight, every hook
decision, every sleep cycle, every biological term — exists to make
that one sentence true.

---

*fixguard is MIT-licensed, zero-dependency, ~3,000 lines of Node.js.
It installs in 60 seconds, scans a 1,500-commit repo in under 10
seconds, and protects itself with its own scar map.*

*Built by Eason Zhen.*
