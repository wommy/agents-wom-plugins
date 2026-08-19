"""Decide a verdict from a decoded `lanes doctor` receipt. PURE.

Takes an already-decoded payload (a dict) -- no subprocess, no parsing, no
filesystem -- so the decision rule is provable without a womr checkout.

TWO THINGS THIS DELIBERATELY DOES NOT DO, because something else already owns them:
  * DETECTION belongs to `bun womr.ts lanes doctor`. An earlier version of this
    plugin scanned node_modules itself: 20 links against the rail's 268, and
    without the self/foreign/dangling/unauthorized/pnpm-store classes. It only
    existed because the rail was emitting 96 false 'unauthorized' findings from a
    non-canonicalised store root -- a bug, since fixed.
  * PARSING belongs to the `toon` CLI (@toon-format/cli), which decodes the
    receipt to JSON with real types. A hand-rolled regex parser was written here
    first and thrown away; the receipt is a machine format with a real decoder.

What is left is the only part neither owns: turning a verdict into something the
agent sees at the moment it matters.
"""
from __future__ import annotations

from typing import Any, List, NamedTuple, Optional, Tuple

RECEIPT_KIND = "womr.rail.lanes-doctor"

# Any non-zero member means the tree is not clean.
COUNT_FIELDS = (
    "selfCount",
    "foreignCount",
    "danglingCount",
    "unauthorizedCount",
    "pnpmStoreCount",
)


class Verdict(NamedTuple):
    breach: bool
    blind: bool
    counts: dict
    findings: List[Tuple[str, str]]  # (path, kind)
    reason: str


def blind(reason: str) -> Verdict:
    """A blind result is a BREACH, never a pass.

    An instrument that cannot look must not report clean. The consumer decides
    separately whether a blind verdict may block -- warning on unknown is safe,
    blocking on unknown wedges the operator.
    """
    return Verdict(breach=True, blind=True, counts={}, findings=[], reason=reason)


def verdict(payload: Optional[Any]) -> Verdict:
    """Decide from a decoded receipt. Anything unrecognised is blind, not clean."""
    if not isinstance(payload, dict):
        return blind("receipt did not decode to an object")
    if payload.get("kind") != RECEIPT_KIND:
        return blind("payload is not a %s receipt" % RECEIPT_KIND)
    if "ok" not in payload:
        return blind("receipt carries no ok field")

    counts = {}
    for field in COUNT_FIELDS:
        value = payload.get(field, 0)
        if not isinstance(value, int) or isinstance(value, bool):
            return blind("receipt field %s is not an integer" % field)
        counts[field] = value

    findings = []
    for row in payload.get("findings") or []:
        if isinstance(row, dict):
            findings.append((str(row.get("path", "?")), str(row.get("kind", "?"))))

    dirty = [f for f, n in counts.items() if n]
    if payload["ok"] is True and not dirty:
        return Verdict(False, False, counts, findings, "clean")
    reason = (
        "lanes doctor reported " + ", ".join("%s=%d" % (f, counts[f]) for f in dirty)
        if dirty
        else "lanes doctor reported ok=false"
    )
    return Verdict(True, False, counts, findings, reason)


def message(v: Verdict) -> str:
    """Agent-facing text for a non-clean verdict."""
    if v.blind:
        return (
            "RAIL ANCHOR UNVERIFIED -- `bun womr.ts lanes doctor` could not be read "
            "(%s), so the rail's integrity is UNKNOWN, not clean. Treat results from "
            "`bun womr.ts` as uncited until the check runs." % v.reason
        )
    listed = "\n".join("  %s %s" % (kind, path) for path, kind in v.findings[:10])
    more = len(v.findings) - 10
    if more > 0:
        listed += "\n  ... and %d more" % more
    return (
        "RAIL ANCHOR BREACH -- %s.\n%s\n"
        "`bun womr.ts` may therefore execute code that is not this repo's, so treat "
        "BOTH its successes and its failures as uncited. Full detail: "
        "`bun womr.ts lanes doctor`. Repair is `pnpm install` -- NEVER `bun install`."
        % (v.reason, listed or "  (no per-link rows in receipt)")
    )
