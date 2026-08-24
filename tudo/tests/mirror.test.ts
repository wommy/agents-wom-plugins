import { describe, expect, it } from '@effect/bun-test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'

import {
	applyDemoteLinks,
	applyTaskEvent,
	decodeMirrorRows,
	foldTaskEvents,
	type MirrorRow,
	parseHookEvent,
	type TaskEvent,
} from '../lib/mirror.ts'

const SESSION = 's-abc'

/** The envelope fields every real payload carries and the mirror ignores. */
const envelope = {
	transcript_path: '/tmp/transcript.jsonl',
	cwd: '/home/wom/infra/womr',
	permission_mode: 'default',
}

function created(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...envelope,
		hook_event_name: 'TaskCreated',
		session_id: SESSION,
		task_id: 't1',
		task_subject: 'original subject',
		task_description: 'original description',
		...overrides,
	}
}

function completed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...envelope,
		hook_event_name: 'TaskCompleted',
		session_id: SESSION,
		task_id: 't1',
		...overrides,
	}
}

function row(overrides: Partial<MirrorRow> = {}): MirrorRow {
	return {
		sessionId: SESSION,
		id: 't1',
		subject: 'original subject',
		description: 'original description',
		status: 'pending',
		seenAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

function event(overrides: Partial<TaskEvent> = {}): TaskEvent {
	return {
		kind: 'created',
		sessionId: SESSION,
		id: 't1',
		at: 'now',
		status: 'pending',
		...overrides,
	}
}

describe('parseHookEvent', () => {
	it.effect('decodes a TaskCreated to a pending event', () =>
		Effect.sync(() => {
			const decoded = parseHookEvent(created(), 'now')
			expect(Option.isSome(decoded)).toBe(true)
			expect(Option.getOrThrow(decoded)).toEqual({
				kind: 'created',
				sessionId: SESSION,
				id: 't1',
				at: 'now',
				subject: 'original subject',
				description: 'original description',
				owner: undefined,
				status: 'pending',
			})
		}),
	)

	it.effect('decodes a TaskCompleted to a completed event', () =>
		Effect.sync(() => {
			const decoded = Option.getOrThrow(parseHookEvent(completed(), 'now'))
			expect(decoded.kind).toBe('completed')
			expect(decoded.status).toBe('completed')
			expect(decoded.subject).toBeUndefined()
		}),
	)

	it.effect('carries teammate_name onto the event as owner', () =>
		Effect.sync(() => {
			const decoded = Option.getOrThrow(parseHookEvent(created({ teammate_name: 'scout' }), 'now'))
			expect(decoded.owner).toBe('scout')
		}),
	)

	it.effect('ignores the uninvited envelope fields rather than rejecting them', () =>
		Effect.sync(() => {
			const decoded = Option.getOrThrow(parseHookEvent(created({ team_name: 'legacy' }), 'now'))
			expect(decoded.id).toBe('t1')
			expect(decoded).not.toHaveProperty('cwd')
		}),
	)

	it.effect('yields none for a PostToolUse-shaped payload (the dead event)', () =>
		Effect.sync(() => {
			const decoded = parseHookEvent(
				{ hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'x' } },
				'now',
			)
			expect(Option.isNone(decoded)).toBe(true)
		}),
	)

	it.effect('yields none for unknown/garbage payloads rather than throwing', () =>
		Effect.sync(() => {
			for (const garbage of [null, undefined, 42, 'string', [], {}, { hook_event_name: 'Nope' }]) {
				expect(Option.isNone(parseHookEvent(garbage, 'now'))).toBe(true)
			}
		}),
	)

	it.effect('yields none when session_id is missing — a task_id alone is not identity', () =>
		Effect.sync(() => {
			const raw = created()
			delete raw.session_id
			expect(Option.isNone(parseHookEvent(raw, 'now'))).toBe(true)
		}),
	)

	it.effect('yields none when task_id is missing', () =>
		Effect.sync(() => {
			const raw = created()
			delete raw.task_id
			expect(Option.isNone(parseHookEvent(raw, 'now'))).toBe(true)
		}),
	)
})

describe('applyTaskEvent', () => {
	it.effect('TaskCompleted after TaskCreated updates status without blanking subject', () =>
		Effect.sync(() => {
			const start = [row()]
			const done = Option.getOrThrow(parseHookEvent(completed(), 'later'))
			const next = applyTaskEvent(start, done)

			expect(next).toHaveLength(1)
			expect(next[0].status).toBe('completed')
			expect(next[0].subject).toBe('original subject')
			expect(next[0].description).toBe('original description')
			expect(next[0].seenAt).toBe('later')
		}),
	)

	it.effect('create inserts a new row', () =>
		Effect.sync(() => {
			const next = applyTaskEvent([], event({ subject: 'fresh', description: 'body' }))
			expect(next).toHaveLength(1)
			expect(next[0]).toEqual({
				sessionId: SESSION,
				id: 't1',
				subject: 'fresh',
				description: 'body',
				status: 'pending',
				owner: undefined,
				backlogN: undefined,
				seenAt: 'now',
			})
		}),
	)

	it.effect('a completion for an unseen id creates a shell row (missed create event)', () =>
		Effect.sync(() => {
			const next = applyTaskEvent([], event({ kind: 'completed', status: 'completed' }))
			expect(next).toHaveLength(1)
			expect(next[0].status).toBe('completed')
			expect(next[0].subject).toBe('')
		}),
	)

	it.effect('the same task_id in a different session is a DIFFERENT row', () =>
		Effect.sync(() => {
			const next = applyTaskEvent([row()], event({ sessionId: 's-other', subject: 'other' }))
			expect(next).toHaveLength(2)
			expect(next[1].sessionId).toBe('s-other')
			expect(next[0].subject).toBe('original subject')
		}),
	)

	it.effect('an event never clears an existing backlogN — only the demote step owns it', () =>
		Effect.sync(() => {
			const next = applyTaskEvent(
				[row({ backlogN: 117 })],
				event({ kind: 'completed', status: 'completed' }),
			)
			expect(next[0].backlogN).toBe(117)
		}),
	)

	it.effect('owner survives a later event that omits teammate_name', () =>
		Effect.sync(() => {
			const next = applyTaskEvent(
				[row({ owner: 'scout' })],
				event({ kind: 'completed', status: 'completed' }),
			)
			expect(next[0].owner).toBe('scout')
		}),
	)
})

describe('foldTaskEvents', () => {
	it.effect('ordered reduce applies events in sequence', () =>
		Effect.sync(() => {
			const rows = foldTaskEvents(
				[],
				[
					event({ id: 'a', subject: 'first' }),
					event({ id: 'b', subject: 'second' }),
					event({ id: 'a', kind: 'completed', status: 'completed' }),
				],
			)
			expect(rows).toHaveLength(2)
			expect(rows[0]).toMatchObject({ id: 'a', subject: 'first', status: 'completed' })
			expect(rows[1]).toMatchObject({ id: 'b', subject: 'second', status: 'pending' })
		}),
	)
})

describe('applyDemoteLinks', () => {
	it.effect('writes the allocated n back onto the matching row', () =>
		Effect.sync(() => {
			const next = applyDemoteLinks(
				[row(), row({ id: 't2' })],
				[{ sessionId: SESSION, id: 't2', n: 118 }],
			)
			expect(next[0].backlogN).toBeUndefined()
			expect(next[1].backlogN).toBe(118)
		}),
	)

	it.effect('ignores a link for a row from another session', () =>
		Effect.sync(() => {
			const next = applyDemoteLinks([row()], [{ sessionId: 's-other', id: 't1', n: 5 }])
			expect(next[0].backlogN).toBeUndefined()
		}),
	)
})

describe('decodeMirrorRows', () => {
	it.effect('decodes a well-formed stored mirror', () =>
		Effect.gen(function* () {
			const rows = yield* decodeMirrorRows([row()], '/tmp/mirror.json')
			expect(rows).toHaveLength(1)
			expect(rows[0].id).toBe('t1')
		}),
	)

	it.effect('fails with MirrorDecodeError on a non-array', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(decodeMirrorRows({ nope: true }, '/tmp/mirror.json'))
			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	it.effect('fails on a row missing required fields rather than half-decoding', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(decodeMirrorRows([{ id: 't1' }], '/tmp/mirror.json'))
			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)
})
