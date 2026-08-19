"""Structural priority scoring -- pure functions, no IO.

Kept free of hermes imports, sqlite, and network on purpose: the scoring
contract is the part worth testing, and it must be provable without a board.
``__init__.py`` owns all IO and wiring.

SCORING is deliberately structural only -- it makes no judgement about what a
card is "about":

    leverage = open transitive descendants (what finishing this card releases)
    free     = no OPEN parent, i.e. nothing upstream blocks it

Free cards outrank gated ones because a gated card cannot run at all; within a
band, higher leverage wins because it releases more work.

TWO GUARDS, both load-bearing:
  * only priority == 0 rows are scored, so an operator's hand-set number is
    never clobbered;
  * computed scores are clamped strictly below HAND_SET_FLOOR, so deliberate
    human ranking always outranks anything computed here. Raising the cap lets
    structure silently outvote judgement.
"""
from __future__ import annotations

import re
from typing import Iterable, List, Sequence, Tuple

# Statuses that can reach a worker. `triage` is excluded on purpose: those rows
# are not dispatchable until specify/decompose moves them, so ranking them costs
# writes and changes no drain order.
LANE = ("ready", "todo", "blocked", "running", "review", "scheduled")
TERMINAL = ("done", "archived")

HAND_SET_FLOOR = 90  # computed scores stay strictly below this

FIXTURE = re.compile(
    r"^(first|second|third|redaction|probe-|test-probe|scratch|foo|bar|baz)\b",
    re.I,
)

# Score bands. Free cards start above gated ones with no overlap: a gated card
# can reach at most 30+19=49, a free card starts at 60.
_FREE_BASE, _FREE_CAP = 60, 29
_GATED_BASE, _GATED_CAP = 30, 19
_FIXTURE_SCORE = 1


def clamp(score: int) -> int:
    """Cap a computed score strictly below HAND_SET_FLOOR. Idempotent."""
    return min(int(score), HAND_SET_FLOOR - 1)


def _index(rows: Iterable[dict], links: Sequence[Tuple[str, str]]):
    status = {r["id"]: r["status"] for r in rows}
    kids: dict = {}
    parents: dict = {}
    for parent, child in links:
        kids.setdefault(parent, []).append(child)
        parents.setdefault(child, []).append(parent)
    return status, kids, parents


def _leverage(root: str, status: dict, kids: dict) -> int:
    """Count OPEN transitive descendants.

    Iterative with a seen-set: a cycle in the link graph must not hang the
    dispatcher tick this runs on.
    """
    seen: set = set()
    stack = [root]
    while stack:
        for child in kids.get(stack.pop(), []):
            if child not in seen and status.get(child) not in TERMINAL and child in status:
                seen.add(child)
                stack.append(child)
    seen.discard(root)
    return len(seen)


def build_plan(
    rows: Iterable[dict],
    links: Sequence[Tuple[str, str]],
    max_writes: int | None = None,
) -> List[Tuple[str, int]]:
    """Return [(task_id, priority)] highest-first for unranked lane cards.

    A quiet board returns []. ``max_writes`` bounds the tick: the highest
    scores are taken first, so truncation drops the least valuable work.
    """
    rows = list(rows)
    status, kids, parents = _index(rows, links)
    plan: List[Tuple[str, int]] = []

    for row in rows:
        if row["status"] not in LANE:
            continue
        # Hand-set guard: never select a card that already carries a priority.
        if row.get("priority") or 0:
            continue
        if FIXTURE.match((row.get("title") or "").strip()):
            plan.append((row["id"], _FIXTURE_SCORE))
            continue
        gated = any(
            status.get(p) not in TERMINAL and p in status
            for p in parents.get(row["id"], [])
        )
        lev = _leverage(row["id"], status, kids)
        score = (
            _GATED_BASE + min(lev, _GATED_CAP)
            if gated
            else _FREE_BASE + min(lev, _FREE_CAP)
        )
        plan.append((row["id"], clamp(score)))

    # Deterministic: score desc, then id asc so equal scores never reorder
    # between ticks (a wobbling order would make the bounded slice unstable).
    plan.sort(key=lambda pair: (-pair[1], pair[0]))
    if max_writes is not None:
        plan = plan[: max(0, int(max_writes))]
    return plan
