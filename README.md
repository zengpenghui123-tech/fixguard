# fixguard

> Stop AI coding assistants from silently reverting your hard-won bug fixes.

[![npm](https://img.shields.io/badge/npm-fixguard-cb3837)]()
[![license](https://img.shields.io/badge/license-MIT-blue)]()

## The problem

You spent 4 hours tracking down a subtle race condition. You fix it. Two weeks
later, Claude Code / Cursor / Copilot — having no memory of that battle —
"refactors" the file and quietly removes your fix. Production breaks. You spend
4 more hours rediscovering the same bug.

**fixguard** turns each fix into a tripwire: a comment marker in the source,
a registry file, and a git hook that refuses any commit that touches a
protected region without explicit acknowledgement.

## Install

```bash
npm install -g fixguard
# or use without installing:
npx fixguard init
```

## Usage

### 1. Mark a fix in source

```js
// @fix [auth-jwt] "Don't remove the iat check — bypass attack discovered 2025-12"
function verifyToken(token) {
  const payload = jwt.decode(token);
  if (!payload.iat || payload.iat > Date.now() / 1000) throw new Error('bad iat');
  return payload;
}
```

Marker syntax works in any language with line or block comments:

```py
# @fix [csrf] "Must reject empty Origin header — see incident #284"
```

```go
// @fix-start [retry-loop] "Backoff must be exponential, not linear"
for i := 0; i < maxRetries; i++ {
    time.Sleep(time.Duration(1<<i) * time.Second)
    ...
}
// @fix-end
```

### 2. Install the hook

```bash
cd your-project
fixguard init
```

This drops a `pre-commit` hook into `.git/hooks/`. From now on, any `git commit`
that touches a protected region will fail with a clear message.

### 3. Generate the registry

```bash
fixguard scan
```

Writes `FIXES.md` — a human-readable list of every protected region, grouped by
tag, with the reason. Commit this file so your team (and your AI assistant) can
see the fixes at a glance.

### 4. When you legitimately need to change a protected fix

```bash
FIXGUARD_BYPASS=1 git commit -m "auth-jwt: replace iat check with nbf+exp"
```

Bypassing is loud and logged — exactly the moment you want a human to think.

## Marker reference

| Marker | Protects |
|---|---|
| `@fix [tag] "reason"` | The next 20 lines (configurable) |
| `@fix [tag] lines=50 "reason"` | The next 50 lines |
| `@fix-start [tag] "reason"` ... `@fix-end` | Everything between |

Comment styles auto-detected: `//`  `#`  `--`  `/* */`  `<!-- -->`

## Commands

| Command | What it does |
|---|---|
| `fixguard init` | Install git pre-commit hook + sample config |
| `fixguard scan [path]` | Scan source tree, write `FIXES.md` |
| `fixguard check [--staged]` | Check staged diff against protected regions |
| `fixguard list` | Print all protected regions as JSON |

## Claude Code integration

Add this to `.claude/settings.json` to make Claude check **before** every edit:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "fixguard check --staged || true" }
        ]
      }
    ]
  }
}
```

## Configuration

Optional `.fixguardrc.json` at the project root:

```json
{
  "ignore": ["legacy/**", "vendor/**"],
  "defaultBlockLines": 20
}
```

## Why not just write tests?

Tests catch regressions of behaviour you remembered to test. fixguard catches
the moment **the line itself** changes — before the test even runs — and gives
the AI (or you) the *reason* the code looks the way it does. Tests and
fixguard solve adjacent problems; use both.

## License

MIT © Eason Zeng
