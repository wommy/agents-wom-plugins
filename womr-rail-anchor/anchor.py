"""Rail-anchor classification -- PURE decision logic. No IO, no imports beyond os.path.

Scanning and path resolution live in __init__.py; this module only decides.

A rail is ANCHOR-BREACHED when its module links resolve outside the repository
that owns it: it may execute code that no longer matches its source, so both
green and red results from it are uncited.

Classification is by TARGET, never by name. The first version of the shell audit
this replaces walked only the @womr scope and reported 3 breaches where a full
walk found 8 -- @effect links into the same workspaces were invisible to it.
"""
from __future__ import annotations

import os
from typing import Iterable, Optional, Sequence, Tuple

OK = "OK"
STORE = "STORE"
WORKSPACE = "WORKSPACE"
CACHE = "CACHE"
OUTSIDE = "OUTSIDE"

# STORE is NOT a breach: pnpm resolves every dependency into a content-addressable
# store outside the repo, and flagging those buries the 8 real breaches under 15
# false ones. A detector that cries wolf is a detector nobody reads.
BREACH_CLASSES = (WORKSPACE, CACHE, OUTSIDE)

# Reapable tmpfs tier: not a worker workspace, still not durable.
CACHE_PREFIXES = ("/tmp/wom-cache", "/tmp/")

# Content-addressable package stores. Durable despite the naming.
STORE_MARKERS = ("/pnpm-store/", "/pnpm/store/")


def _within(path: str, root: str) -> bool:
    """True when path is root or lies beneath it, on a PATH BOUNDARY.

    Plain startswith would place /home/wom/infra/womr-other inside
    /home/wom/infra/womr.
    """
    path = os.path.normpath(path)
    root = os.path.normpath(root)
    return path == root or path.startswith(root + os.sep)


def classify(
    name: str,
    target: Optional[str],
    repo_root: str,
    workspace_root: str,
) -> str:
    """Classify one resolved link. ``name`` is reported, never decisive.

    An unresolvable target is OUTSIDE, never OK: a dangling link must not read
    as clean.
    """
    if not target:
        return OUTSIDE
    if _within(target, workspace_root):
        return WORKSPACE
    if _within(target, repo_root):
        return OK
    if any(marker in target + os.sep for marker in STORE_MARKERS):
        return STORE
    for prefix in CACHE_PREFIXES:
        if _within(target, prefix.rstrip(os.sep)):
            return CACHE
    return OUTSIDE


def is_breach(rows: Sequence[Tuple[str, str]]) -> bool:
    """True when the scan is not provably clean.

    An EMPTY scan is a breach, not a pass: finding nothing means the scan could
    not see, and a detector that reports clean when it cannot look is worse than
    no detector.
    """
    if not rows:
        return True
    return any(verdict in BREACH_CLASSES for _name, verdict in rows)
