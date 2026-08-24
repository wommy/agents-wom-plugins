/**
 * Mirror persistence: the file-touching half, shared by the hook handler that
 * folds events into the mirror and the CLI that reads it back and writes
 * demotion links into it.
 *
 * Both sides must agree on atomicity as well as on the path: the CLI can be
 * run while a task event is firing, and a half-written mirror read by either
 * one is a corrupt mirror for both.
 */

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { decodeMirrorRows, type MirrorRow } from './mirror.ts'

/** JSON did not round-trip. `source` says which side failed. */
export class JsonError extends Schema.TaggedError<JsonError>()('JsonError', {
	source: Schema.Literals(['payload', 'mirror', 'encode']),
	reason: Schema.String,
}) {}

/**
 * Every JSON boundary goes through a typed try. A bare `JSON.parse` inside an
 * `Effect.gen` throws a DEFECT, which error-channel recoveries do not catch —
 * so a single corrupt mirror file would silently swallow an event and every
 * event after it, because nothing would ever rewrite the file.
 */
export const parseJson = (
	source: 'payload' | 'mirror',
	raw: string,
): Effect.Effect<unknown, JsonError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: cause => new JsonError({ source, reason: String(cause) }),
	})

export const encodeJson = (rows: readonly MirrorRow[]): Effect.Effect<string, JsonError> =>
	Effect.try({
		try: () => JSON.stringify(rows, null, 2),
		catch: cause => new JsonError({ source: 'encode', reason: String(cause) }),
	})

/**
 * Load the existing mirror. A missing file is the normal first-run case and
 * yields no rows; a file that exists but does not decode is a real failure and
 * is surfaced as one.
 */
export const loadMirror = (
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
export const writeMirrorAtomic = (
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
