# womr-kanban-governor

Keeps unranked working-lane kanban cards ranked, **in-process**, on the hermes
dispatcher's own tick.

## The problem it replaces

Ready-dispatch orders by `priority DESC, created_at ASC`. `specify` and
`decompose` both mint working-lane cards without a priority, so cards arrive at
0, the ORDER BY degenerates to oldest-first FIFO, and the drain hands out
whatever is oldest.

The predecessor was an external script on a systemd timer that shelled out **one
subprocess per card** (~3.3s each, including a first attempt at a rail verb that
no longer exists). At ~2450 unranked cards that is ~2.2 hours of subprocess churn
against a 2-minute timer and a 30-minute unit timeout — so laps stopped
completing at all, and the board went ungoverned while intake continued.

This does the same work with direct DB writes inside a hook hermes already fires.
No subprocess, no timer, no external scheduler that can fall behind.

## Seam

`on_kanban_dispatch_tick` fires once per dispatcher tick, strictly **after**
`_dispatch_tick_lock` is released (`kanban_db.py:9858/9886` → `:349`), so a slow
subscriber cannot extend the single-writer critical section. The hook is
observer-only: the return value is ignored and this plugin never raises into the
dispatcher.

## Guards

| Guard | Why it is load-bearing |
|---|---|
| Only `priority == 0` rows are scored | an operator's hand-set number is never a candidate |
| Computed scores clamped `< HAND_SET_FLOOR` (90) | structure can never outvote human judgement |
| `UPDATE ... AND priority = 0` CAS on write | a hand-set landing mid-tick still wins |
| `max_writes` bound (default 200) | the shared tick can never be spent without limit |
| Interval throttle (default 120s) | scoring cost is decoupled from tick frequency |
| `connect_closing`, never `connect` | long-lived gateway would otherwise leak FDs (#33159) |
| `PRAGMA busy_timeout` pinned (8s) | hook is synchronous on the tick path; an unbounded wait stalls dispatch itself |
| `sqlite3.OperationalError` yields the tick | a busy board is normal, not an error — never contend with the live writer |
| All exceptions swallowed + logged | a governor bug must not take down dispatch |
| `dry_run` ticks return immediately | never writes during a dry-run dispatch |

## Scoring

Structural only — no judgement about what a card is *about*:

- `leverage` = open transitive descendants (what finishing this card releases)
- `free` = no OPEN parent (nothing upstream blocks it)

Free cards score `60 + min(leverage, 29)`; gated cards `30 + min(leverage, 19)`;
recognised test fixtures sink to `1`. Bands do not overlap, so a free card always
outranks a gated one. Leverage traversal is iterative with a seen-set: a cycle in
the link graph cannot hang the tick.

## Activation (operator-gated)

Installed disabled. Nothing loads until it is explicitly enabled:

```bash
hermes plugins list                          # shows: disabled
hermes plugins enable womr-kanban-governor
```

Takes effect for new dispatcher processes; the gateway must be restarted to pick
it up (a separate, explicitly gated action).

## Rollback

```bash
hermes plugins disable womr-kanban-governor
```

Emergency kill switch without touching config — the plugin returns immediately on
every tick:

```bash
WOMR_KANBAN_GOVERNOR_DISABLE=1
```

## Tuning

| Env | Default | Meaning |
|---|---|---|
| `WOMR_KANBAN_GOVERNOR_DISABLE` | unset | any non-empty, non-`0`/`false` value disables |
| `WOMR_KANBAN_GOVERNOR_MAX_WRITES` | 200 | cards ranked per run |
| `WOMR_KANBAN_GOVERNOR_INTERVAL_SECONDS` | 120 | minimum seconds between runs |
| `WOMR_KANBAN_GOVERNOR_LOCK_BUDGET_MS` | 8000 | fail-fast SQLite busy budget |

## Test

```bash
python3 test/test_governor.py
```

12 tests, pure-python, no hermes runtime and no DB — the scoring contract is
provable without a board. Validate the wiring against the real loader with:

```bash
hermes plugins doctor .
```
