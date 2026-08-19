# womr-rail-anchor

Tells the agent, **in-band**, when `bun womr.ts` is executing code that is not the repo's.

## The problem

`bun womr.ts` resolves `@womr/*` through `node_modules`. When those links resolve into a
kanban **worker workspace** instead of the repository, the rail runs a finished worker's
checkout. Results are uncited in both directions: a verb the repo has may be missing from
what actually runs, and a green result proves nothing about repo source. This has recurred,
and residue from a previous half-cure is still on disk as `.ignored_*` links.

## Why a plugin, not the shell script it replaces

The predecessor is a bash script on a 15-minute systemd timer, writing to a log nobody is
reading at the moment the rail is used. This injects the warning **into the turn**, so the
warning arrives at the moment of use rather than on a cadence — and there is no timer to
fall behind.

## Seam

`pre_llm_call` is the one hook whose return value is honoured: returning `{"context": ...}`
appends to the current turn's user message. Silent when the rail is anchored — a clean rail
says nothing.

## Classification is by target, never by name

| class | meaning | breach |
|---|---|---|
| `OK` | resolves inside the repo | no |
| `STORE` | pnpm content-addressable store | no |
| `WORKSPACE` | resolves into a kanban worker workspace | **yes** |
| `CACHE` | reapable tmpfs tier | **yes** |
| `OUTSIDE` | anywhere else, including a dangling link | **yes** |

Two failure modes this encodes, both learned the hard way:

- **Name-based scanning under-reports.** v1 of the shell audit walked only `@womr` and found
  3 breaches; a full walk classified by target finds 8, because `@effect` links into the same
  workspaces were invisible to it.
- **Store links are not breaches.** A first cut of this port flagged all 15 pnpm store links
  as `OUTSIDE`, burying the 8 real breaches under 15 false ones. A detector that cries wolf
  is a detector nobody reads.

An **empty scan is a breach**, not a pass: finding nothing means the scan could not look.

## Activation (operator-gated)

Installed disabled.

```bash
hermes plugins enable womr-rail-anchor
```

Rollback: `hermes plugins disable womr-rail-anchor`, or `WOMR_RAIL_ANCHOR_DISABLE=1`.

## Tuning

| Env | Default | Meaning |
|---|---|---|
| `WOMR_RAIL_ANCHOR_DISABLE` | unset | any non-empty, non-`0`/`false` value disables |
| `WOMR_ROOT` | `/home/wom/infra/womr` | repo whose `node_modules` is audited |
| `WOMR_RAIL_ANCHOR_INTERVAL_SECONDS` | 300 | minimum seconds between filesystem walks |

## Test

```bash
python3 test/test_anchor.py     # 16 tests, pure, no runtime and no filesystem
hermes plugins doctor .          # validates against the real loader
```

Equivalence with the shell audit it replaces was verified against the live repo: same 8
`WORKSPACE` breaches, zero false positives.
