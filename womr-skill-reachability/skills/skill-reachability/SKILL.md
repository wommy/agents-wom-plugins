---
name: skill-reachability
description: Use when a skill cannot be invoked by name, when auditing which skills a router can actually reach, or when counting skills in a library. Covers the depth-1 scan limit and the invisible-vs-dark distinction that makes naive audits useless.
---

# Skill reachability

Skill discovery is typically **one level deep**: a scan of `<root>/*/SKILL.md`. A skill nested
deeper exists, is readable, and is **not invocable by name**. A router that names it routes
nowhere.

Measured on a real library: **929 `SKILL.md` files indexed, 107 loadable at depth 1, 822 nested.**

## Invisible is not dark — this distinction is the whole job

- **invisible** — nested deeper than the scan; unreachable *by name*. Usually deliberate: a
  member reached by absolute path from its router.
- **dark** — actually *routed to* by bare name, and unreachable. A real defect.

Of those 822 invisible skills, **0 were dark**. A naive nesting audit reports 822 problems and is
useless; the number that matters is how many *routes* fail to resolve. Report both, separately,
and never let the large number stand in for the small one.

## Auditing correctly

1. Extract the **routes**: bare skill names actually referenced by your routing surface.
2. Index every `SKILL.md` under every root, recording its depth.
3. A route is `REACHABLE` if some depth-1 entry matches, `DARK` if it matches only deeper
   entries, `DUPLICATE` if several depth-1 entries claim the name.

**Deduplicate roots by realpath.** If one root is a symlink to another, every skill double-counts
and a single source reads as a duplicate of itself.

**Check every root, not the canonical one.** Defaulting to a single root false-flags as dark
every skill that lives in one of the others.

## An empty result is not a pass

If no routes were extracted, the route source did not load — that is `blind`, and it must be
reported as its own state, never as "0 dark". A detector that says clean when it could not look
is worse than no detector. Carry a positive control (a synthetic source naming known-nested
skills must yield `DARK`) so the probe proves it can still see.

## Cure

Symlink the entry point to depth 1. Nothing moves, and the scan picks it up. Only the **entry
point** needs promoting — members may stay nested and be reached by path, so promoting a whole
cluster is rarely right.

## Cadence

A dark route matters when a session begins, not when a task moves. Binding this audit to an
unrelated work-queue tick couples it to a loop that can stall — and when that loop wedged, the
audit silently stopped running for hours.
