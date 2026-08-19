"""Put `lanes doctor`'s verdict in front of the agent at the moment of use.

WHY A PLUGIN AT ALL. `bun womr.ts lanes doctor` already owns detection and does
it far better than this plugin ever did (268 links scanned vs 20, plus
self/foreign/dangling/unauthorized/pnpm-store classes). What the rail cannot do
is arrive unprompted. A breach matters at the instant someone composes a
`bun womr.ts` command, not whenever a person remembers to run a health check --
and the predecessor to this file, a 15-minute systemd timer writing to a log,
proved that a cadence nobody reads is not a guard.

So the split is: the RAIL decides, this plugin DELIVERS.
  pre_llm_call   inject the verdict into the turn, so the agent sees it in-band
  pre_tool_call  optionally refuse to run the rail while it is breached (opt-in)

Detection logic lives in the rail. Receipt parsing and the verdict rule live in
doctor.py (pure). This file is subprocess + cache + hook wiring only.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from typing import Any

from . import doctor

logger = logging.getLogger(__name__)

DISABLE_ENV = "WOMR_RAIL_ANCHOR_DISABLE"
ENFORCE_ENV = "WOMR_RAIL_ANCHOR_ENFORCE"
REPO_ENV = "WOMR_ROOT"
INTERVAL_ENV = "WOMR_RAIL_ANCHOR_INTERVAL_SECONDS"
TIMEOUT_ENV = "WOMR_RAIL_ANCHOR_TIMEOUT_SECONDS"
TOON_BIN_ENV = "WOMR_TOON_BIN"

DEFAULT_REPO = "/home/wom/infra/womr"
DEFAULT_INTERVAL_SECONDS = 300
# The rail takes ~1.3s on a clean tree. Bound it so a hung check cannot stall a
# turn; a timeout yields a BLIND verdict, which warns but never blocks.
DEFAULT_TIMEOUT_SECONDS = 20

# Commands that would execute the rail. Substring match, not a parse: a false
# miss only costs the warning we already give.
_RAIL_MARKERS = ("womr.ts", "bun womr")

_cache: dict = {"at": 0.0, "verdict": None}


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _disabled() -> bool:
    return os.environ.get(DISABLE_ENV, "").strip() not in ("", "0", "false")


def _run_doctor(repo: str):
    """The only IO. Runs the rail, decodes its receipt, returns a Verdict.

    Decoding goes through the `toon` CLI rather than a parser written here: the
    receipt is TOON, and @toon-format/cli already decodes it to typed JSON.
    Never raises -- every failure path yields a BLIND verdict.
    """
    timeout = _int_env(TIMEOUT_ENV, DEFAULT_TIMEOUT_SECONDS)
    try:
        proc = subprocess.run(
            ["bun", "womr.ts", "lanes", "doctor"],
            cwd=repo, capture_output=True, text=True, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return doctor.blind("could not run lanes doctor: %s" % exc)
    if not (proc.stdout or "").strip():
        detail = (proc.stderr or "").strip().splitlines()
        return doctor.blind(
            "lanes doctor produced no output (rc=%d)%s"
            % (proc.returncode, (": " + detail[0][:120]) if detail else "")
        )
    try:
        decoded = subprocess.run(
            [os.environ.get(TOON_BIN_ENV) or "toon", "-d"],
            input=proc.stdout, capture_output=True, text=True, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return doctor.blind("toon CLI unavailable, cannot decode receipt: %s" % exc)
    if decoded.returncode != 0:
        return doctor.blind("toon failed to decode the receipt")
    try:
        return doctor.verdict(json.loads(decoded.stdout))
    except ValueError as exc:
        return doctor.blind("decoded receipt is not JSON: %s" % exc)


def _verdict_cached(repo: str):
    now = time.monotonic()
    interval = _int_env(INTERVAL_ENV, DEFAULT_INTERVAL_SECONDS)
    cached = _cache["verdict"]
    if cached is not None and (now - _cache["at"]) < interval:
        return cached
    v = _run_doctor(repo)
    _cache["at"], _cache["verdict"] = now, v
    return v


def pre_llm_call(**kwargs: Any):
    """Inject the rail's verdict into the turn. Silent when the tree is clean."""
    try:
        if _disabled():
            return None
        repo = os.environ.get(REPO_ENV) or DEFAULT_REPO
        if not os.path.isdir(repo):
            return None  # not this machine's womr checkout; nothing to say
        v = _verdict_cached(repo)
        if not v.breach:
            return None  # a clean rail says nothing
        return {"context": doctor.message(v)}
    except Exception:
        logger.warning("womr-rail-anchor: check skipped", exc_info=True)
        return None


def pre_tool_call(tool_name: str = "", args: Any = None, **_: Any):
    """Refuse to run the rail while breached. OPT-IN via WOMR_RAIL_ANCHOR_ENFORCE.

    Never gates the repair (`pnpm install`), and never blocks on a BLIND verdict:
    an unreadable instrument is a reason to warn, not to wedge the operator's
    shell. Warning is the belt; this is the suspenders.
    """
    try:
        if _disabled():
            return None
        if os.environ.get(ENFORCE_ENV, "").strip() in ("", "0", "false"):
            return None
        if tool_name != "terminal":
            return None
        command = (args or {}).get("command") or ""
        if not any(marker in command for marker in _RAIL_MARKERS):
            return None
        repo = os.environ.get(REPO_ENV) or DEFAULT_REPO
        v = _verdict_cached(repo)
        if not v.breach or v.blind:
            return None
        return {
            "action": "block",
            "message": (
                "REFUSED: %s. This command would execute code that is not the repo's, "
                "so its result would be uncited either way. Repair with `pnpm install` "
                "in %s -- never `bun install`. To run it anyway, unset %s."
                % (v.reason, repo, ENFORCE_ENV)
            ),
        }
    except Exception:
        # Fail OPEN: a bug in this guard must never wedge the operator's shell.
        logger.warning("womr-rail-anchor: gate skipped", exc_info=True)
        return None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("pre_tool_call", pre_tool_call)


__all__ = ["pre_llm_call", "pre_tool_call", "register", "doctor"]
