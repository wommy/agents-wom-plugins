/**
 * Fold logic for mirroring L1 harness task events into a durable
 * row-oriented mirror. No IO here — see hooks-handlers/task-mirror.ts for the
 * Effect/FileSystem edge that calls into this module.
 *
 * EVENTS: `TaskCreated` and `TaskCompleted`. NOT PostToolUse. The task tools
 * do not fire Pre/PostToolUse at all (anthropics/claude-code#20243 was closed
 * 2026-01-23 by ADDING these two events, not by restoring PostToolUse), and
 * neither event supports a matcher. There is no TaskUpdated/TaskStatusChanged:
 * a task going `in_progress` is simply NOT OBSERVABLE, so the mirror only ever
 * sees a task appear (`pending`) and finish (`completed`).
 */

import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * The only two statuses an observer can witness. `in_progress` and `deleted`
 * are deliberately absent — no event carries them, so representing them would
 * be inventing state the harness never reports.
 */
export const TaskStatus = Schema.Literals(['pending', 'completed'])
export type TaskStatus = typeof TaskStatus.Type

/**
 * One durable mirror row.
 *
 * Keyed by `(sessionId, id)`: `task_id` is only unique WITHIN a session, so a
 * bare id would collide across sessions and silently overwrite a stranger's
 * row. `backlogN` is the L2 roadmap link — the mirror OWNS it and the demote
 * step writes it back via `applyDemoteLinks`. It is never read out of a hook
 * payload: the verified TaskCreated/TaskCompleted payload has no `metadata`
 * field at all, so there is no cross-tier link channel coming from the harness.
 */
export const MirrorRow = Schema.Struct({
	sessionId: Schema.String,
	id: Schema.String,
	subject: Schema.String,
	description: Schema.String,
	status: TaskStatus,
	owner: Schema.optional(Schema.String),
	backlogN: Schema.optional(Schema.Finite),
	seenAt: Schema.String,
})
export type MirrorRow = typeof MirrorRow.Type

/** The persisted mirror file: a flat array of rows. */
export const MirrorRows = Schema.Array(MirrorRow)

/** Stored mirror JSON did not decode as `MirrorRows`. */
export class MirrorDecodeError extends Schema.TaggedError<MirrorDecodeError>()(
	'MirrorDecodeError',
	{ path: Schema.String, reason: Schema.String },
) {
	// Schema.TaggedError extends Error but does not populate `.message`.
	override get message(): string {
		return `${this.path}: ${this.reason}`
	}
}

/**
 * Fields shared by both task events — the schema is literally identical
 * between them, only `hook_event_name` differs.
 *
 * Only `hook_event_name`, `session_id` and `task_id` are required; everything
 * else is optional because it genuinely is in the payload. `task_subject` in
 * particular MUST stay optional: a TaskCompleted that omits it has to merge
 * over the existing row rather than blank it.
 *
 * Excess keys (`transcript_path`, `cwd`, `permission_mode`, `team_name`, …)
 * are dropped by Schema.Struct rather than rejected — verified against the
 * installed effect@4 decoder, not assumed.
 */
const taskFields = {
	session_id: Schema.String,
	task_id: Schema.String,
	task_subject: Schema.optional(Schema.String),
	task_description: Schema.optional(Schema.String),
	/** Names the subagent that created/completed the task; becomes row `owner`. */
	teammate_name: Schema.optional(Schema.String),
}

const TaskCreatedPayload = Schema.Struct({
	hook_event_name: Schema.Literal('TaskCreated'),
	...taskFields,
})

const TaskCompletedPayload = Schema.Struct({
	hook_event_name: Schema.Literal('TaskCompleted'),
	...taskFields,
})

/** Discriminated on `hook_event_name` — the only field that distinguishes them. */
export const HookPayload = Schema.Union([TaskCreatedPayload, TaskCompletedPayload])
export type HookPayload = typeof HookPayload.Type

/** A decoded task event, normalised out of the raw hook payload. */
export const TaskEvent = Schema.Struct({
	kind: Schema.Literals(['created', 'completed']),
	sessionId: Schema.String,
	id: Schema.String,
	at: Schema.String,
	subject: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
	owner: Schema.optional(Schema.String),
	status: TaskStatus,
})
export type TaskEvent = typeof TaskEvent.Type

const decodeHookPayload = Schema.decodeUnknownOption(HookPayload)
const decodeMirrorRowsOption = Schema.decodeUnknownOption(MirrorRows)

/**
 * Decode a hook payload into a TaskEvent. `Option.none()` for anything that is
 * not one of the two task events — including outright garbage. Degrading to
 * "no event" is safety-critical here and not merely polite: TaskCreated and
 * TaskCompleted fire SYNCHRONOUSLY and can BLOCK, so a handler that threw
 * would make Claude Code delete the user's task or refuse its completion.
 */
export function parseHookEvent(raw: unknown, at: string): Option.Option<TaskEvent> {
	return Option.map(decodeHookPayload(raw), payload => ({
		kind: payload.hook_event_name === 'TaskCreated' ? ('created' as const) : ('completed' as const),
		sessionId: payload.session_id,
		id: payload.task_id,
		at,
		subject: payload.task_subject,
		description: payload.task_description,
		owner: payload.teammate_name,
		status:
			payload.hook_event_name === 'TaskCreated' ? ('pending' as const) : ('completed' as const),
	}))
}

/** Decode stored mirror JSON, failing loudly rather than returning a half-row. */
export function decodeMirrorRows(
	raw: unknown,
	path: string,
): Effect.Effect<readonly MirrorRow[], MirrorDecodeError> {
	return Option.match(decodeMirrorRowsOption(raw), {
		onNone: () =>
			Effect.fail(
				new MirrorDecodeError({ path, reason: 'stored mirror is not an array of MirrorRow' }),
			),
		onSome: rows => Effect.succeed(rows),
	})
}

function sameRow(row: MirrorRow, sessionId: string, id: string): boolean {
	return row.id === id && row.sessionId === sessionId
}

/**
 * UPSERT a single event into the mirror by `(sessionId, id)`. Absent fields on
 * a TaskCompleted leave existing values alone — a naive spread-replace would
 * blank subject the moment a task completes with only ids in the payload.
 * `backlogN` is never touched here; it belongs to `applyDemoteLinks`.
 */
export function applyTaskEvent(rows: readonly MirrorRow[], event: TaskEvent): readonly MirrorRow[] {
	const idx = rows.findIndex(row => sameRow(row, event.sessionId, event.id))
	const existing = idx >= 0 ? rows[idx] : undefined

	const merged: MirrorRow = {
		sessionId: event.sessionId,
		id: event.id,
		subject: event.subject ?? existing?.subject ?? '',
		description: event.description ?? existing?.description ?? '',
		status: event.status,
		owner: event.owner ?? existing?.owner,
		backlogN: existing?.backlogN,
		seenAt: event.at,
	}

	if (idx >= 0) {
		const next = rows.slice()
		next[idx] = merged
		return next
	}
	return [...rows, merged]
}

/** Ordered reduce of applyTaskEvent over a batch of events. */
export function foldTaskEvents(
	rows: readonly MirrorRow[],
	events: readonly TaskEvent[],
): readonly MirrorRow[] {
	return events.reduce(applyTaskEvent, rows)
}

/**
 * The `(sessionId, id) -> n` link the demote step allocated. Lives here rather
 * than in demote.ts because demote.ts already imports this module — the link
 * is the mirror's own vocabulary, and demote re-exports it as `DemoteLink`.
 */
export const MirrorLink = Schema.Struct({
	sessionId: Schema.String,
	id: Schema.String,
	n: Schema.Finite,
})
export type MirrorLink = typeof MirrorLink.Type

/**
 * Write allocated L2 backlog numbers back into the mirror. This is the ONLY
 * writer of `backlogN`: since the hook payload has no metadata field, the
 * mirror is its own store of the L1<->L2 link, not a reader of one.
 * Links naming a row we never saw are ignored rather than creating a shell.
 */
export function applyDemoteLinks(
	rows: readonly MirrorRow[],
	links: readonly MirrorLink[],
): readonly MirrorRow[] {
	if (links.length === 0) return rows
	const next = rows.slice()
	for (const link of links) {
		const idx = next.findIndex(row => sameRow(row, link.sessionId, link.id))
		if (idx < 0) continue
		next[idx] = { ...next[idx], backlogN: link.n }
	}
	return next
}

/**
 * Agent-side insertion into the L1 mirror.
 * Idempotent on (sessionId,id): a duplicate returns the original array unchanged
 * and the caller is responsible for returning {created:false, reason:"duplicate"}
 * without writing. Non-duplicates are appended.
 */
export function insertAgentRow(
	rows: readonly MirrorRow[],
	newRow: MirrorRow,
): readonly MirrorRow[] {
	if (rows.some(row => sameRow(row, newRow.sessionId, newRow.id))) return rows
	return [...rows, newRow]
}
