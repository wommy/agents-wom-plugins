---
name: agent-plugins
description: Build and validate portable Agent Plugins v1 packages.
version: 0.0.1
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [agent-plugins, plugin-json, mcp-json, containment]
---

# Portable Agent Plugins v1

## Scope

Build or review one self-contained plugin directory conforming to Agent Plugins Specification v1.0.0. This leaf owns package shape and containment checks; client runtime registration remains outside it.

## Required shape

```text
<plugin-root>/
├── plugin.json
├── skills/<skill-name>/SKILL.md
└── mcp.json                 # optional
```

`plugin.json` is the only portable manifest. It must use:

```text
https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
```

The manifest name is lowercase, 1–64 characters, starts/ends alphanumeric, permits `a-z`, `0-9`, `-`, `.`, and forbids `--`/`..`.

## Containment

Plugin-relative `command`, `cwd`, and fixed component paths must begin with `./` and resolve inside the plugin root. Reject symlink escapes. Do not treat opaque command arguments or environment values as package paths. Never put credentials in `plugin.json`, `mcp.json`, or skill text.

## Verification

From the plugin root:

```bash
bun test
```

Then inspect the package with a fresh JSON parse and verify:

- manifest schema/name/version;
- no unexpected portable top-level fields;
- immediate-child skill discovery;
- optional MCP schema only if `mcp.json` exists;
- resolved component paths remain inside the root;
- no runtime/client registration occurred.

## House boundary

`/home/wom/.config/agents-wom` remains the config/DR authority. A package named `agent-plugins` under its `plugins/` directory follows the external specification without renaming the parent home.
