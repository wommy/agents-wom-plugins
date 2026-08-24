---
name: closure-gate
description: Use when a Hermes turn changes files and the final response risks claiming completion without a typed closure receipt.
---

# Closure gate companion skill

This portable skill describes the human-facing contract for a client-specific closure extension.

- `STATE` names the exact outcome and scope.
- `BELT` names the owning source and fresh proof.
- `SUSPENDERS` names the adjacent seam, owner, and next witness.
- `BUCKLE` names the independent proof and positive control.

The portable package does not require a client to implement Hermes `pre_verify`. Clients that do implement the `com.nousresearch.hermes` extension may load the native `plugin.yaml` and `__init__.py` entrypoint. The portable `plugin.json` and this regular `SKILL.md` remain valid and usable by clients that support Agent Plugins v1 skills.
