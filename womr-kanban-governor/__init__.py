"""Keep working-lane cards ranked, in-process, on the dispatcher's own tick.

WHY THIS EXISTS
Ready-dispatch orders by ``priority DESC, created_at ASC``. ``specify`` rewrites a
triage card in place and never touches priority, and ``decompose`` mints children
without one -- only ``create``/``swarm`` accept --priority. So cards enter the
working lane at 0, the ORDER BY degenerates to oldest-first FIFO, and the drain
hands out whatever is oldest. A one-shot fix does not hold: the pump regenerates
unranked supply every tick.

WHY A PLUGIN AND NOT A SCRIPT
The predecessor was an external script on a systemd timer that shelled out one
subprocess PER CARD (~3.3s each). At ~2450 unranked cards that is ~2.2h of
subprocess churn against a 2-minute timer and a 30-minute unit timeout, so laps
stopped completing entirely. This does the same work in-process on a hook hermes
already fires, with direct DB writes: no subprocess, no timer, no external
scheduler to fall behind.

SEAM: ``on_kanban_dispatch_tick`` fires once per dispatcher tick, strictly AFTER
``_dispatch_tick_lock`` is released (kanban_db.py:9858/9886 -> :349), so a slow
subscriber cannot extend the single-writer critical section. Observer-only: our
return value is ignored, and we must never raise into the dispatcher.

OWNERSHIP: user-owned plugin, loaded only when listed in ``plugins.enabled``.
No installed-runtime files are modified, so it survives upgrades with no reapply.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from typing import Any

from . import governor

logger = logging.getLogger(__name__)

DISABLE_ENV = "WOMR_KANBAN_GOVERNOR_DISABLE"
MAX_WRITES_ENV = "WOMR_KANBAN_GOVERNOR_MAX_WRITES"
INTERVAL_ENV = "WOMR_KANBAN_GOVERNOR_INTERVAL_SECONDS"
LOCK_BUDGET_ENV = "WOMR_KANBAN_GOVERNOR_LOCK_BUDGET_MS"

# Bounded by default. The dispatcher tick is a shared resource; a governor that
# can spend it without limit is the failure we are replacing.
DEFAULT_MAX_WRITES = 200
DEFAULT_INTERVAL_SECONDS = 120
# Fail-fast lock budget. This hook is SYNCHRONOUS on the dispatcher's tick path,
# so a write lock held by someone else does not merely delay us -- it stalls
# dispatch for however long we are willing to wait. kanban_db.connect() pins no
# busy_timeout of its own, so we pin one rather than inherit a default. Matches
# the predecessor's PRIORITY_WRITE_BUSY_TIMEOUT_MS budget.
DEFAULT_LOCK_BUDGET_MS = 8000

_last_run_at = 0.0


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _load_board(conn) -> tuple[list[dict], list[tuple[str, str]]]:
    rows = [
        {"id": r[0], "status": r[1], "priority": r[2], "title": r[3]}
        for r in conn.execute("SELECT id, status, priority, title FROM tasks")
    ]
    links = [
        (r[0], r[1])
        for r in conn.execute("SELECT parent_id, child_id FROM task_links")
    ]
    return rows, links


def _apply(conn, kanban_db, plan, board) -> int:
    """Write the plan. One txn for the bounded batch, notifications after commit."""
    now = int(time.time())
    written: list[str] = []
    with kanban_db.write_txn(conn):
        for task_id, priority in plan:
            # CAS on priority = 0: if an operator hand-set this card between our
            # read and this write, leave their number alone.
            updated = conn.execute(
                "UPDATE tasks SET priority = ? WHERE id = ? AND priority = 0",
                (int(priority), task_id),
            )
            if updated.rowcount != 1:
                continue
            conn.execute(
                "INSERT INTO task_events (task_id, kind, payload, created_at) "
                "VALUES (?, 'reprioritized', ?, ?)",
                (task_id, json.dumps({"priority": int(priority)}), now),
            )
            written.append(task_id)
    # Mutation-boundary observer, post-commit -- this direct-SQL write bypasses
    # the kanban_db mutators, so report it here the way the bundled dashboard
    # plugin does for its own direct writes.
    for task_id in written:
        try:
            kanban_db.notify_task_updated(conn, task_id, ("priority",), board=board)
        except Exception:  # observer must never break the writer
            logger.debug("notify_task_updated failed for %s", task_id, exc_info=True)
    return len(written)


def on_kanban_dispatch_tick(**kwargs: Any) -> None:
    """Rank unranked working-lane cards. Never raises into the dispatcher."""
    global _last_run_at
    try:
        if os.environ.get(DISABLE_ENV, "").strip() not in ("", "0", "false"):
            return
        if kwargs.get("dry_run"):
            return

        interval = _int_env(INTERVAL_ENV, DEFAULT_INTERVAL_SECONDS)
        now = time.monotonic()
        if _last_run_at and (now - _last_run_at) < interval:
            return
        _last_run_at = now

        from hermes_cli import kanban_db

        board = kwargs.get("board")
        if board is None:
            board = kanban_db.get_current_board()

        # connect_closing, never connect: this runs in the long-lived gateway
        # dispatcher, where unclosed handles accumulate into FD exhaustion (#33159).
        with kanban_db.connect_closing(board=board) as conn:
            # Pin the budget before touching a single row.
            conn.execute(
                "PRAGMA busy_timeout = %d"
                % _int_env(LOCK_BUDGET_ENV, DEFAULT_LOCK_BUDGET_MS)
            )
            rows, links = _load_board(conn)
            plan = governor.build_plan(
                rows, links, max_writes=_int_env(MAX_WRITES_ENV, DEFAULT_MAX_WRITES)
            )
            if not plan:
                return  # a quiet board says nothing
            written = _apply(conn, kanban_db, plan, board)

        if written:
            logger.info(
                "womr-kanban-governor: ranked %d/%d unranked lane card(s)",
                written, len(plan),
            )
    except sqlite3.OperationalError as exc:
        # A busy board is normal, not an error: yield the tick and try the next
        # one rather than contending with the writer we are running alongside.
        logger.info("womr-kanban-governor: board busy, tick yielded (%s)", exc)
    except Exception:
        # Hook contract: observers are best-effort and a raise here would land in
        # the dispatcher's own error path. Log and yield the tick.
        logger.warning("womr-kanban-governor: tick skipped", exc_info=True)


def register(ctx: Any) -> None:
    ctx.register_hook("on_kanban_dispatch_tick", on_kanban_dispatch_tick)


__all__ = ["on_kanban_dispatch_tick", "register", "governor"]
