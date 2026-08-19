# womr-skill-reachability

Warns **at session start** when prose routes to a skill by bare name that the
Skill tool cannot load.

## The problem

The harness scans `<root>/*/SKILL.md` at **one level only**. A skill nested at
depth ≥ 2 is real, readable by absolute path, and **un-invocable by bare name**.
Measured 2026-08-19 across the live roots: **929 `SKILL.md` directories, 107
loadable at depth 1, 822 invisible.**

Nesting alone is not the defect — a naive "every nested `SKILL.md` needs a
depth-1 entry" audit reports 1331 of 1535 dark and is useless. Per `unix-philo`,
only a router's **entry point** must be depth-1; nested members are legitimate
by design and are reached by absolute path. Mass-linking them would also load
1331 model-invoked descriptions into every turn. The defect is **nesting plus a
bare-name route**: a name with no skill anywhere is prose, not a bug, and stays
silent.

Live instances found 2026-08-18, all five confirmed by the harness listing the
skill immediately after the symlink landed: `artifact-cube-pipeline`,
`systematic-debugging`, `hermes-local-durability`,
`hermes-usercustomize-overlay`, `hermes-hotpatch-apply-revert`. The last three
**are** the Hermes runtime ownership boundary that `AGENTS.md` requires be
loaded before any installed-runtime write — that always-loaded guard could not
fire, because its skills were dark.

## Why a plugin and not the script it replaces

`~/.hermes/scripts/skill-reachability-audit.sh` runs as **step 6 of
`kanban-tick-guard.sh`** — it rides the kanban pump tick, which is the **wrong
cadence**. A dark skill route matters when a **session begins** and the agent is
about to route by name; it does not matter when a card moves. Worse, the guard
it rides had not completed a lap since 05:39 on the day this was written, so the
audit was effectively dead.

It is also cheaper. The shell version ran one `find -L` over three roots **per
routed name**. This walks the roots **once** into an index and classifies every
route against it — 0.3 s wall for 929 directories, then throttled off entirely.

## Seam

`on_session_start` fires once per brand-new session from
`agent/conversation_loop.py:913` via `hermes_cli.lifecycle.invoke_hook`
(kwargs: `session_id`, `model`, `platform`). It is **not** re-fired on
continuation. The return value is ignored: this is a pure observer and never
raises into the session-start path.

Decision logic lives in `reachability.py` — pure, no IO, no hermes imports,
22 tests. `__init__.py` is the only file that touches the filesystem or
environment.

## Guards

| Guard | Why it is load-bearing |
|---|---|
| `WOMR_SKILL_REACHABILITY_DISABLE` kill switch, checked first | a disabled plugin costs a session start nothing |
| Interval throttle (default 900 s), checked before any IO | session start is latency-sensitive; the skill tree changes on the scale of days |
| Depth-bounded manual walk (default 4) | cluster dirs are **symlinks**; the walk must follow them or under-report, and following without a bound can cycle |
| Visited-realpath set per root | a self-referential cluster link cannot hang session start |
| Roots deduped by realpath | `~/.claude/skills` is a symlink to `~/.agents/skills`; without this one source looks like a DUPLICATE of itself |
| Reachable in **any** root counts | the documented cure symlinks one source into several roots |
| Empty index **or** empty routes ⇒ `BLIND`, never a pass | finding nothing means the scan could not look; a detector that reports OK when blind launders a broken scan into a green light |
| `NOT_A_SKILL` is silent | a bare word in prose is not a defect — this is what keeps the signal usable |
| Top-level `except Exception` → log + `None` | an observer bug must never break session start |
| No writes, no subprocesses, no network | the plugin only ever reports; the cure is printed for a human to run |

## Verdicts

| Verdict | Meaning |
|---|---|
| `REACHABLE` | a depth-1 entry exists in some root |
| `DARK` | the skill is real but only below depth 1 — the route is a dead letter |
| `DUPLICATE` | two **distinct** sources claim the same depth-1 name; which loads is scan-order dependent |
| `NOT_A_SKILL` | no skill of that name anywhere — prose, reported silently as a count |

Several depth-1 entries pointing at the **same** target are `REACHABLE`, not
`DUPLICATE`: that is exactly the cured state the cure command produces.

## Activation (operator-gated)

Installed **disabled**. The symlink only makes it discoverable:

```sh
ln -sfn /home/wom/.config/agents-wom/plugins/womr-skill-reachability \
        /home/wom/.hermes/plugins/womr-skill-reachability
```

Nothing loads until it is explicitly enabled:

```sh
hermes plugins enable womr-skill-reachability
```

## Tuning

| Env | Default | Effect |
|---|---|---|
| `WOMR_SKILL_REACHABILITY_DISABLE` | unset | any value but `0`/`false` disables the hook entirely |
| `WOMR_SKILL_ROOTS` | `~/.claude/skills:~/.agents/skills:~/.config/agents-wom/skills` | `:`-separated roots to scan |
| `WOMR_SKILL_ROUTE_SOURCE` | `/home/wom/inbox/AGENTS.md` | prose whose bare-name routes must resolve |
| `WOMR_SKILL_REACHABILITY_INTERVAL_SECONDS` | `900` | minimum seconds between scans, per process |
| `WOMR_SKILL_REACHABILITY_MAX_DEPTH` | `4` | walk depth bound |

## Test

```sh
python3 test/test_reachability.py     # 22 tests, pure python, no hermes runtime
hermes plugins doctor . --ci          # 1 hook registered
```

The suite was written and run **RED first** (`ModuleNotFoundError: No module
named 'reachability'`) to prove the seam was absent rather than the fixture
malformed.
