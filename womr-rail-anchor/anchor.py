"""Rail-anchor classification -- pure decision logic, no IO.

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


def scan_links(node_modules: str) -> list:
    """The only IO in this module. Walk every scope, one level into each @scope."""
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
    links = scan_links(os.path.join(repo_root, "node_modules"))
    return [
        (name, classify(name, target, repo_root, workspace_root))
        for name, target in links
    ]
