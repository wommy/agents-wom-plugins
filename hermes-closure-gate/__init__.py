"""User-owned Hermes closure gate.

This plugin owns only the deterministic ``pre_verify`` continuation seam. It does
not decide whether a change is correct, mutate files, or replace /penultimate.
"""

from __future__ import annotations

import re
from typing import Any

_TERMINAL_CLAIM = re.compile(
    r"\b(?:done|complete|completed|fixed|passed|closed|resolved|finished|all\s+set)\b",
    re.IGNORECASE,
)
_NEGATED_CLAIM = re.compile(
    r"(?:\bnot|\bnever|\bstill|\bremains?|\bisn['’]t|\bis\s+not)\s*$",
    re.IGNORECASE,
)
_REQUIRED_RECEIPT_FIELDS = ("STATE:", "BELT:", "SUSPENDERS:", "BUCKLE:")
_CONTINUE_MESSAGE = (
    "Closure gate: keep the turn open. The response contains a terminal claim "
    "without the required receipt. Reconcile /penultimate and return exactly "
    "STATE, BELT, SUSPENDERS, and BUCKLE. Bind owner/source, fresh proof, the "
    "adjacent seam and its next witness, plus a positive control for any negative "
    "claim. If the seam is unresolved, use STATE: OPEN; do not claim completion."
)


def _is_negated(text: str, start: int) -> bool:
    """Avoid treating explicit non-closure statements as terminal claims."""
    prefix = text[max(0, start - 24) : start]
    return bool(_NEGATED_CLAIM.search(prefix))


def _has_terminal_claim(text: str) -> bool:
    return any(not _is_negated(text, match.start()) for match in _TERMINAL_CLAIM.finditer(text))


def _has_receipt(text: str) -> bool:
    return all(field in text for field in _REQUIRED_RECEIPT_FIELDS)


def pre_verify(**kwargs: Any) -> dict[str, str] | None:
    """Keep an edited turn open when closure prose lacks the typed receipt."""
    changed_paths = kwargs.get("changed_paths") or []
    final_response = kwargs.get("final_response")
    if not isinstance(final_response, str) or not final_response.strip():
        return None
    if not changed_paths:
        return None
    if not _has_terminal_claim(final_response):
        return None
    if _has_receipt(final_response):
        return None
    return {"action": "continue", "message": _CONTINUE_MESSAGE}


def register(ctx: Any) -> None:
    ctx.register_hook("pre_verify", pre_verify)


__all__ = ["pre_verify", "register"]
