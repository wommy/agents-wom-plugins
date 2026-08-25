---
name: agent-plugins
description: Use the local Agent Plugins v1 spike for portable plugin package work.
version: 0.0.1
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [agent-plugins, plugins, skills, mcp, conformance]
---

# Agent Plugins

This is a disposable Agent Plugins v1 package spike. It has no runtime registration and no MCP server yet.

## When to Use

Use when designing, validating, or extending a portable plugin package under the Agent Plugins v1 specification.

## Package contract

- Root manifest: `plugin.json`.
- Portable skills: `skills/<skill-name>/SKILL.md`; immediate child only.
- Optional MCP config: root `mcp.json`; this spike intentionally omits it.
- Client extensions belong under reverse-domain directories or `extensions` manifest data.
- Package paths must resolve inside the plugin root.

## Local authority

The package lives under `/home/wom/.config/agents-wom/plugins/agent-plugins`. The parent `agents-wom` directory remains the operator's config/DR home; `agent-plugins` is the portable package name, not a home-directory migration.

## Safety

Do not register, install, dispatch, or expose this spike until a client-specific loader and an isolated conformance probe are approved. Keep client-specific data under a namespaced extension and never add secrets to manifests, skills, or MCP configuration.
