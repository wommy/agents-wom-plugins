"""Warn at SESSION START when a bare-name skill route cannot be loaded.

WHY THIS EXISTS
The harness scans ``<root>/*/SKILL.md`` at ONE level only. A skill nested at
depth >= 2 is real, readable by absolute path, and un-invocable by bare name.
Prose that routes to it by name -- "load `hermes-local-durability` FIRST" --
therefore resolves to nothing, silently. Live instances found 2026-08-18 and
confirmed cured by symlink: artifact-cube-pipeline, systematic-debugging,
hermes-local-durability, hermes-usercustomize-overlay,
hermes-hotpatch-apply-revert. The last three ARE the Hermes runtime ownership
boundary that AGENTS.md requires be loaded before any installed-runtime write:
that always-loaded guard could not fire, because its skills were dark.

WHY A PLUGIN AND NOT THE SHELL SCRIPT IT REPLACES
The predecessor is step 6 of ``kanban-tick-guard.sh`` -- it rides the kanban
pump tick, which is the WRONG CADENCE. A dark skill route matters when a
SESSION BEGINS and the agent is about to route by name; it does not matter
when a card moves. Worse, the guard it rides had not completed a lap since
05:39 on the day this was written, so the audit was effectively dead. This
fires on the event that actually implies the risk.

It is also cheaper: the shell version ran one ``find`` PER routed name over
three roots. This walks the roots ONCE into an index and classifies every
route against it.

SEAM: ``on_session_start`` fires once per brand-new session from
``agent/conversation_loop.py:913`` via ``hermes_cli.lifecycle.invoke_hook``
(kwargs: session_id, model, platform). Not re-fired on continuation. The
return value is ignored -- this is an OBSERVER and must never raise.

Classification lives in ``reachability.py`` (pure, 22 tests). This file is
wiring and IO only.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List

from . import reachability

logger = logging.getLogger(__name__)

DISABLE_ENV = "WOMR_SKILL_REACHABILITY_DISABLE"
ROOTS_ENV = "WOMR_SKILL_ROOTS"
SOURCE_ENV = "WOMR_SKILL_ROUTE_SOURCE"
INTERVAL_ENV = "WOMR_SKILL_REACHABILITY_INTERVAL_SECONDS"
MAX_DEPTH_ENV = "WOMR_SKILL_REACHABILITY_MAX_DEPTH"

# Every root the harness may scan. Reachable in ANY of them is reachable: the
# documented cure symlinks the source into more than one. Auditing only the
# first would false-DARK everything that lives in the others.
DEFAULT_ROOTS = (
    "/home/wom/.claude/skills",
    "/home/wom/.agents/skills",
    "/home/wom/.config/agents-wom/skills",
)
DEFAULT_SOURCE = "/home/wom/inbox/AGENTS.md"
# A session start is a latency-sensitive moment. Re-walking the roots on every
# new session buys nothing: the skill tree changes on the scale of days.
DEFAULT_INTERVAL_SECONDS = 900
# The shell predecessor bounded its find at depth 4 for two reasons that both
# still hold: cluster dirs are themselves SYMLINKS (the walk must follow them
# or it silently under-reports), and following symlinks without a bound can
# cycle forever -- at session start, on the operator's critical path.
DEFAULT_MAX_DEPTH = 4
# How many dark routes to name before truncating the log line.
REPORT_LIMIT = 12

_last_run_at = 0.0


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _disabled() -> bool:
    return os.environ.get(DISABLE_ENV, "").strip() not in ("", "0", "false")


def resolve_roots() -> List[str]:
    """Configured roots, existing, deduped by realpath.

    ``~/.claude/skills`` is a symlink to ``~/.agents/skills`` on this machine,
    so without the realpath dedupe every skill would be counted twice and a
    single source would look like a DUPLICATE of itself.
    """
    raw = os.environ.get(ROOTS_ENV, "").strip()
    candidates = [p for p in raw.split(os.pathsep) if p] if raw else list(DEFAULT_ROOTS)
    out: List[str] = []
    seen = set()
    for path in candidates:
        path = os.path.expanduser(path)
        if not os.path.isdir(path):
            continue
        key = os.path.realpath(path)
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


def build_index(roots, max_depth: int = DEFAULT_MAX_DEPTH) -> Dict[str, List[dict]]:
    """Walk the roots once into ``{name: [{path, depth, target}]}``.

    Bounded, symlink-following, cycle-safe: a manual BFS with a depth cap and a
    visited-realpath set. ``os.walk(followlinks=True)`` has neither and would
    be free to spin on a self-referential cluster link.
    """
    index: Dict[str, List[dict]] = {}
    for root in roots:
        visited = set()
        frontier = [(root, 0)]
        while frontier:
            current, depth = frontier.pop()
            if depth >= max_depth:
                continue
            try:
                entries = os.listdir(current)
            except OSError:
                continue
            for entry in entries:
                if entry.startswith("."):
                    continue
                path = os.path.join(current, entry)
                if not os.path.isdir(path):
                    continue
                try:
                    real = os.path.realpath(path)
                except OSError:
                    continue
                if real in visited:
                    continue  # cluster dirs are symlinks; a cycle must not hang
                visited.add(real)
                child_depth = depth + 1
                if os.path.isfile(os.path.join(path, "SKILL.md")):
                    index.setdefault(entry, []).append(
                        {"path": path, "depth": child_depth, "target": real}
                    )
                frontier.append((path, child_depth))
    return index


def read_route_source() -> str:
    """The prose whose bare-name routes must resolve. Never raises."""
    source = os.environ.get(SOURCE_ENV, "").strip() or DEFAULT_SOURCE
    try:
        with open(os.path.expanduser(source), "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def run_audit() -> dict:
    """Gather, then classify. The only decision is in ``reachability``."""
    roots = resolve_roots()
    index = build_index(roots, _int_env(MAX_DEPTH_ENV, DEFAULT_MAX_DEPTH))
    routes = reachability.extract_routes(read_route_source())
    report = reachability.audit(routes, index)
    report["roots"] = roots
    return report


def _message(report: dict) -> str:
    roots = report.get("roots") or list(DEFAULT_ROOTS)
    if report.get("blind"):
        return (
            "womr-skill-reachability: BLIND -- %s. Routes cannot be checked, so "
            "treat 'no dark skills' as unproven, not as a pass. Roots: %s; source: %s"
            % (
                report.get("blind_reason", "scan produced nothing"),
                os.pathsep.join(roots) or "<none found>",
                os.environ.get(SOURCE_ENV, "").strip() or DEFAULT_SOURCE,
            )
        )
    lines = []
    for name, source in report["dark"][:REPORT_LIMIT]:
        lines.append("  DARK  %s  (real skill at %s)" % (name, source))
        lines.append("        cure: %s" % reachability.cure_command(name, source, roots))
    more = len(report["dark"]) - REPORT_LIMIT
    if more > 0:
        lines.append("  ... and %d more dark route(s)" % more)
    for name, targets in report["duplicate"][:REPORT_LIMIT]:
        lines.append("  DUPLICATE  %s  -> %s" % (name, ", ".join(targets)))
    return (
        "womr-skill-reachability: %d bare-name route(s) point at a skill the Skill "
        "tool CANNOT load (the harness scans <root>/*/SKILL.md one level only), and "
        "%d name(s) are claimed by more than one source. Routing to these by name "
        "silently does nothing -- read the skill by absolute path, or land the "
        "depth-1 symlink.\n%s"
        % (len(report["dark"]), len(report["duplicate"]), "\n".join(lines))
    )


def on_session_start(**kwargs: Any) -> None:
    """Log dark/duplicate skill routes once per interval. Never raises."""
    global _last_run_at
    try:
        # Kill switch and throttle come FIRST, before any filesystem work, so a
        # disabled or already-warm plugin costs a session start nothing at all.
        if _disabled():
            return None
        interval = _int_env(INTERVAL_ENV, DEFAULT_INTERVAL_SECONDS)
        now = time.monotonic()
        if _last_run_at and (now - _last_run_at) < interval:
            return None
        _last_run_at = now

        report = run_audit()
        if not reachability.is_actionable(report):
            return None  # every route resolves; a clean audit says nothing
        logger.warning("%s", _message(report))
        return None
    except Exception:
        # Observer contract: the return value is ignored and a raise here lands
        # in the session-start error path. Log and yield.
        logger.warning("womr-skill-reachability: audit skipped", exc_info=True)
        return None


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", on_session_start)


__all__ = ["on_session_start", "register", "reachability", "run_audit", "build_index"]
