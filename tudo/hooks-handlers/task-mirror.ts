#!/usr/bin/env bun
/**
 * `TaskCreated` / `TaskCompleted` hook handler: the Effect IO edge around
 * lib/mirror.ts. Reads the hook JSON payload from stdin, folds the event into
 * the durable mirror file, and ALWAYS exits 0.
 *
 * Exiting 0 is safety-critical, not politeness. Both task events fire
 * synchronously and CAN BLOCK: exit code 2 (or a `{"decision":"block"}` body)
 * makes Claude Code delete the just-created task or refuse the completion. A
 * handler that crashed would therefore destroy the user's tasks, so every
 * failure path here is swallowed and the process exits 0 unconditionally.
 */

import { BunServices } from '@effect/platform-bun'
import * as Config from 'effect/Config'
import type { ConfigError } from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { applyTaskEvent, decodeMirrorRows, type MirrorRow, parseHookEvent } from '../lib/mirror.ts'

/** stdin could not be drained. */
class StdinError extends Schema.TaggedError<StdinError>()('StdinError', {
	reason: Schema.String,
}) {}

/** JSON did not round-trip. `source` says which side: the stdin payload or the mirror file. */
class JsonError extends Schema.TaggedError<JsonError>()('JsonError', {
	source: Schema.Union([
		Schema.Literal('payload'),
		Schema.Literal('mirror'),
		Schema.Literal('encode'),
	]),
	reason: Schema.String,
}) {}

/**
 * Where the mirror lives, most-specific first.
 *
 * The Agent Plugins spec defines `PLUGIN_DATA` (§9.1) as a client-managed directory that
 * survives plugin updates — the right home for exactly this. But the spec guarantees it
 * only to plugin SUBPROCESSES the client launches, meaning stdio MCP servers; a hook
 * handler is not one, and Claude Code supplies `CLAUDE_PLUGIN_ROOT` to hooks with no data
 * counterpart. So a hook-only plugin has no spec-defined writable tier, and this falls
 * back to XDG rather than inventing one.
 *
 * XDG_STATE_HOME, specifically: a task mirror is derived state that must survive a
 * restart — not user data (DATA), not discardable (CACHE), not login-scoped (RUNTIME).
 * Deliberately NOT the host repo's `~/infra` durable tier: this plugin is portable and
 * has no business imposing a private convention on someone else's machine.
 */
const mirrorPath: Effect.Effect<string, ConfigError> = Config.string('TUDO_MIRROR').pipe(
	Config.orElse(() => Config.string('PLUGIN_DATA').pipe(Config.map(dir => `${dir}/mirror.json`))),
	Config.orElse(() =>
		Config.string('XDG_STATE_HOME').pipe(Config.map(dir => `${dir}/tudo/mirror.json`)),
	),
	Config.orElse(() =>
		Config.string('HOME').pipe(Config.map(home => `${home}/.local/state/tudo/mirror.json`)),
	),
	Config.withDefault('.local/state/tudo/mirror.json'),
)

const readStdin: Effect.Effect<string, StdinError> = Effect.tryPromise({
	try: () => Bun.stdin.text(),
	catch: cause => new StdinError({ reason: String(cause) }),
})

/**
 * Every JSON boundary goes through a typed try. A bare `JSON.parse` inside an
 * `Effect.gen` throws a DEFECT, which the error-channel recoveries below do
 * not catch — so a single corrupt mirror file would silently swallow this
 * event and every event after it, because nothing would ever rewrite the file.
 */
const parseJson = (source: 'payload' | 'mirror', raw: string): Effect.Effect<unknown, JsonError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: cause => new JsonError({ source, reason: String(cause) }),
	})

const encodeJson = (rows: readonly MirrorRow[]): Effect.Effect<string, JsonError> =>
	Effect.try({
		try: () => JSON.stringify(rows, null, 2),
		catch: cause => new JsonError({ source: 'encode', reason: String(cause) }),
	})

/**
 * Load the existing mirror. A missing file is the normal first-run case and
 * yields no rows; a file that exists but does not decode is a real failure and
 * is surfaced as one, then absorbed by the caller's fallback to `[]`.
 */
const loadMirror = (
	path: string,
): Effect.Effect<readonly MirrorRow[], unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (!(yield* fs.exists(path))) return []
		const text = yield* fs.readFileString(path)
		return yield* decodeMirrorRows(yield* parseJson('mirror', text), path)
	})

/**
 * Write-to-temp then rename, so a reader never sees a half-written mirror.
 * `acquireRelease` owns the temp path: if the write or the rename dies, the
 * release step removes the leftover instead of littering the state dir.
 */
const writeMirrorAtomic = (
	path: string,
	rows: readonly MirrorRow[],
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const pathService = yield* Path.Path
		yield* fs.makeDirectory(pathService.dirname(path), { recursive: true })
		const body = yield* encodeJson(rows)

		yield* Effect.scoped(
			Effect.flatMap(
				Effect.acquireRelease(Effect.succeed(`${path}.${process.pid}.tmp`), tmp =>
					Effect.ignore(fs.remove(tmp, { force: true })),
				),
				tmp => Effect.flatMap(fs.writeFileString(tmp, body), () => fs.rename(tmp, path)),
			),
		)
	})

const program: Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> = Effect.gen(
	function* () {
		const raw = yield* readStdin
		if (raw.trim() === '') return

		const payload = yield* parseJson('payload', raw)
		const event = parseHookEvent(payload, new Date().toISOString())
		if (Option.isNone(event)) return

		const path = yield* mirrorPath
		// A corrupt or unreadable mirror must not stop us recording this event:
		// start from empty rather than blocking the task the hook fired for.
		const rows = yield* Effect.orElseSucceed(loadMirror(path), () => [] as readonly MirrorRow[])
		yield* writeMirrorAtomic(path, applyTaskEvent(rows, event.value))
	},
)

// Never block a tool call: every failure and defect collapses to exit 0.
// Deliberately NOT BunRuntime.runMain, which exits non-zero on failure and
// would make Claude Code delete the user's task.
Effect.runPromise(program.pipe(Effect.provide(BunServices.layer), Effect.ignoreCause))
	.catch(() => {})
	.finally(() => process.exit(0))
