---
name: board-weighting
description: Use when a task board dispatches the wrong work first, when ranking or prioritising cards, or when deciding whether a queue problem is intake, weighting, or throughput. Covers structural scoring, the hand-set floor, and the measurement traps.
---

# Board weighting

A board that cannot express importance dispatches by age. If ordering is
`priority DESC, created_at ASC` and most rows tie at zero, the first key is a no-op and the
queue is FIFO no matter what anyone intended.

Measured on a real board: **8,924 of 12,888 open cards (69%) sat at priority 0**, so the bulk of
the board was ordered purely by creation date.

## Score structure, not subject matter

Two properties, no judgement about what a card is *about*:

- **leverage** — open transitive descendants: what finishing this card releases
- **free** — no open parent: nothing upstream blocks it

Free cards outrank gated ones because a gated card cannot run at all. Within a band, higher
leverage wins. Keep the bands non-overlapping so a free card always beats a gated one.

Traverse leverage **iteratively with a seen-set**: a cycle in the link graph must not hang the
loop this runs on.

## The hand-set floor is the load-bearing invariant

Reserve a priority band for human judgement and clamp every computed score strictly below it.
Then defend it in more than one place:

- select only rows at priority 0, so a human number is never a candidate
- clamp at score time **and** again on the write path
- `UPDATE ... WHERE id = ? AND priority = 0` so a hand-set landing mid-run still wins

Raising the floor is a policy change, not a tuning knob. Structure must never outvote a person.

## Where the weight is actually lost

Ranking is downstream. If the thing that creates cards discards priority at creation, ranking is
a mop under a running tap: 14 of 14 children of p119–p122 parents were born at 0. **Fix
inheritance at creation before investing in a ranker**, or the ranker runs forever.

## Two measurement traps, both paid for

**Do not measure completion as "cards created in the window that are also done."** That is ~0 by
construction. It produced a confident "504 created, 0 completed" standstill claim while the
system was completing 711 tasks a day. Count completion *events*, not young cards.

**Check where capacity actually goes before blaming intake.** On the same board, 12 cards
consumed 39% of all worker runs by being re-claimed and re-run, and 46% of claims ended waiting
on an unresolved dependency rather than doing work. Intake was never the binding constraint.

## Cost shape

Scoring a whole board is cheap; writing per-card through a subprocess is not. Measured: a full
plan over 15.5k rows and 26k edges built in **0.22s**, while an external writer spending one
process per card cost **~4.18s each**. If governance is falling behind, suspect the write path
before the algorithm.
