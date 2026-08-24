/**
 * Where the mirror lives. Shared by the hook handler that writes it and the
 * CLI that reads it — if these two ever disagreed, the CLI would silently plan
 * against an empty mirror and demote nothing.
 */

import * as Config from 'effect/Config'
import type { ConfigError } from 'effect/Config'
import type * as Effect from 'effect/Effect'

/**
 * Most-specific first.
 *
 * The Agent Plugins spec defines `PLUGIN_DATA` (§9.1) as a client-managed
 * directory that survives plugin updates — the right home for exactly this.
 * But the spec guarantees it only to plugin SUBPROCESSES the client launches,
 * meaning stdio MCP servers; a hook handler is not one, and Claude Code
 * supplies `CLAUDE_PLUGIN_ROOT` to hooks with no data counterpart. So a
 * hook-only plugin has no spec-defined writable tier, and this falls back to
 * XDG rather than inventing one.
 *
 * XDG_STATE_HOME, specifically: a task mirror is derived state that must
 * survive a restart — not user data (DATA), not discardable (CACHE), not
 * login-scoped (RUNTIME). Deliberately NOT the host repo's `~/infra` durable
 * tier: this plugin is portable and has no business imposing a private
 * convention on someone else's machine.
 */
export const mirrorPath: Effect.Effect<string, ConfigError> = Config.string('TUDO_MIRROR').pipe(
	Config.orElse(() => Config.string('PLUGIN_DATA').pipe(Config.map(dir => `${dir}/mirror.json`))),
	Config.orElse(() =>
		Config.string('XDG_STATE_HOME').pipe(Config.map(dir => `${dir}/tudo/mirror.json`)),
	),
	Config.orElse(() =>
		Config.string('HOME').pipe(Config.map(home => `${home}/.local/state/tudo/mirror.json`)),
	),
	Config.withDefault('.local/state/tudo/mirror.json'),
)
