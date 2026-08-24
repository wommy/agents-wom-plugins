/**
 * The acting half: the four tier-loop verbs, exposed as plain promises.
 *
 * `lib/` plans (pure, portable); this module performs — it resolves the mirror
 * path, reads and atomically rewrites the mirror, and spawns the host repo's
 * toon rail. The planners stay runnable in a test with no filesystem and no
 * womr checkout, which is why every effect that touches the outside world
 * lives here and not in `demote.ts`.
 *
 * These were a CLI on the lane this was folded from. They are NOT a CLI here:
 * the repo rule is one rail surface per action and no side CLIs, and the
 * plugin already owns a stdio MCP server that every client can reach. So the
 * verbs land as tools on that server, and this module is the plain-promise
 * boundary between its hand-rolled JSON-RPC and the Effect-typed lib.
 *
 * @public
 */

import { BunServices } from '@effect/platform-bun'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { type DemoteRow, planDemote, planPromote } from './demote.ts'
import { applyDemoteLinks, insertAgentRow, type MirrorRow } from './mirror.ts'
import { mirrorPath } from './paths.ts'
import { backlogCountMismatch, parseBacklogEntries } from './roadmap.ts'
import { loadMirror, writeMirrorAtomic } from './store.ts'

/** The host repo's toon rail refused a row. */
export class ToonAppendError extends Schema.TaggedError<ToonAppendError>()('ToonAppendError', {
	n: Schema.Finite,
	exitCode: Schema.Finite,
	stderr: Schema.String,
}) {}

/** No repo root was supplied and none could be inferred. */
export class RepoUnresolvedError extends Schema.TaggedError<RepoUnresolvedError>()(
	'RepoUnresolvedError',
	{ reason: Schema.String },
) {}

/**
 * Resolve the host repo root.
 *
 * `process.cwd()` is NOT a usable default here, which is the one real
 * difference between this and the CLI it was folded from. A CLI is run by a
 * human standing in the repo; an MCP server is a stdio subprocess the client
 * launches from wherever it happens to be — commonly the client's own install
 * dir. Defaulting to cwd would therefore resolve `data/<roadmap>` against an
 * unrelated directory and report "no backlog block found" for a roadmap that
 * is perfectly fine, blaming the corpus for a caller mistake.
 *
 * So: an explicit argument, else `TUDO_REPO`, else fail with the reason. The
 * root is checked for `womr.ts` because that is the file the append actually
 * spawns — proving the path before the write beats a confusing rail error.
 */
const resolveRepo = (
	repo: string | undefined,
): Effect.Effect<string, RepoUnresolvedError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const root = repo ?? process.env.TUDO_REPO
		if (root === undefined || root === '') {
			return yield* Effect.fail(
				new RepoUnresolvedError({ reason: 'pass `repo`, or set TUDO_REPO to the womr checkout' }),
			)
		}
		const fs = yield* FileSystem.FileSystem
		if (!(yield* fs.exists(`${root}/womr.ts`).pipe(Effect.orElseSucceed(() => false)))) {
			return yield* Effect.fail(
				new RepoUnresolvedError({ reason: `no womr.ts under ${root} — not a womr checkout` }),
			)
		}
		return root
	})

/**
 * Append one row through the host repo's own toon rail rather than editing the
 * file directly. The rail owns validation, quoting and the write receipt; a
 * plugin that hand-wrote TOON would be a second, worse writer of a format it
 * does not own — and hand-pasted multi-row TOON into `--set` is the exact scar
 * `planDemote`'s batch allocation was written to cure.
 */
const appendRow = (
	repo: string,
	roadmap: string,
	row: DemoteRow,
): Effect.Effect<void, ToonAppendError> =>
	Effect.flatMap(
		Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(
					[
						'bun',
						'womr.ts',
						'toon',
						'append',
						roadmap,
						'backlog',
						'--set',
						`n=${row.n}`,
						'--set',
						`item=${row.item}`,
					],
					{ cwd: repo, stdout: 'pipe', stderr: 'pipe' },
				)
				const [exitCode, stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stderr).text(),
				])
				return { exitCode, stderr }
			},
			catch: cause => new ToonAppendError({ n: row.n, exitCode: -1, stderr: String(cause) }),
		}),
		({ exitCode, stderr }) =>
			exitCode === 0
				? Effect.void
				: Effect.fail(new ToonAppendError({ n: row.n, exitCode, stderr })),
	)

/** Every unfinished mirror row, and where the mirror lives. */
const statusEffect = Effect.gen(function* () {
	const path = yield* mirrorPath
	const rows = yield* loadMirror(path)
	return { path, rows }
})

/**
 * Plan — and with `apply`, perform — the L1 → L2 demotion.
 *
 * The write order is load-bearing and is the reason this is not two tools. The
 * rows are appended first and the mirror is linked only after every append
 * succeeded: a row marked `already-linked` that was never actually written
 * would be silently dropped from the next run's plan, which is the one failure
 * mode that loses work rather than duplicating it.
 */
const demoteEffect = (args: { repo?: string; roadmap: string; apply: boolean }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const repo = yield* resolveRepo(args.repo)
		const path = yield* mirrorPath
		const mirror = yield* loadMirror(path)

		const roadmapPath = `${repo}/data/${args.roadmap}`
		const text = yield* fs.readFileString(roadmapPath)
		const backlog = yield* parseBacklogEntries(text)
		const warning = yield* backlogCountMismatch(text, backlog.length)

		const plan = planDemote(mirror, backlog)
		const base = {
			path,
			roadmapPath,
			mirrorRows: mirror.length,
			backlogRows: backlog.length,
			...(warning === undefined ? {} : { warning }),
			plan: { rows: plan.rows, skipped: plan.skipped },
		}

		if (plan.rows.length === 0 || !args.apply) {
			return { ...base, applied: false }
		}

		// Ordered, not concurrent: `n` was allocated in sequence and the rail
		// appends to one file, so overlapping writers would interleave rows and
		// race the receipt.
		const appended: number[] = []
		for (const row of plan.rows) {
			yield* appendRow(repo, args.roadmap, row)
			appended.push(row.n)
		}

		yield* writeMirrorAtomic(path, applyDemoteLinks(mirror, plan.links))
		return { ...base, applied: true, appended, linked: plan.links.length }
	})

/**
 * Point an L1 row at a backlog entry that ALREADY exists.
 *
 * `planDemote` dedupes on linkage, not on content — it cannot tell that task
 * #23 and backlog 111 are the same work, because one is a subject line and the
 * other is a paragraph written weeks earlier. Without this verb the only way
 * to stop a known-duplicate row being demoted again is to let it be written
 * twice, so the roadmap grows a second identity for one piece of work and
 * `n`-as-identity quietly stops meaning anything.
 */
const linkEffect = (args: { id: string; n: number; repo?: string; roadmap?: string }) =>
	Effect.gen(function* () {
		const path = yield* mirrorPath
		const mirror = yield* loadMirror(path)
		const row = mirror.find(candidate => candidate.id === args.id)
		if (row === undefined) {
			return { linked: false, reason: `no mirror row with id ${args.id}`, id: args.id }
		}
		// Same-row re-link is idempotent — succeed without extra work.
		if (row.backlogN === args.n) {
			return { linked: true, id: args.id, n: args.n }
		}
		// Validate the target backlog identity when a repo is provided.
		if (args.repo !== undefined) {
			const fs = yield* FileSystem.FileSystem
			const roadmapFile = args.roadmap ?? 'womr-roadmap.roadmap.toon'
			const roadmapPath = `${args.repo}/data/${roadmapFile}`
			const text = yield* fs.readFileString(roadmapPath)
			const backlog = yield* parseBacklogEntries(text)
			const exists = backlog.some(entry => entry.n === args.n)
			if (!exists) {
				return { linked: false, id: args.id, n: args.n, reason: `no backlog row n=${args.n} in ${roadmapPath}` }
			}
			const owner = mirror.find(candidate => candidate.backlogN === args.n)
			if (owner !== undefined) {
				return {
					linked: false,
					id: args.id,
					n: args.n,
					reason: `backlog n=${args.n} already linked to mirror row ${owner.sessionId}/${owner.id}`,
				}
			}
		} else {
			// Without repo context, still enforce uniqueness locally.
			const owner = mirror.find(candidate => candidate.backlogN === args.n)
			if (owner !== undefined) {
				return {
					linked: false,
					id: args.id,
					n: args.n,
					reason: `backlog n=${args.n} already linked to mirror row ${owner.sessionId}/${owner.id}`,
				}
			}
		}
		yield* writeMirrorAtomic(
			path,
			applyDemoteLinks(mirror, [{ sessionId: row.sessionId, id: row.id, n: args.n }]),
		)
		return { linked: true, id: args.id, n: args.n }
	})

/**
 * The return leg: mirror → L1.
 *
 * Everything else in this plugin runs one way, and that is the whole reason a
 * session can look clean while carrying unfinished work. L1 dies at session
 * end; the mirror does not. A new session therefore starts with an empty task
 * list and NOTHING repopulates it, so "no pending tasks" means "this process
 * has not been told about them yet", which is indistinguishable from done.
 *
 * `have` takes the ids the session already has, so this reports only genuine
 * drift. Omit it and every unfinished row is reported, which is the correct
 * behaviour at the start of a fresh session precisely because L1 is empty then.
 *
 * This REPORTS rather than creates: task creation is a harness tool call, not
 * something an MCP server can reach. The agent reads the result and calls its
 * own task-create tool — which is also why the result can never express a
 * deletion; see `planPromote`'s contract.
 */
const promoteEffect = (args: { have: readonly string[] }) =>
	Effect.gen(function* () {
		const path = yield* mirrorPath
		const rows = yield* loadMirror(path)
		const missing = planPromote(rows, new Set(args.have))
		return { path, mirrorRows: rows.length, missing, inSync: missing.length === 0 }
	})

/**
 * Agent-side row insertion into the L1 mirror.
 *
 * The mirror is the durable projection of L1; this verb lets an agent insert
 * directly without a harness TaskCreated event — e.g. when bootstrapping or
 * when the hook is cold (resumed session). Duplicate (sessionId,id) is
 * idempotent and empty subjects are rejected, both without writing.
 */
const addEffect = (args: {
	id: string
	subject: string
	description?: string
	backlogN?: number
	sessionId?: string
}) =>
	Effect.gen(function* () {
		const trimmed = typeof args.subject === 'string' ? args.subject.trim() : ''
		if (trimmed === '') {
			return { created: false, reason: 'empty' as const }
		}
		const sessionId = args.sessionId !== undefined && args.sessionId !== '' ? args.sessionId : 'agent'
		const path = yield* mirrorPath
		const mirror = yield* loadMirror(path)
		if (mirror.some(row => row.sessionId === sessionId && row.id === args.id)) {
			return { created: false, reason: 'duplicate' as const }
		}
		const backlogN =
			typeof args.backlogN === 'number' && Number.isInteger(args.backlogN) && args.backlogN > 0
				? args.backlogN
				: undefined
		const newRow: MirrorRow = {
			sessionId,
			id: args.id,
			subject: trimmed,
			description: args.description !== undefined ? String(args.description) : '',
			status: 'pending',
			owner: 'agent',
			...(backlogN !== undefined ? { backlogN } : {}),
			seenAt: new Date().toISOString(),
		}
		yield* writeMirrorAtomic(path, insertAgentRow(mirror, newRow))
		return { created: true as const, path }
	})

/**
 * Run one verb to a plain promise.
 *
 * Failures come back as data, not exceptions: this is dispatched from a
 * JSON-RPC handler that must answer every request it accepts, and an
 * unhandled rejection there would drop the reply and hang the client waiting
 * on an id that never resolves.
 */
const run = async <A>(
	effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
): Promise<A | { error: string }> => {
	try {
		return await Effect.runPromise(Effect.provide(effect, BunServices.layer) as Effect.Effect<A, unknown, never>)
	} catch (cause) {
		return { error: String(cause) }
	}
}

/** @public */
export const status = () => run(statusEffect)

/** @public */
export const demote = (args: { repo?: string; roadmap?: string; apply?: boolean }) =>
	run(
		demoteEffect({
			...(args.repo === undefined ? {} : { repo: args.repo }),
			// Bare filename, not a path: the toon rail resolves names against its
			// corpus dir (`data`), so `data/x.toon` would have it look for
			// `data/data/x.toon`.
			roadmap: args.roadmap ?? 'womr-roadmap.roadmap.toon',
			apply: args.apply ?? false,
		}),
	)

/** @public */
export const link = (args: { id: string; n: number; repo?: string; roadmap?: string }) => run(linkEffect(args))

/** @public */
export const add = (args: { id: string; subject: string; description?: string; backlogN?: number; sessionId?: string }) =>
	run(addEffect(args))

/** @public */
export const promote = (args: { have?: readonly string[] }) =>
	run(promoteEffect({ have: args.have ?? [] }))

/** @public */
export type { MirrorRow }
