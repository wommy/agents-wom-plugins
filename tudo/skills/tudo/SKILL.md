---
name: tudo
description: Reconcile the L1 session tasklist, L2 Womr roadmap, and L3 Hermes Kanban without merging their authorities; use when promoting, demoting, or verifying unfinished work.
---

# TUDO: three-tier tasklist workflow

Use the tiers as separate authorities:

- L1 is the current Codex native plan/session working set. It dies with the
  session unless unfinished work is explicitly demoted to L2.
- L2 is data/womr-roadmap.roadmap.toon, the durable unfinished-work frontier.
- L3 is Hermes Kanban/Alchemy, the execution and landing receipt authority.

The loop is L3 graph/archive -> promote to L2 -> collapse into L1 -> execute through
the owning Womr rail -> return fresh execution receipts to L3. Never merge the
schemas or infer one tier from another.

## Codex plan bootstrap

When `/tudo` is invoked in Codex, create the native plan first with
`update_plan`. Start it with these tier steps, adapting only their
evidence-backed details:

1. L1 — inspect the native plan and Tudo mirror; keep unfinished work visible.
2. L2 — project the durable roadmap through `bun womr.ts tasklist project`.
3. L3 — inspect/rank Hermes Kanban through the Womr Kanban rail; do not infer landed state.
4. Execute through the owning rail; demote unfinished L1 work before session end.
5. Verify fresh receipts and unresolved adjacent seams before closure.

The Codex hook observes the resulting native `update_plan` lifecycle. It does
not replace the native plan, invent a second plan, or claim the plan is proof.

## Reconciliation

1. Maintain L1 with Codex's native plan tool. The plugin cannot call or
   persist that plan through MCP.
2. Read the current tasklist projection:
   bun womr.ts tasklist project
3. Read the relevant L2 row through the tasklist projection; use
   bun womr.ts toon update-row only for an explicit durable roadmap change.
4. Read L3 through the Kanban rail. Do not treat a tasklist row, receipt, or
   agent self-report as live execution proof.
5. For structural code questions, use graph/AST/cdmgr before raw search.
6. Execute through the owning rail and record the exact commit, landed SHA,
   runtime state, or blocker.
7. Before session end, demote every unfinished L1 item to L2. Do not create a
   new card when an existing seam owns the work.

The stdio MCP action boundary is explicit: `tudo_demote` plans by default and
only writes the roadmap when called with `apply: true`; `tudo_link` requires the
host `repo`, validates an existing roadmap `n`, and rejects duplicate ownership.
Same-row links are idempotent. L3 Kanban remains outside this MCP write path.

## Client hook sections

The plugin keeps client-specific lifecycle wiring separate:

- Claude: `hooks/claude/hooks.json` observes `TaskCreated` and
  `TaskCompleted` and feeds the existing task mirror.
- Codex: `hooks/codex/hooks.json` observes native `update_plan` through
  `PreToolUse` and `PostToolUse`. The observer is async, non-blocking, and
  does not rewrite the native plan. A later Womr projection rail may consume
  the event; the hook itself is not an L2/L3 receipt.

The shared skill remains provider-neutral. Hooks are client adapters, not a
fourth authority and not a substitute for explicit demotion or live L3 proof.

## Brief contract

For delegated work, keep the Brief inline and explicit:

- goal: the exact tier-loop outcome;
- input: paths, current SHA, tasklist keys, and known blocker;
- output: bounded edits or evidence plus fresh verification;
- done: exact proof and unresolved adjacent seams.

An unfinished or unverified result stays open and returns to L2.

## When the hooks are cold

Plugin hooks and MCP servers both wire at SESSION START. A resumed session
(`--continue` / `--resume`) keeps its task list but does NOT rebuild the hook
table, so `TaskCreated` fires nothing and the mirror silently stops tracking
L1. `claude plugin details` still reports `Hooks (2)` throughout — that proves
registration, never wiring. The only proof is a row appearing in the mirror.

So do not trust the automatic path. Belt and suspenders:

- **Belt** — the client hook. Automatic, but only in a session that started
  with the plugin already installed.
- **Suspenders** — the `observe_l1_event` MCP tool, reachable by any client,
  including ones with no task-event concept at all.
- **Neither available** — spawn the call directly. This needs no hook, no live
  MCP connection, and no restart:

  ```sh
  bun "$CLAUDE_PLUGIN_ROOT/mcp/call.ts" claude '{"hook_event_name":"TaskCreated","task_id":"42","task_subject":"...","task_description":"...","session_id":"..."}'
  ```

  `client` is `claude` or `codex`. `mcp/call.ts` resolves the server relative to
  its own path when `PLUGIN_ROOT` is unset, so a bare absolute path works too.

Check before trusting the mirror, and sync by hand when it is behind:

```sh
bun -e 'const r=JSON.parse(await Bun.file(process.env.HOME+"/.local/state/tudo/mirror.json").text());console.log(r.length,r.map(x=>x.id).join(","))'
```
