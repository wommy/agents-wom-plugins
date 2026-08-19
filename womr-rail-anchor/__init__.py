"""Tell the agent, in-band, when the womr rail is anchor-breached.

WHY THIS EXISTS
`bun womr.ts` resolves @womr/* through node_modules. When those links resolve into
a kanban WORKER WORKSPACE instead of the repo, the rail executes a done worker's
checkout: results are uncited, and a verb the repo has may be missing from what
actually runs. This has recurred, and the residue of a previous half-cure is still
on disk as `.ignored_*` links.

WHY A PLUGIN AND NOT THE SHELL SCRIPT IT REPLACES
The predecessor is a bash script on a 15-minute systemd timer. A timer writes to a
log nobody is reading at the moment the rail is used. This injects the warning into
the turn itself, so the agent learns the rail is untrustworthy BEFORE composing a
command against it -- at the moment of use, not on a cadence.

SEAM: `pre_llm_call` is the one hook whose return value is honoured; returning
{"context": ...} appends to the current turn's user message. Observer otherwise.

Detection lives in `anchor.py` (pure, 16 tests). This file is wiring and caching.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

from . import anchor

logger = logging.getLogger(__name__)

DISABLE_ENV = "WOMR_RAIL_ANCHOR_DISABLE"
ENFORCE_ENV = "WOMR_RAIL_ANCHOR_ENFORCE"
REPO_ENV = "WOMR_ROOT"
INTERVAL_ENV = "WOMR_RAIL_ANCHOR_INTERVAL_SECONDS"

DEFAULT_REPO = "/home/wom/infra/womr"
WORKSPACE_ROOT = "/home/wom/.hermes/kanban/workspaces"
DEFAULT_INTERVAL_SECONDS = 300

def _scan_links(node_modules: str) -> list:
    """Walk every scope, one level into each @scope. IO lives here, not in anchor."""
    out = []
    try:
        entries = sorted(os.listdir(node_modules))
    except OSError:
        return out
    for entry in entries:
        path = os.path.join(node_modules, entry)
        if entry.startswith("@"):
            try:
                inner = sorted(os.listdir(path))
            except OSError:
                continue
            for sub in inner:
                sub_path = os.path.join(path, sub)
                if os.path.islink(sub_path):
                    out.append(("%s/%s" % (entry, sub), _resolve(sub_path)))
        elif os.path.islink(path):
            out.append((entry, _resolve(path)))
    return out


def _resolve(path: str) -> Optional[str]:
    try:
        return os.path.realpath(path)
    except OSError:
        return None


def audit(repo_root: str, workspace_root: str) -> list:
    """Return [(name, verdict)] for every link under the repo's node_modules."""
    links = _scan_links(os.path.join(repo_root, "node_modules"))
    return [
        (name, anchor.classify(name, target, repo_root, workspace_root))
        for name, target in links
    ]


_cache: dict = {"at": 0.0, "rows": None}


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _audit_cached(repo: str):
    """Filesystem walk is cheap but not free; do it at most once per interval."""
    now = time.monotonic()
    interval = _int_env(INTERVAL_ENV, DEFAULT_INTERVAL_SECONDS)
    if _cache["rows"] is not None and (now - _cache["at"]) < interval:
        return _cache["rows"]
    rows = audit(repo, WORKSPACE_ROOT)
    _cache["at"], _cache["rows"] = now, rows
    return rows


def _message(breaches) -> str:
    listed = "\n".join(
        "  %s %s" % (verdict, name) for name, verdict in sorted(breaches)[:12]
    )
    more = len(breaches) - 12
    if more > 0:
        listed += "\n  ... and %d more" % more
    return (
        "RAIL ANCHOR BREACH -- %d link(s) in the womr node_modules resolve outside the "
        "repository:\n%s\n"
        "`bun womr.ts` is therefore executing code that does not match the repo source. "
        "Treat BOTH its successes and its failures as uncited, and read the repo source "
        "directly when a finding depends on rail behaviour. Repair is `pnpm install` in "
        "%s -- NEVER `bun install`, and NOT while lanes are flying."
        % (len(breaches), listed, os.environ.get(REPO_ENV, DEFAULT_REPO))
    )


def pre_llm_call(**kwargs: Any):
    """Inject a breach warning into the turn. Silent when the rail is anchored."""
    try:
        if os.environ.get(DISABLE_ENV, "").strip() not in ("", "0", "false"):
            return None
        repo = os.environ.get(REPO_ENV) or DEFAULT_REPO
        if not os.path.isdir(os.path.join(repo, "node_modules")):
            return None  # not a womr checkout; nothing to say
        rows = _audit_cached(repo)
        breaches = [(n, v) for n, v in rows if v in anchor.BREACH_CLASSES]
        if not breaches:
            return None  # a clean rail says nothing
        return {"context": _message(breaches)}
    except Exception:
        logger.warning("womr-rail-anchor: check skipped", exc_info=True)
        return None


# Commands that would execute the rail. Matched conservatively: a substring hit on
# the entrypoint, not a parse. A false miss only costs the warning we already give.
_RAIL_MARKERS = ("womr.ts", "bun womr")


def pre_tool_call(tool_name: str = "", args: Any = None, **_: Any):
    """Refuse to run the rail while it is anchor-breached. OPT-IN.

    Off by default: the pre_llm_call warning is the belt, and this is the
    suspenders for when an operator wants the breach to be non-negotiable. It is
    deliberately narrow -- it gates ONLY commands that would execute the rail, and
    never the repair (`pnpm install`) or any diagnostic.
    """
    try:
        if os.environ.get(DISABLE_ENV, "").strip() not in ("", "0", "false"):
            return None
        if os.environ.get(ENFORCE_ENV, "").strip() in ("", "0", "false"):
            return None  # warn-only unless explicitly enforced
        if tool_name != "terminal":
            return None
        command = (args or {}).get("command") or ""
        if not any(marker in command for marker in _RAIL_MARKERS):
            return None
        repo = os.environ.get(REPO_ENV) or DEFAULT_REPO
        rows = _audit_cached(repo)
        breaches = [(n, v) for n, v in rows if v in anchor.BREACH_CLASSES]
        if not breaches:
            return None
        return {
            "action": "block",
            "message": (
                "REFUSED: the womr rail is anchor-breached (%d link(s) resolve outside "
                "the repo), so this command would execute code that is not the repo's "
                "and its result would be uncited either way. Repair with `pnpm install` "
                "in %s -- never `bun install`, and not while lanes are flying. To run it "
                "anyway, unset %s." % (len(breaches), repo, ENFORCE_ENV)
            ),
        }
    except Exception:
        # Fail OPEN: a bug in this guard must never wedge the operator's shell.
        logger.warning("womr-rail-anchor: gate skipped", exc_info=True)
        return None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("pre_tool_call", pre_tool_call)


__all__ = ["pre_llm_call", "pre_tool_call", "register", "anchor"]
