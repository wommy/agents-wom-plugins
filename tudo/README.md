# tudo

Three-tier tasklist interface for agent work: **L1** harness/session tasklist ·
**L2** Womr roadmap backlog · **L3** Hermes Kanban execution board. Reconcile,
promote, demote, and verify across tiers — without merging their authorities.
Each tier keeps its own dialect and link mechanism; nothing auto-merges, ever.

## Layout

```
tudo/
├── plugin.json            agent-plugins.org v1.0.0 manifest
├── mcp.json               MCP servers (stdio) exposed by this plugin
├── skills/tudo/SKILL.md   the skill — canonical, single copy
├── lib/                   mirror / demote / roadmap / act / store logic
├── mcp/                   MCP server + call routing (server.bundle.js included)
├── hooks/                 claude/ codex/ hook wiring (hooks.json)
├── hooks-handlers/        task-mirror, codex-plan-observer, claude-mcp-observer
└── tests/                 conformance + unit suites (bun test)
```

## Skill discovery

One skill file only, at the spec-mandated fixed location
`skills/tudo/SKILL.md` (agent-plugins.org v1.0.0 §6.1). Consumers verified:
Hermes loads it via its skills-home symlink adapter; Claude Code / Codex
discover it at the fixed location; womr's `tests/manifest.test.ts` reads it.
A root-level `SKILL.md` copy existed before the `skills/` restructure and had
no remaining consumers — removed 2026-08-24.

## Runtime notes

- MCP server bundle ships prebuilt (`mcp/server.bundle.js`) so clients don't
  need a build step; rebuild from `mcp/server.ts` with bun if you touch it.
- Hooks observe L1 task events (`TaskCreated`/`TaskCompleted` only — those are
  the sole externally observable moments in an L1 task's life) and Codex/Claude
  plan surfaces, mirroring them into the store.
- Tests: `bun test` from the plugin dir.

## Provenance

Authored in the [Womr](https://github.com/wommy/womr) clean room
(`plugins/tudo` there). This copy is a deploy snapshot; file upstream changes
first, then re-sync here.
