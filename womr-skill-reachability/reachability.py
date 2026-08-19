"""Skill-route reachability classification -- pure decision logic, no IO.

THE DEFECT
The harness scans ``<root>/*/SKILL.md`` at ONE level only. A skill nested at
depth >= 2 is real, readable by absolute path, and un-invocable by bare name.
When prose routes to it by name -- "load `hermes-local-durability` FIRST" --
the route silently resolves to nothing.

WHY THIS IS NOT A BLANKET NESTING CHECK
A naive "every nested SKILL.md needs a depth-1 entry" audit reported 1331 of
1535 dark (measured 2026-08-18) and is useless. Only a router's ENTRY POINT
must be depth-1; nested members are legitimate by design and are reached by
absolute path. Mass-linking them would also load 1331 model-invoked
descriptions into every turn. Nesting alone is not a defect -- nesting PLUS a
bare-name route is. So a name with no skill anywhere is NOT_A_SKILL (prose),
and stays silent.

This module takes an already-built index of discovered directories, so every
verdict is provable without a filesystem. All IO lives in ``__init__.py``.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Mapping, Sequence

# The route resolves: a depth-1 entry exists in some root.
REACHABLE = "REACHABLE"
# A real skill exists, but only below depth 1. The route is a dead letter.
DARK = "DARK"
# Loadable, but two distinct sources claim the same depth-1 name: which one the
# harness loads is scan-order dependent, so the route is non-deterministic.
DUPLICATE = "DUPLICATE"
# No skill of this name anywhere. A prose word, not a defect.
NOT_A_SKILL = "NOT_A_SKILL"

ACTIONABLE_VERDICTS = (DARK, DUPLICATE)

# Only depth 1 is loadable -- this is the whole defect, named once.
LOADABLE_DEPTH = 1

# Ported verbatim from the shell predecessor so the port cannot silently widen
# or narrow what counts as a route.
#   stage 1: a slash-route not preceded by a letter or another slash, so
#            "/home/wom/inbox" yields "home" (harmless, self-filters against
#            the index) and never "wom" or "inbox".
#   stage 2: a backticked bare name, the AGENTS.md convention for a skill load.
_SLASH_ROUTE = re.compile(r"(?:^|[^a-z/])(/[a-z][a-z0-9-]{3,})", re.MULTILINE)
_TICK_ROUTE = re.compile(r"`([a-z][a-z0-9-]{4,})`")


def extract_routes(text: str) -> List[str]:
    """Mine bare-name skill routes out of prose. Sorted, unique, pure."""
    if not text:
        return []
    names = {match.lstrip("/") for match in _SLASH_ROUTE.findall(text)}
    names.update(_TICK_ROUTE.findall(text))
    return sorted(names)


def _targets(entries: Iterable[Mapping[str, Any]]) -> List[str]:
    """Distinct real sources behind a set of entries, order-stable."""
    seen: List[str] = []
    for item in entries:
        target = item.get("target") or item.get("path") or ""
        if target and target not in seen:
            seen.append(target)
    return sorted(seen)


def classify(route_name: str, discovered: Sequence[Mapping[str, Any]]) -> str:
    """Verdict for one routed name. ``route_name`` is reported, never decisive.

    ``discovered`` is every directory of that name carrying a SKILL.md, as
    ``{"path", "depth", "target"}`` -- depth measured from its own root.
    """
    if not discovered:
        return NOT_A_SKILL
    shallow = [d for d in discovered if int(d.get("depth", 99)) <= LOADABLE_DEPTH]
    if not shallow:
        # Deep duplicates are irrelevant: none of them is loadable by name, so
        # the route is dark either way. Report the defect that blocks it.
        return DARK
    # The documented cure symlinks ONE source into several roots, so several
    # depth-1 entries pointing at the same target is the healthy cured state.
    # Only distinct targets are an ambiguity.
    return DUPLICATE if len(_targets(shallow)) > 1 else REACHABLE


def _dark_source(discovered: Sequence[Mapping[str, Any]]) -> str:
    """The shallowest real directory to link from. Deterministic on ties."""
    best = sorted(
        discovered, key=lambda d: (int(d.get("depth", 99)), str(d.get("path", "")))
    )
    return str(best[0].get("path", "")) if best else ""


def cure_command(route_name: str, source: str, roots: Sequence[str]) -> str:
    """The depth-1 symlink that makes a dark route loadable, in every root."""
    targets = " ".join(roots)
    return "for d in %s; do ln -sfn %s $d/%s; done" % (targets, source, route_name)


def audit(
    routes: Sequence[str], skill_index: Mapping[str, Sequence[Mapping[str, Any]]]
) -> Dict[str, Any]:
    """Classify every routed name against a discovered-skill index.

    An EMPTY input on either side is BLIND, not clean. Finding nothing means
    the scan could not see: an unreadable skills root, or a route source that
    did not load. A detector that reports OK when it could not look launders a
    broken scan into a green light, which is worse than no detector at all.
    """
    verdicts: Dict[str, str] = {}
    dark: List[Any] = []
    duplicate: List[Any] = []
    reachable = 0
    not_a_skill = 0

    for name in routes:
        found = list(skill_index.get(name) or ())
        verdict = classify(name, found)
        verdicts[name] = verdict
        if verdict == DARK:
            dark.append((name, _dark_source(found)))
        elif verdict == DUPLICATE:
            duplicate.append((name, _targets(found)))
        elif verdict == REACHABLE:
            reachable += 1
        else:
            not_a_skill += 1

    blind_reason = ""
    if not skill_index:
        blind_reason = "skill index is empty -- no root could be scanned"
    elif not routes:
        blind_reason = "no routes extracted -- the route source did not load"

    return {
        "routes": len(routes),
        "indexed": len(skill_index),
        "verdicts": verdicts,
        "dark": sorted(dark),
        "duplicate": sorted(duplicate),
        "reachable": reachable,
        "not_a_skill": not_a_skill,
        "blind": bool(blind_reason),
        "blind_reason": blind_reason,
    }


def is_actionable(report: Mapping[str, Any]) -> bool:
    """True when the audit has something to say. Blind counts as something."""
    return bool(
        report.get("blind") or report.get("dark") or report.get("duplicate")
    )
