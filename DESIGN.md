# fixguard — Design

> This document is the project's memory. It exists so that future readers
> (humans or AI) can recover the **why** behind decisions that the source
> code cannot explain by itself.
>
> Fixguard is a tool for protecting bug fixes from being silently reverted
> by AI assistants. The irony is not lost on us — if fixguard is doing its
> job, this document is the kind of context it ensures is never lost.

---

## 1. Why fixguard exists

You spend four hours tracking down a subtle race condition. You fix it.
Three weeks later, Claude Code / Cursor / Copilot — having no memory of
that battle — refactors the file and quietly removes your fix. Production
breaks. You spend four more hours rediscovering the same bug.

This is not a bug in any single AI tool. It is a structural property of
how this generation of AI assistants relate to code. Fixguard exists to
break the loop.

## 2. Five mechanisms of AI amnesia

The failure mode above is not an accident. It is the inevitable result of
**five independent mechanisms** that combine to make repeated forgetting
mathematically certain. Understanding these is the foundation of every
design decision in this codebase.

### 2.1 Limited context, lossy compression
LLMs have no persistent memory. Each conversation begins from training
weights plus whatever fits in the context window. When the window fills,
older content is summarized or dropped. The reason a particular line of
code looks the way it does — explained 3,000 tokens ago — is gone by
token 50,000.

### 2.2 Statistical bias toward "cleaning"
LLMs are trained on a corpus where good code is concise, idiomatic, and
free of unexplained checks. A defensive guard clause with no nearby
comment looks, statistically, like dead code or overcautious noise. The
model's prior is to remove it. Refusing this is uphill work, and the
model has no reason to refuse if it doesn't know there is one.

### 2.3 Session isolation
Each new conversation is a stranger. There is no continuity of memory
between sessions — yesterday's Claude and today's Claude are different
instances of the same model with no shared state. Any plan that depends
on the AI "remembering" something across sessions is structurally
guaranteed to fail.

### 2.4 Whole-file rewrite preference
When asked to modify a function, the optimal output (by training
objective) is often to rewrite the function and present it whole. This
maximizes coherence and user satisfaction in the immediate response. But
in a rewrite, lines the model does not understand simply do not appear
in the new version. They are not "deleted" — they are **never
regenerated**. This makes the failure invisible in diffs.

### 2.5 Review asymmetry
The AI generates 200 lines in 30 seconds. The human reviews 200 lines in
30 seconds. A 3-line fix removed inside a 50-line addition is statistically
guaranteed to be missed. This is a structural property of the
human-attention vs AI-throughput ratio, not a flaw fixable by "being
careful."

### 2.6 Combined effect
Each mechanism alone is tolerable. Combined, they produce **inevitable
repeated loss of fixes** over time. No future smarter model will solve
this — mechanisms 1, 3, and 5 are architectural, not intelligence-bound.

The only way out is to put the protective information somewhere that:
- Persists across sessions (defeats #1, #3)
- Is impossible to miss when reading the code (defeats #2)
- Cannot be silently regenerated away (defeats #4)
- Triggers automatic intervention (defeats #5)

## 3. Design principles

| Principle | Defeats |
|---|---|
| State must live in the file system, not in conversation context | #1, #3 |
| The AI must encounter scar information by *passing through it*, not by *deciding to look it up* | #2, #4 |
| Detection must be automatic — no human triage of false positives in the steady state | All of them, indirectly |
| Confidence must be explicit (each decision carries a score and signal trace) | Auditability |
| Failure must be fail-open (a broken hook never blocks legitimate work) | Adoption |
| Bypass must exist but be loud | Trust |

## 4. The biological metaphor (and why it matters)

The architecture is described in terms borrowed from neurobiology. This
is not decoration. The biological model produced concrete engineering
constraints that purely mechanical thinking missed.

| Biological concept | Fixguard mapping | What it forced us to consider |
|---|---|---|
| Blood | Source code itself (functions, calls) | Memory cannot live *outside* the code; it has to live *as* the code |
| Heart | Test runner | Tests are how the system proves it is still alive |
| Hippocampus | The scar map (`scars.json`) | Short-term, queryable, bridges acute events to long-term storage |
| Edge / amygdala | Multi-signal commit scoring | What constitutes a "memorable event" must be defined by signals, not by user intent |
| Sleep / consolidation | `fixguard sleep` cycle | Filtering and forgetting are first-class operations, not afterthoughts |
| Eye / projection | The Claude Code hook (`hook.js`) | The AI's perception channel must be wrapped, not augmented |
| Scar tissue | Code added in fix-commits | Memory IS the defensive code itself, not a description of it |

The key insight: **scars are not metadata about code. Scars are the
code that was added in response to past bugs.** This collapses the
whole "external memory store" problem. The memory was always already in
the codebase. Fixguard does not store memory; it makes already-existing
memory **visible**.

## 5. Architecture

```
           ┌──────────────────────┐
           │   git history        │   (the immutable substrate)
           └──────────┬───────────┘
                      ↓
            ┌─────────────────┐
            │  signals.js     │   multi-signal scoring
            └────────┬────────┘
                     ↓
            ┌─────────────────┐
            │  scars.js       │   eye: git blame + enrich with weights
            └────────┬────────┘
                     ↓
          ┌──────────────────────┐          ┌──────────────────────┐
          │ .fixguard/scars.json │◄────────►│ .fixguard/weights.js │
          │  (derived, ephemeral)│  enrich  │  (learned, durable)  │
          └──────────┬───────────┘          └──────────▲───────────┘
                     │                                 │
       ┌─────────────┴─────────────┐                  │
       ↓                           ↓                  │
  ┌──────────┐                ┌──────────┐           │
  │ hook.js  │                │ check.js │           │
  │ (run-    │                │ (commit- │           │
  │  time)   │                │  time)   │           │
  └────┬─────┘                └────┬─────┘           │
       │                           │                  │
       └─────────── write events ──┴────→ events.jsonl│
                                                │     │
                                                ↓     │
                                           ┌─────────────┐
                                           │  sleep.js   │
                                           │  · weights  │── updates
                                           │  · patterns │── discovers
                                           │  · dream    │── reports
                                           └──────┬──────┘
                                                  ↓
                                        .fixguard/patterns.json
                                        .fixguard/dreams/*.md

                        ┌──────────────┐
                        │  status.js   │   one-screen diagnostic across
                        │  (read all)  │   scars/weights/patterns/events
                        └──────────────┘
```

The system is organized in three concentric rings:

1. **Static ring** (git → signals → scars.json): derived from history, rebuilt on demand.
2. **Runtime ring** (hook → check → events): enforces protection and records every decision as blood.
3. **Learning ring** (sleep → weights → patterns): consumes the blood log to self-correct memory and discover cross-scar structure.

Static is ephemeral (delete scars.json and regenerate identically). Runtime is stateless per-call. Only the learning ring carries durable learned state.

## 6. Components

### 6.1 `src/signals.js` — multi-signal scoring engine
**Purpose:** decide whether a commit is a real bug fix worth remembering.

Each commit gets seven independent signals scored and summed. A commit
becomes a scar source only when the combined score exceeds 0.50. No
single signal can carry the decision alone (the strongest, "clean fix
keyword in subject", is 0.40 — must be supplemented by at least one more).

**Why multi-signal:** an earlier version used a single heuristic (`grep
the commit subject for fix-keywords`). It produced 878 scars on
AlphaClaw, of which roughly one in six came from a single false positive
("feat: Sentry monitoring, ... fix free-count route"). The single-keyword
approach is structurally unable to distinguish a feat-with-side-fix from
a real fix. Multi-signal scoring resolves this without requiring human
triage.

**Signals (current weights):**

| Signal | Weight | Meaning |
|---|---:|---|
| `cleanFixKeyword` | +0.40 | Subject has fix-token, no noise/feat words |
| `mixedFixKeyword` | +0.20 | feat/refactor + fix in same subject (reduced credit) |
| `dirtyFixKeyword` | +0.05 | fix + noise (typo/lint/etc) |
| `noisePenalty` | −0.20 | typo/lint/format/style/cleanup keyword present |
| `smallDiff` | +0.15 | < 30 lines (targeted fix) |
| `mediumDiff` | +0.05 | 30–99 lines |
| `largeDiff` | −0.20 | ≥ 200 lines (likely refactor) |
| `mixedLargeFalsePositive` | −0.25 | Triggered when `mixedFixKeyword` AND `largeDiff` both fire (the Sentry-case fix) |
| `guardShape` | +0.20 | Diff dominated by if/throw/sentinel-return/assert lines |
| `mixedShape` | +0.05 | Some guards, some features |
| `featureShape` | −0.10 | Diff dominated by new function definitions |
| `testCoChange` | +0.15 | Diff touches both src and test files (regression test added) |
| `recentRevert` | +0.15 | A revert occurred within the previous 7 days |
| `unusualTime` | +0.05 | Weekend or late-night commit (correlates with hotfixes) |

**Threshold:** 0.50.

**Validated against AlphaClaw:** 80 unique commits cross the threshold,
producing 481 scar regions across 197 files. Score distribution is
roughly bell-shaped with a peak in the 0.70–0.79 band. The top ten
highest-confidence commits are all real production bugs (jwt iat bypass,
iOS touchend, language persistence, etc).

### 6.2 `src/scars.js` — the scar detector ("eye")
**Purpose:** combine signals + `git blame` to find which lines of the
*current* code were born in a high-confidence fix commit.

Walk: list all commits → cheap pre-filter by fix keyword → enrich
candidates with diff stats and added-line samples → score → keep
high-score commits → for every tracked text file, run `git blame
--line-porcelain` → mark lines whose commit is in the high-score set
→ group consecutive scar lines into regions.

**Why git blame, not patch tracking:** patch-forward tracking through
history is fragile (renames, rebases, reorderings break it). Git blame
is the inverse direction — start from current state and ask "which
commit introduced this line." This gives us the right answer regardless
of how the file got to its current shape.

**Skipped automatically:** binary files, lockfiles, generated bundles,
vendor/, node_modules/, dist/, build/, anything > 512KB. These cannot
carry meaningful "scars" — they are mechanical output, not human
authorship.

### 6.3 `src/sleep.js` — consolidation cycle ("dream report")
**Purpose:** compare current scar map to last sleep, run the learning
ring (weights update + REM pattern discovery), and render a
human-readable dream report.

The dream report has three sections:
- **Delta against last sleep**: new scars, vanished scars, recurring pain
- **Blood-log activity**: deny count, allow_with_context count, bypass
  count, stale-map warnings, most-attacked files
- **Memory dynamics**: reinforced / eroded / archived / unarchived
  scar counts from the weights update cycle
- **Cross-scar patterns**: pairs of scars blocked together in ≥2 sessions
  (see §6.11)

The dream report exists to give the user a **visible moment of value**
every sleep cycle. An invisible system feels like it does nothing, and
gets uninstalled. The dream report is fixguard's product surface.

### 6.4 `src/hook.js` — Claude Code PreToolUse entry
**Purpose:** intercept every Read/Edit/Write/MultiEdit call from
Claude Code, look up the affected file's scars, and inject a response
the model will see.

**Behavior by tool:**
- **Read** of a scarred file → `permissionDecision: allow` plus
  `additionalContext` containing the scar list and a warning. The AI's
  next turn includes both the file content and the warning.
- **Edit** whose `old_string` overlaps a scar region → `deny` with
  `permissionDecisionReason` listing the scars and explaining how to
  proceed (acknowledge intent, set FIXGUARD_BYPASS=1, or modify
  something else).
- **Edit** that doesn't overlap → `allow` with a gentle nudge about
  scars elsewhere in the file.
- **Write** to a file with any scars → `deny` (whole-file overwrite
  destroys all scars).
- **MultiEdit** with any edit overlapping a scar → `deny` for the whole
  batch.

**Fail-open by design.** Empty stdin, malformed JSON, missing
scars.json, unknown tool — all return `allow`. A broken hook must never
block legitimate work; the worst case is loss of protection, never loss
of productivity.

**Bypass:** `FIXGUARD_BYPASS=1` in the environment causes the hook to
return `allow` immediately without consulting any scars. Loud,
explicit, and intentionally inconvenient enough to force a moment of
human reflection.

### 6.5 `src/check.js` — git pre-commit interceptor
**Purpose:** the last line of defense. If the hook somehow missed an
edit (different AI tool, manual editor, etc), pre-commit re-checks the
staged diff against both `@fix` markers and `scars.json`.

**Consistency with hook.js:** check.js and hook.js must agree on which
scars are "active." Both now load the scar map through
`loadScarMap(cwd)`, which enriches each scar with weight state from
`weights.json`. Both filter out archived scars (weight < 0.30) before
checking. A scar archived by the learning ring is silent at both
runtime and commit time — one memory, one behaviour.

Why both paths? `@fix` markers are kept for backward compatibility and
for **negative-space memories** — facts about decisions or intentions
that git history cannot capture (e.g., "we deliberately do not retry
here because the upstream already does"). Auto-detected scars cover
the bulk case; manual markers cover the edge cases.

### 6.6 `src/init.js` — installer
**Purpose:** make the system real with one command.

`fixguard init` does three things atomically:
1. Installs (or merges into) the project's git pre-commit hook.
2. Installs (or merges into) `.claude/settings.json` with the
   PreToolUse matcher pointing at `fixguard hook`.
3. Drops a sample `.fixguardrc.json`.

The Claude Code hook command uses an absolute path to this
installation's `cli.js`, so it works whether or not `fixguard` is on
PATH globally.

### 6.7 `src/markers.js`, `src/scan.js`, `src/diff.js`
v0.1 components, retained. They handle the manual `@fix` marker path
described in §6.5.

### 6.8 `src/review.js` (intentionally orphaned)
A reviewable-markdown generator built during one of the design loops.
Not wired into the CLI. It exists as evidence that **a human-in-the-loop
calibration mode was tried and rejected** — the project's core promise
is "AI knows automatically." If we ever need a debug surface for
inspecting the scar map, this file is the starting point.

### 6.9 `src/events.js` — the blood layer
**Purpose:** an append-only log of every non-trivial fixguard action,
stored as JSONL at `.fixguard/events.jsonl`.

Writers: `hook.js` (deny, allow-with-context, bypassed, stale_map),
`scars.js` (scan), and — planned — `sleep.js` itself and test runners.
Readers: `sleep.js`, `status.js`, and anything else that needs to know
"what just happened."

**Event types (v1.1):**
- `hook.deny` — edit/write blocked; includes `scarIds` array so
  `weights.js` can attribute reinforcement to the specific scars
- `hook.allow_with_context` — read/edit of a scarred file where
  context was injected
- `hook.bypassed` — FIXGUARD_BYPASS=1 used; audited, not silent
- `hook.stale_map` — hook detected HEAD differs from scars.json headSha
- `scars.scan` — a scan was run

**Only interesting events are logged.** Silent allows (no scars,
unknown tools) are skipped — otherwise the log would fill with noise
from every AI file read. The rule: if fixguard made a decision worth
looking at later, log it. If it was a no-op, don't.

**Rotation:** when `events.jsonl` exceeds 10 MB it rotates to
`events.1.jsonl` (up to 3 generations), so the log cannot grow without
bound over weeks/months of use.

**Queries:** `readEvents(cwd, { since, type, limit })` supports filtering
by timestamp, by type (single or array), and trimming to last N events.
Used by sleep, status, and the `fixguard events` CLI command.

This layer is what makes the learning ring possible. Without a blood
log, the system would have no way to observe its own behaviour.

### 6.10 `src/weights.js` — learned state, self-correction
**Purpose:** per-scar mutable state that survives scan regeneration.

`scars.json` is rebuilt every time `fixguard scars` runs — it is a
pure function of git history. Anything we want to LEARN about a scar
(is it reinforced? does the user keep bypassing it? should it be
archived?) has to live elsewhere. That elsewhere is
`.fixguard/weights.json`, keyed by full scar SHA.

**Per-scar fields:**
```
{
  weight: 0.0–1.0 (starts at 1.0),
  blockCount: int,
  bypassCount: int,
  allowCount: int,
  lastObserved: ISO timestamp,
  archived: bool (derived from weight)
}
```

**Update rules (applied in each sleep cycle, processing events since
last sleep):**
- `hook.deny` targeting this scar → weight += 0.05 (reinforcement)
- `hook.bypassed` on this scar's file → weight -= 0.15 (erosion)
- Base decay: weight -= 0.02 per cycle for untouched scars
  (reinforced scars escape base decay in the same cycle)
- weight < 0.30 → `archived = true`, hook/check both stop injecting
- weight >= 0.30 → unarchived (scars can come back from the dead)

**Why these numbers:** 5 bypasses of the same file (5 × 0.15 = 0.75)
pushes a fresh scar from 1.00 → 0.23, crossing the archive threshold
in a single cycle. A scar that's being actively hit (blocked) gets
+0.05 per hit AND escapes base decay, so defense reinforces defense.
Quiet scars drift slowly toward archival over months, not weeks.

**Integration with scars.js:** `loadScarMap(cwd)` automatically calls
`enrichWithWeights(cwd, map)`, so every downstream caller (hook,
check) sees the same view. There is no "enriched vs raw" ambiguity
— raw scars.json is never consumed directly after load.

**This layer is what resolves dead-end §7.3** (memory becomes friction).
Outdated scars get demoted automatically, without manual curation.

### 6.11 `src/patterns.js` — REM-style cross-scar coupling
**Purpose:** find pairs of scars that get blocked together across
multiple sessions, then surface them as structural coupling signals.

**Algorithm:**
1. Group `hook.deny` events by `session_id` → each session is a set
   of scar SHAs that got touched.
2. For every session with ≥ 2 scars, compute all pairs (N × (N-1) / 2
   combinations).
3. Canonicalize each pair as a sorted `"shaA|shaB"` key.
4. Increment cumulative co-occurrence counts in
   `.fixguard/patterns.json`.
5. A pair crossing the confirmation threshold (`≥ 2 distinct sessions`)
   is promoted to "confirmed pattern" and surfaced in the dream report.

**Why the confirmation threshold:** a pair seen in a single session is
a coincidence — the same conversation happened to touch two scars
that may or may not be related. A pair seen in TWO separate sessions
is a pattern — the coupling has been observed independently. This
mirrors the "real insights repeat, false insights don't" heuristic
from the original REM design discussion.

**What patterns reveal:**
- Same-file coupling: scars on different lines of the same file
  frequently blocked together → probably a single architectural
  concern (e.g., input validation on L42 and L89 both guarding JWT
  payload fields).
- Cross-file coupling: scars in `auth.js` and `chat.js` blocked
  together → bilingual middleware touches both, they're structurally
  linked.
- Cluster discovery: a group of scars all blocked in one session →
  a cluster that might benefit from refactoring as a unit.

**Only DENY events are used, not allow-with-context.** Denies are
high-signal: "the AI actively tried to touch this." Allow events are
much noisier — they happen on every Read, even when the AI wasn't
targeting anything.

This layer is what gives fixguard a **cross-scar view**. The weights
layer makes each scar learn its own life cycle; patterns lets scars
learn their **relationships**.

### 6.12 `src/status.js` — one-screen diagnostic
**Purpose:** single entry point to see the health of all five state
files at once.

As the learning ring grew (scars.json + weights.json + patterns.json +
events.jsonl + last-sleep.json), inspecting the system required
opening five files in the right order. `fixguard status` collapses
that into a one-screen printout:

- Scar map: active count, archived count, generated-at, headSha vs
  current-HEAD (stale marker in red)
- Weight distribution: bucketed histogram + lifetime totals
- Patterns: candidate and confirmed counts
- Blood log: last-24h event counts by type
- Last sleep: timestamp + relative age
- Health summary: `✓ healthy` or a list of warnings

**Design rule:** status must answer questions users actually ask. Every
line in the output maps to a real debugging question:
- "Is this project protected?" → active scar count
- "When did I last scan?" → generated-at + relative
- "Is the scar map stale?" → headSha comparison
- "Why did a scar disappear?" → archived count + weight distribution
- "What has fixguard been doing?" → blood log 24h summary

If a field in status.js doesn't map to a user question, it doesn't
belong there. Keep it terse.

## 7. Dead ends, resolved and unresolved

### 7.1 RESOLVED: Position vs content binding
*Concern:* a scar bound to `(file, line)` would drift away from its
target during refactors.

*Resolution:* `git blame` always returns the *current* line number for
each line's birth commit. The scar map is regenerated on each `fixguard
scars` run. Drift is impossible because there is no persistent line
binding — the line number is recomputed from current state every time.

### 7.2 RESOLVED: Read-time injection survival
*Concern:* if we tried to embed scar warnings as text inside the file
that AI reads, the AI's whole-file-rewrite tendency would erase them.

*Resolution:* we don't embed in the file content. The Claude Code hook
returns `additionalContext`, which is appended to the AI's *system
context*, not to the file's text. AI cannot "echo it back" or "rewrite
it away" because it never appears as a tool result.

**Source:** Claude Code hooks documentation specifies
`additionalContext: "String added to Claude's context"` for PreToolUse
events. Verified at https://code.claude.com/docs/en/hooks .

### 7.3 RESOLVED: Memory becomes friction
*Concern:* a scar that becomes outdated could block legitimate refactors
and turn the system into a nuisance.

*Resolution (v1.1):* `src/weights.js` now implements automatic erosion.
Each `hook.bypassed` event on a scar's file subtracts 0.15 from the
scar's weight. After roughly 5 bypasses a fresh scar crosses the 0.30
archive threshold and becomes silent at both hook time and commit time.
Scars that stay relevant (get blocked, not bypassed) gain weight
instead. No manual curation. See §6.10.

**Status:** solved, with the caveat that the numbers (0.15 erosion,
0.30 threshold) are tuned by intuition, not measurement. We'll revisit
them once real users produce enough bypass data to see whether the
curve is too fast or too slow.

### 7.4 RESOLVED: Whose judgment decides what's a scar
*Concern:* relying on user-marked `@fix` comments puts maintenance
burden on humans, and humans forget.

*Resolution:* multi-signal automatic detection (§6.1). The user's role
collapses to running `fixguard scars` once. Future detection
improvements happen by changing the algorithm, not the data.

### 7.5 RESOLVED: Different personalities, different signals
*Concern:* if we tried to detect "user emotion" from chat/typing,
introverts and dramatic users would score differently.

*Resolution:* the detector reads only **code-level signals** (commit
messages, diff shapes, revert proximity, test co-change). Personality is
not consulted. The same algorithm works for any user.

### 7.6 RESOLVED: Token budget for injection
*Concern:* a project with 50 scars all injected into context every Read
could itself become a context-pressure problem — recreating the
forgetting issue at a meta level.

*Resolution (v1.1):* `hook.js` now ranks scars by
`confidence × recency-decay` with a configurable half-life (default
180 days), and injects only the top N per file (default 5, via
`maxScarsPerInjection`). A file with 149 scars (AlphaClaw's
`static/index.js`) injects ≈ 5 ranked scars plus a short note
`"144 more not shown — showing top 5 by confidence + recency"`. For
Edit events that don't overlap any scar, a separate proximity-based
ranking shows the nearest 3 scars to the edit target instead of an
arbitrary subset.

**Also addressed in v1.1:** per-session injection dedup. If a session
reads the same file twice, the second read gets a brief pointer
`"reminder: N scars here, full list was injected earlier"` rather
than the full payload, further cutting token usage in long sessions.

### 7.7 UNRESOLVED: Negative-space memories
*Concern:* "we considered Redis but chose Postgres because X" cannot
be attached to any specific line of code.

*Status:* the manual `@fix` marker path remains for these cases. There
is no automatic detection planned — this is a category of memory that
fundamentally needs a human author.

### 7.8 UNRESOLVED: AI agent era
*Concern:* if the AI is the primary editor, behavioral signals from
"the user's struggles" don't apply — the agent's own retries flood
the signal.

*Status:* not yet a problem because the current detector reads only
git history (committed state), not real-time tool retries. When
real-time signals are added, this will need separate handling.

## 8. Decisions documented for future reference

### 8.1 Why no human review step
We built a `fixguard review` command that generated a triage markdown
with checkboxes. The user pointed out that this directly contradicts
the project's core thesis: "AI should know automatically." A tool that
requires periodic human triage is **just another linter**, which is
exactly what fixguard is not. The review path was abandoned.

The lesson encoded: **any feedback loop in fixguard must take the form
of "improve the algorithm," not "improve the data."**

### 8.2 Why scars are derived, not stored
We considered an external scar database that would survive rewrites
and refactors. We rejected it because:

- A database is not durable across forks/clones unless it's in git.
- If it's in git, it's the same as keeping `scars.json` in git.
- If `scars.json` is the truth, why store anything separate at all?

`scars.json` is the cache of a derivable function (`detectScars(repo)`).
The only durable state is the git history itself. This means: **delete
scars.json and rerun `fixguard scars` and you get the same answer.**

### 8.3 Why fail-open everywhere
Hooks that fail-closed (block on error) get disabled within a week.
Every error path in `hook.js` returns `allow`. If fixguard breaks, the
worst case is "AI no longer warned about scars for this session" — not
"AI cannot edit any file." This is the only design that survives
contact with real workflows.

### 8.4 Why the biological metaphor is load-bearing (three layers)

For most of the design conversation we used biological language
deliberately: blood, hippocampus, sleep, eye, scar. Several times we
considered switching to plain engineering language and dropping the
metaphor. We didn't, because the metaphor turns out to carry weight on
**three independent layers** — and each layer does something the other
two cannot do alone.

**Layer 1 — Engineering constraint carrier**

Every time we tried to describe the architecture in neutral terms, a
specific design constraint disappeared. "Sleep cycle" forced us to
think about consolidation as a *phase* with an explicit trigger, not
as continuous background work. "Fail-open" became obvious once we
framed it as "a numb limb is safer than a seizure." "Scar tissue as
executable code" made it clear that memory shouldn't be metadata *about*
code — it IS code that exists precisely because it was added in
response to a past wound. Drop the metaphor and you drop the
constraints it encodes.

**Layer 2 — Human communication**

Biological terms are memorable and coherent in a way dry technical
terms aren't. "Scar" vs "protected region" — one sticks, one doesn't.
A new contributor reading the dream report's "reinforced / eroded /
archived" is instantly oriented; the same information as "score_delta
+0.05 / -0.15 / state_transition=inactive" would require a second pass.
This layer is aesthetic but not trivial: tools that feel coherent get
used, tools that feel bureaucratic get abandoned.

**Layer 3 — AI language-model prior activation** *(added 2026-04-09)*

This is the subtlest and strongest layer. The words "scar," "wound,"
"heal," "bleed," "blood," and "hippocampus" carry **billions of tokens
of pretraining weight** from medical, surgical, biological, and
neurological corpora. When fixguard injects `additionalContext` into
an AI's perception channel containing "this is a scar region from a
past fix," the AI's language model **already knows** — from its prior
training — that scars:

- exist because of healed damage, not random accumulation
- are functionally different from healthy tissue
- should not be removed casually
- carry implicit stories about past incidents
- are the kind of thing a careful practitioner respects

We didn't have to *tell* the AI any of this. The word does the work.
If we had named the same concept `protected_region_4fe4288d`, the AI
would see a neutral identifier and rely entirely on the explicit rules
in the context. With `scar`, it brings its own priors to bear.

This is a form of **prompt engineering by vocabulary choice**. It is
almost free (one word instead of another), but it biases AI behaviour
in a direction that would otherwise require explicit, token-expensive
instructions.

**Why this layer matters for the three primary fixguard surfaces:**

- **AI-facing context injection** (hook.js additionalContext):
  **Use biological terms maximally.** "scar region," "wound," "bleed,"
  "heal," "archived." Every word here is a prior activator.
- **Human-facing CLI output** (scars/status/explain commands):
  **Use biological terms alongside concrete specifics.** Humans get
  coherence from the metaphor AND ground truth from the commit message
  + actual code + line number. Both work.
- **Documentation and code comments** (DESIGN.md, README, source):
  **Use biological terms to name concepts, engineering terms for the
  implementation details underneath.** `sleep.js` is the file, but
  inside it you still see `Promise`, `fs.writeFile`, `JSON.parse`.
  Don't fight the engineering substrate; just name the layer with the
  biological word.

**Why this layer is hard to see until you've built the system:**

You only notice it in the gap between "I wrote explicit rules for AI
behaviour" and "AI just behaves that way without being told." That
gap is where the prior is doing the work. The first time we noticed
this was after implementing the hook output — we tested fixguard on
a real Claude Code session and it started being more cautious than the
rules strictly required, because the word "scar" in the injected
context was activating medical-reasoning priors we hadn't written.

**Lessons encoded here for future additions:**

- When adding a new layer, pick a biological name first and an
  engineering name second. See if the biological name **generates**
  design constraints the engineering name would have missed.
- When writing AI-facing output, **prefer words with strong
  pretraining priors** over invented technical terms. "Blood log" >
  "event stream." "Dream report" > "consolidation summary."
  "Recurring pain" > "high-activity files."
- When deleting biological language, **ask whether you are also
  deleting a prior activation**. If yes, the refactor has a hidden
  cost that shows up as "AI behaves worse after the rename."
- The CLI output in `sleep.js` uses phrases like "memory dynamics"
  and "scars reinforced / eroded / archived / unarchived" precisely
  because those words are themselves injected into the dream report
  markdown, which AI sessions will later read. This is not accidental
  — the dream report is **secondary AI context**, and it is written
  in prior-activating language on purpose.

If you are tempted to refactor this codebase to remove biological
terms, read this section first. The terms are not decoration; they
are three load-bearing mechanisms stacked on one another, and the
third one (AI prior activation) is the one you can't see from the
source tree alone.

## 9. Known limitations

- **Language coverage:** the guard-clause detector uses
  language-agnostic regexes. It works well for JS/TS/Py/Go/Rust/Java
  by accident, not by design. AST-based detection per-language would
  be more accurate but is a significant engineering investment.
- **Hook host coverage:** the `hook.js` entry point is built specifically
  for Claude Code's PreToolUse contract. Other AI tools (Cursor, Cline,
  Aider) have different hook surfaces (or none). Adding them is
  per-tool work.
- **Cold start:** new repos with no history have no scars. The system
  becomes useful only after a project has accumulated some bug-fix
  history. This is a fundamental property, not a bug.
- **Weight-constant tuning:** the erosion/decay numbers in
  `weights.js` (0.15 per bypass, 0.02 base decay, 0.30 archive
  threshold) are intuited, not measured. Real usage data will
  eventually show whether the curves are too aggressive or too lenient.
- **Pattern signal source:** `patterns.js` only consumes `hook.deny`
  events, not `hook.allow_with_context`. This is the right call for
  signal quality (denies are high-intent) but means patterns can only
  form once AI has actually attacked scars. Early in a project's
  lifecycle, pattern discovery is slow.
- **"New-file-alongside-fix" edge case:** a fix commit that also
  introduces a new helper file (even if the actual bug-fix is 3
  lines elsewhere) scores in the `largeDiff` band because the
  total line delta includes all lines of the new file. This crashed
  fixguard's own self-application in April 2026 — a legitimate fix
  commit scored 0.40 (just below threshold) because it was bundled
  with a newly-created 260-line file. Workaround today: commit the
  new file separately from the fix. Real solution: add a signal
  that distinguishes "net new content" from "modified existing
  content" when computing diff size.
- **Resolved and removed:** performance (was 54 s, now 6 s after
  single-pass git log + parallel blame — see §11).

## 10. The product promise, as a single sentence

> Fixguard ensures that any AI editing your codebase **cannot
> accidentally remove a line that was added to fix a real bug**, by
> automatically discovering those lines from your git history,
> learning from how it gets used, and placing the relevant ones in
> the AI's perception path before every edit.

Everything in this document — every architectural choice, every
signal weight, every dead end documented — exists to make that one
sentence true.

## 11. v1.1 changelog (what changed since the first write of this doc)

The original version of this document described a 6-component system
with several open concerns. The following structural additions were
made in a second pass:

### 11.1 Performance (9× speedup)
- `scars.js` previously ran `git show` per candidate commit (N+1 pattern).
  Replaced with a single `git log -p --grep=...` pass, parsed once.
- `git blame` was serial across all tracked files. Now runs in parallel
  with bounded concurrency (default 8 workers).
- Combined effect on AlphaClaw: **54 s → 6 s**.

### 11.2 Configuration (single source of truth)
- New `src/config.js` loads `.fixguardrc.json` and returns a merged
  object with sensible defaults. Previously the rc file was written
  by `init` but never read by anything — pure decoration.
- Now honors: `ignore` (user skip patterns with glob → regex),
  `scarThreshold`, `blameConcurrency`, `maxFileBytes`,
  `sessionCacheTtlDays`, `maxScarsPerInjection`, `recencyHalfLifeDays`.
- `signals.js` exports `FIX_KEYWORDS_SOURCE` — single source of truth
  for the fix-keyword set, re-used by `scars.js` for the git log
  `--grep` pattern. Previously duplicated as a hardcoded string.

### 11.3 Blood layer (§6.9 `events.js`)
- Every meaningful hook/scan action appends a JSONL line to
  `.fixguard/events.jsonl`.
- Drives the learning ring: sleep reads the blood log to update
  weights, discover patterns, and render the dream report.
- Rotation at 10 MB, keep 3 generations.

### 11.4 Self-correcting memory (§6.10 `weights.js`)
- Per-scar mutable state: weight, blockCount, bypassCount, allowCount,
  lastObserved, archived.
- Updated in each sleep cycle from blood-log events.
- Reinforces defended scars, erodes bypassed ones, slowly decays quiet
  ones, auto-archives below 0.30.
- `loadScarMap` now enriches every scar with weight state, so hook.js
  and check.js see a unified view. Archived scars are skipped in both
  places — the inconsistency that existed at first commit is fixed.

### 11.5 REM cross-scar patterns (§6.11 `patterns.js`)
- Pairs of scars blocked in the same session accumulate co-occurrence
  counts in `.fixguard/patterns.json`.
- Pairs crossing the confirmation threshold (≥ 2 distinct sessions)
  surface in the dream report as structural coupling signals.
- Conservative confirmation ("real patterns repeat") prevents false
  insights from polluting the output.

### 11.6 Status diagnostic (§6.12 `status.js`)
- `fixguard status` is the new single entry point for inspecting all
  state files at once: scars, weights, patterns, blood log, last sleep.
- One-screen output, color-coded, with a health summary at the bottom.

### 11.7 Token-budget ranking (resolves §7.6)
- `hook.js` now ranks scars by `confidence × recency-decay` (180-day
  half-life) and injects only the top N per file (default 5).
- A file with 149 scars no longer blows the context window.
- Edit nudge path uses proximity ranking: when an edit doesn't overlap
  any scar, the nearest 3 scars to the target range are shown instead
  of an arbitrary subset.

### 11.8 Session injection dedup
- `hook.js` tracks (session_id, file) pairs in `~/tmp/fixguard-sessions/`.
- First Read of a scarred file gets the full payload; subsequent reads
  in the same session get a brief pointer.
- Cache is GC'd based on `sessionCacheTtlDays` (default 7).

### 11.9 Edit resolution robustness
- `findLineRange` in `hook.js` now normalizes CRLF ↔ LF on both sides
  before matching — a CRLF file with an LF `old_string` still matches.
- Ambiguous `old_string` (multiple matches in the file) is denied
  conservatively rather than matched to the first occurrence.

### 11.10 HEAD staleness detection
- `scars.json` now records `headSha` at generation time.
- `hook.js` compares to current HEAD on every call; mismatch triggers
  a soft warning appended to `additionalContext` and a
  `hook.stale_map` event in the blood log.
- `status.js` shows the comparison as a red "STALE" marker.

### 11.11 Bypass auditing
- `FIXGUARD_BYPASS=1` now emits a `hook.bypassed` event rather than
  being silent. Dream report aggregates bypass counts, and weights.js
  uses them to erode scar weights automatically (§11.4).

---

*This document was first written at the close of a long design
conversation between Eason Zeng and an instance of Claude on
2026-04-08. The v1.1 additions documented here were made in a second
session on 2026-04-09, after the core architecture had survived
contact with real usage on the AlphaClaw repo and several new
structural needs became visible. Each subsection above is the
answer to a specific concern that arose during that second pass.*

*Keeping this document current is the project's continuous act of
self-application. If future sessions add layers without updating
this file, fixguard's own memory has failed — exactly the failure
mode the whole project exists to prevent.*

## 12. Self-application log

This section records real events where fixguard was applied to itself.
It exists because the project only has credibility if its own source
tree is under its own protection. Every entry below happened on the
actual git history of this repository.

### 12.1 2026-04-09 — first full self-hosting

**Event:** fixguard became its own first user.

**Context:** After finishing the v1.1 learning ring (weights + patterns +
events + status), the question was whether fixguard could protect its
own repository. Two things had to work:
1. `fixguard scars` had to find real fix commits in fixguard's own
   history (not just external projects like AlphaClaw).
2. `fixguard init` had to install Claude Code + pre-commit hooks that
   then actually blocked attempts to edit scarred lines in this tree.

**What happened:**

1. Committed two groups: `feat: v1.0 MVP + v1.1 learning ring`
   (bulk work) and `fix: archived scars leaked into commit-time check`
   (an isolated fix commit that should score as a scar source).

2. First self-scan attempt returned **0 scars**. The fix commit scored
   0.40 — just below the 0.50 threshold — because the test file
   accompanying the fix was bundled into the same commit, tipping
   `totalLineDelta` over 200 and triggering `largeDiff: -0.20`.

3. This was a real detector edge case: a targeted fix + its own new
   regression test looks structurally like "refactor" to the naive
   total-line-delta check. Diagnosed in ~30 seconds by dumping the
   signal breakdown of every candidate commit.

4. **Fix:** added new-file vs modified-file tracking to
   `parseDiffBlock` in `scars.js`, and changed `scoreCommit` to use
   `modifiedDelta` (changes to existing files) as the basis for the
   size bucket. A new regression test for "fix + new test file"
   pattern was added to `signals.test.js` to lock the behaviour.

5. Re-committed as `fix: size bucket must use modification delta, not
   total delta`. This commit itself is a fix commit — and fixguard now
   detects it. The fix that made fixguard better became a scar
   protecting the code that does the detecting.

6. Ran `fixguard init` on the repo. Verified:
   - `.git/hooks/pre-commit` installed
   - `.claude/settings.json` installed with PreToolUse matcher
     `Read|Edit|Write|MultiEdit`
   - `.fixguardrc.json` written

7. Ran the end-to-end meta test: synthesized a Claude Code
   `PreToolUse` payload requesting an `Edit` to delete the line
   `if (s.archived) continue;` in `src/check.js`. Fed it to
   `fixguard hook` via stdin. **Got `permissionDecision: deny` with
   a reason referencing commit `ca2bd9f` — the original archived-scar
   fix.**

8. Committed the init state with message
   `meta: self-apply fixguard to fixguard`. The commit ran through the
   pre-commit hook automatically and got `✓ no protected regions
   touched` because it only added config files, no source edits.

**Final state after this event:**

- 6 commits in repository history
- 2 commits recognized by fixguard as real fix sources
- 15 scar regions across `src/check.js`, `src/scars.js`, `src/signals.js`,
  and their tests
- Claude Code PreToolUse hook active on this repo
- Pre-commit hook active on this repo
- Self-scan runtime: ~0.7 s (30 files, 6 commits)

**Lessons captured:**

- The "new-file-alongside-fix" edge case is now documented in §9 and
  fixed in the detector. This is the cleanest possible demonstration
  of the §8.1 principle: **feedback is algorithm improvement, not data
  curation**. The bug was caught by reality, the fix was a new signal,
  the fix is now protected by the thing it improved.
- The complete loop works: fixguard detects its own fixes, fixguard
  protects itself against editing those fixes, fixguard's commit of
  that protection passed its own pre-commit hook. No external
  validation needed — the tool verified itself end-to-end.
- This is the strongest form of "eat your own dog food" the project
  can achieve without external users: the code that protects projects
  is protecting the code that protects projects.

**Commits of record:**
```
dec5864 meta: self-apply fixguard to fixguard
120909f fix: size bucket must use modification delta, not total delta
93f5f9c docs: document new-file-alongside-fix edge case found during self-application
ca2bd9f fix: archived scars leaked into commit-time check
79a5520 feat: v1.0 MVP + v1.1 learning ring
37e8f5c init: fixguard project scaffold
```

Future self-application events should be appended as §12.2, §12.3, etc.
Each entry should answer: what was tried, what broke, what the fix was,
and what the final state looked like. This log is a memory the project
keeps about itself.
