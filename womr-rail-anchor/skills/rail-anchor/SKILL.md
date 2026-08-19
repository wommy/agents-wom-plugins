---
name: rail-anchor
description: Use when bun womr.ts gives a surprising result, a rail verb seems missing, node_modules links look wrong, or a finding depends on rail behaviour. Covers anchor breaches, why an empty scan is a breach, and why lanes doctor is the authority.
---

# Rail anchor

A rail is **anchor-breached** when its module links resolve outside the repository that owns
it. `bun womr.ts` resolves `@womr/*` through `node_modules`; those links can point into a kanban
worker workspace, so the rail executes a finished worker's checkout instead of repo source.

**Both green and red results from a breached rail are uncited.** This is the part that costs
real time: a breached rail does not fail loudly, it answers confidently from the wrong code.

## Check first, reason second

```bash
bun womr.ts lanes doctor
```

`lanes doctor` is the authority. It scans every dependency link and reports `foreignCount`
(resolves into another worktree), `danglingCount`, `selfCount`, and `unauthorizedCount`. Treat a
non-zero `foreignCount` as blocking for diagnosis, not as noise.

## Repair

```bash
pnpm install          # cwd = the repo. NEVER `bun install`.
```

pnpm repoints live links but does **not** remove orphan entries under a dot-prefixed scope name
(`@womr/.ignored_rail`), because such a name is not a resolvable package. Those are residue from
an earlier partial cure and must be removed by hand. Verify by target, then re-run `lanes doctor`.

## Three scars, each bought once

**Classify by target, never by name.** A scan restricted to `@womr` reported 3 breaches where a
full walk classified by target found 8 — `@effect` links into the same workspaces were invisible
to it.

**Store links are not breaches.** pnpm resolves dependencies into a content-addressable store
outside the repo by design. A first port flagged all 15 as breaches, burying the 8 real ones. A
detector that cries wolf is a detector nobody reads — which is exactly why a real breach went
unnoticed while the authority sat there returning `ok:false` for an unrelated reason.

**An empty scan is a breach, not a pass.** Finding nothing means the scan could not look. A
detector that reports clean when it cannot see is worse than no detector.

## The ownership lesson underneath

This capability was reimplemented as a plugin scanner because `lanes doctor` was returning
`ok:false` — from a non-canonicalised store root, i.e. a bug in our own authority, not a missing
capability. A working authority was mistaken for an absent one, and a parallel implementation was
built beside it.

Before building a detector, check whether the thing you need already exists and is merely broken.
Fixing an authority is cheaper than growing a second one, and a second one silently splits the
truth.
