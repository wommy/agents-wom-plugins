# womr-rail-anchor

Puts `bun womr.ts lanes doctor`'s verdict in front of the agent **at the moment of use**.

## What this is now

A thin adapter. It does not detect anything itself.

- **Detection** → `lanes doctor` (the rail). 268 links scanned, with
  `self` / `foreign` / `dangling` / `unauthorized` / `pnpm-store` classes.
- **Parsing** → the `toon` CLI (`@toon-format/cli`), which decodes the receipt to typed JSON.
- **This plugin** → decides breach-vs-blind from the decoded payload, and delivers it.

An earlier version scanned `node_modules` itself: **20 links against the rail's 268**, and
without any of the rail's classes. It existed only because `lanes doctor` was returning 96
false `unauthorized` findings from a non-canonicalised pnpm store root — a bug, since fixed.
A hand-rolled TOON regex parser was also written here and thrown away once `toon -d` was
found. Both are the same mistake: reimplementing an authority that already works.

## Why the plugin still exists

The rail cannot arrive unprompted. A breach matters the instant someone composes a
`bun womr.ts` command — not whenever a person remembers to run a health check. The
predecessor to this plugin was a 15-minute systemd timer writing to a log, which proved that
a cadence nobody reads is not a guard.

So: **the rail decides, the plugin delivers.**

| hook | what it does |
|---|---|
| `pre_llm_call` | injects the verdict into the turn, in-band |
| `pre_tool_call` | optionally refuses to run the rail while breached (opt-in) |

## The blind rule

A receipt that cannot be read is a **breach, not a pass** — an instrument that cannot look
must never report clean. But blind and breached are handled differently:

- the **warning** fires on blind (surfacing "unknown" is safe and useful)
- the **gate** never blocks on blind (blocking on an unreadable instrument wedges the shell)

## Guards

| guard | why it is load-bearing |
|---|---|
| gate off by default | warning is the belt; blocking is opt-in suspenders |
| never gates `pnpm install` | blocking the cure makes the breach unfixable from inside |
| `terminal` tool only, rail commands only | narrow blast radius |
| kill switch beats enforcement | one env var disables everything |
| interval cache (default 300s) | the rail costs ~1.3s; do not pay it per turn |
| subprocess timeout | a hung check yields blind, never a stalled turn |
| all exceptions swallowed | a bug in this guard must not wedge the operator |

## Activation (operator-gated)

```bash
hermes plugins enable womr-rail-anchor      # then a gateway restart
```

Rollback: `hermes plugins disable womr-rail-anchor`, or `WOMR_RAIL_ANCHOR_DISABLE=1`.

## Tuning

| env | default | meaning |
|---|---|---|
| `WOMR_RAIL_ANCHOR_DISABLE` | unset | any non-empty, non-`0`/`false` value disables |
| `WOMR_RAIL_ANCHOR_ENFORCE` | unset | set to enable the blocking gate |
| `WOMR_ROOT` | `/home/wom/infra/womr` | repo the rail is run against |
| `WOMR_RAIL_ANCHOR_INTERVAL_SECONDS` | 300 | minimum seconds between rail invocations |
| `WOMR_RAIL_ANCHOR_TIMEOUT_SECONDS` | 20 | per-subprocess timeout |
| `WOMR_TOON_BIN` | `toon` | path to the TOON decoder |

## Test

```bash
python3 test/test_doctor.py    # 15 — verdict rule over decoded receipts, pure dicts
python3 test/test_gate.py      # 14 — hook behaviour, rail stubbed
hermes plugins doctor . --ci   # validates against the real loader
```

Proven end-to-end 2026-08-19 against a **real** breach: an `@womr/rail` link repointed outside
a dedicated lane produced `ok:false, unauthorizedCount=1`, decoded through `toon -d`, and
yielded a breach verdict naming the offending path. Three negative controls confirm the suite
is not vacuous — making blind read as clean, or the gate stop blocking, each turns it red.
