---
name: tudo
description: Use when reconciling, promoting, or demoting tasks across the L1 harness task list, L2 womr roadmap backlog, or L3 hermes kanban — e.g. "what's unfinished on my task list", "demote my tasks to the backlog before I end this session", "sync L1 tasks to the roadmap", "is this task actually done or just marked done", "promote a backlog item to a task". Also use when the user invokes /tudo.
---

# Three-tier tasklist doctrine

Three tiers. Three dialects. Three link mechanisms. No merge between them — ever.

## The tiers

- **L1** — harness task list. `TaskCreate`/`TaskUpdate`/`TaskList` tool calls only. Dies at session end. No durability. Only two moments in a task's life are OBSERVABLE from outside: the `TaskCreated` and `TaskCompleted` hook events. There is no update/status-change event, so a task going `in_progress` is invisible.
- **L2** — `data/womr-roadmap.roadmap.toon`, `backlog[]` block. Durable. `n` is IDENTITY, not position — the block is sparse with tombstoned gaps. Never derive `n` from array length or count.
- **L3** — hermes kanban sqlite. Execution authority. Tens of thousands of cards.

## Hard rules

1. **`n` is identity, never position.** Allocating a new L2 `n` is `max(n) + 1` over the existing backlog, never `length + 1`. Counting reissues an `n` some other file still points at.
2. **`done` at L3 means LANDED — a commit in the tree — not self-reported.** A card marked done certifies a claim, not a fact. Verify before trusting it.
3. **Anything unfinished at L1 when the session ends is lost unless demoted to L2 first.** L1 has no persistence. If a task matters past this session, it must exist as an L2 backlog row (or an L3 card) before the session closes.
4. **Promote/demote move the INTERFACE, never merge the authorities.** L1, L2, and L3 have genuinely different lifecycles and owners (harness / durable-file / kanban-db). A demote writes a new L2 row that links back to the L1 id; it does not make L2 "own" L1's lifecycle, and it does not collapse the three into one schema.

## The mirror

This plugin observes the `TaskCreated` and `TaskCompleted` hook events and folds each into a durable JSON mirror (`lib/mirror.ts` + `hooks-handlers/task-mirror.ts`) — this is the missing write path off L1, not a fourth authority. The mirror is a read cache of what L1 said; it is not itself durable authority the way L2/L3 are.

**Not `PostToolUse`.** The task tools do not fire `PreToolUse`/`PostToolUse` at all — anthropics/claude-code#20243 was closed on 2026-01-23 by ADDING `TaskCreated`/`TaskCompleted`, not by restoring `PostToolUse`. Neither event supports a `matcher` (they always fire), and neither supports an `if` key; adding either stops the hook running. Both fire **synchronously and can block** — a non-zero exit deletes the task or refuses the completion — which is why the handler exits 0 on every path.

Consequences of what the events do NOT carry:

- No `metadata` field, so there is no harness-side channel for the L1<->L2 link. The mirror OWNS `backlogN`: the demote step writes it back in (`applyDemoteLinks`), and nothing ever reads it out of a payload.
- `task_id` is only unique within a session, so rows are keyed by `(session_id, task_id)`.
- No status-change event, so `status` is only ever `pending` or `completed`. "Not completed" is the ONLY liveness signal available — there is no started-but-unfinished state to see, and a deleted task is unobservable.

`lib/demote.ts` plans (never writes) a batch move of unfinished mirror rows into L2 backlog rows: it allocates every new `n` in one pure pass so a multi-row demote never corrupts the backlog file by faking a batch through a single-pair `--set`.

## MCP action surface

The stdio MCP server exposes the effect boundary around those pure plans:

- `tudo_promote` reports unfinished mirror rows absent from the caller's L1
  plan; it never creates or deletes harness tasks.
- `tudo_demote` is a dry-run by default. With `apply: true`, it appends through
  the host Womr TOON rail and links the mirror only after the appends succeed.
- `tudo_link` requires `id`, `n`, and the host `repo` (with an optional bare
  `roadmap` filename). It validates that `n` exists and is not already owned by
  another mirror row before writing. Same-row re-link is idempotent.
- `tudo_add` inserts an agent row (`id`, `subject`, optional `description`/`backlogN`/`sessionId`) directly into the L1 mirror; it defaults `sessionId` to `agent`, rejects empty subjects, and is idempotent on `(sessionId,id)`.

## What this plugin does NOT do

- It does not write the real kanban db — L3 remains a separate execution and landing authority.
- It does not merge L1/L2/L3 schemas into one. `MirrorRow.backlogN` is a link field, not a schema unification.
- It does not talk to L3 at all yet (no MCP surface in this version — see plugin report for what an MCP surface would add).
- It does not observe task deletion or `in_progress`: no event reports either.
