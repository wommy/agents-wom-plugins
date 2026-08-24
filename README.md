# agents-wom-plugins

Public mirror of the operator's Hermes/agent plugins — subtree-exported from
the private [`agents-wom`](https://github.com/wommy/agents-wom) config DR repo
(`plugins/` prefix).

## Plugins

| Plugin | What it does |
|---|---|
| `tudo` | Three-tier tasklist interface: L1 harness tasks · L2 Womr roadmap · L3 Hermes Kanban |
| `womr-rail-anchor` | PreToolUse guard anchoring effects to the active Womr rail |
| `womr-kanban-governor` | Dispatch governor protecting Kanban admission/concurrency |
| `hermes-closure-gate` | Completion-claim gate: no terminal language without fresh proof |
| `womr-skill-reachability` | Skill discovery/reachability checker across skill homes |

## Provenance

Build-source is [Womr](https://github.com/wommy/womr) (`plugins/` there);
this repo is a deploy/DR snapshot, not the authoring surface. Some files
reference operator-local paths (`/home/wom`, linuxbrew) — cosmetic, not
secrets; scans run before every publish.

## Sync

From the private repo (canonical):

```sh
# publish plugin changes to this repo
git -C ~/.config/agents-wom subtree push --prefix=plugins plugins-gh main

# add/update a plugin: copy into ~/.config/agents-wom/plugins/<name>,
# commit, then subtree push as above
```

Private repo stays authoritative; this mirror is push-only.
