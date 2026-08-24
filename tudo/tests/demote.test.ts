import { describe, expect, it } from '@effect/bun-test'
import * as Effect from 'effect/Effect'

import { type BacklogEntry, nextBacklogN, planDemote } from '../lib/demote.ts'
import type { MirrorRow } from '../lib/mirror.ts'

const SESSION = 's-abc'

function row(overrides: Partial<MirrorRow> = {}): MirrorRow {
	return {
		sessionId: SESSION,
		id: 't1',
		subject: 'a subject',
		description: 'a description',
		status: 'pending',
		seenAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

function backlog(...ns: number[]): BacklogEntry[] {
	return ns.map(n => ({ n }))
}

describe('nextBacklogN', () => {
	it.effect('sparse backlog allocation skips gaps correctly', () =>
		Effect.sync(() => {
			expect(nextBacklogN(backlog(3, 94, 116))).toBe(117)
		}),
	)

	it.effect('empty backlog starts at 1', () =>
		Effect.sync(() => {
			expect(nextBacklogN([])).toBe(1)
		}),
	)

	it.effect('never derives from array length', () =>
		Effect.sync(() => {
			// length is 3 but max is 116: length + 1 would reissue 4, which other
			// files already point at.
			const entries = backlog(3, 94, 116)
			expect(nextBacklogN(entries)).not.toBe(entries.length + 1)
			expect(nextBacklogN(entries)).toBe(117)
		}),
	)
})

describe('planDemote', () => {
	it.effect('batch of 3 rows allocates sequential n in one pass', () =>
		Effect.sync(() => {
			const plan = planDemote(
				[row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })],
				backlog(3, 94, 116),
			)
			expect(plan.rows.map(r => r.n)).toEqual([117, 118, 119])
			expect(plan.links).toEqual([
				{ sessionId: SESSION, id: 'a', n: 117 },
				{ sessionId: SESSION, id: 'b', n: 118 },
				{ sessionId: SESSION, id: 'c', n: 119 },
			])
			expect(plan.skipped).toEqual([])
		}),
	)

	it.effect('completed rows are skipped with reason completed', () =>
		Effect.sync(() => {
			const plan = planDemote([row({ status: 'completed' })], [])
			expect(plan.rows).toEqual([])
			expect(plan.skipped).toEqual([{ sessionId: SESSION, id: 't1', reason: 'completed' }])
		}),
	)

	it.effect('not-completed is the only liveness signal there is', () =>
		Effect.sync(() => {
			// No TaskUpdated/in_progress event exists, so a pending row is the whole
			// definition of unfinished — it must always be eligible.
			const plan = planDemote([row({ status: 'pending' })], [])
			expect(plan.rows).toHaveLength(1)
		}),
	)

	it.effect('already-linked rows (backlogN set) are skipped, nowhere to go', () =>
		Effect.sync(() => {
			const plan = planDemote([row({ backlogN: 42 })], [])
			expect(plan.rows).toEqual([])
			expect(plan.skipped).toEqual([{ sessionId: SESSION, id: 't1', reason: 'already-linked' }])
		}),
	)

	it.effect('empty subject+description rows are skipped with reason empty', () =>
		Effect.sync(() => {
			const plan = planDemote([row({ subject: '  ', description: '' })], [])
			expect(plan.rows).toEqual([])
			expect(plan.skipped).toEqual([{ sessionId: SESSION, id: 't1', reason: 'empty' }])
		}),
	)

	it.effect("item joins trimmed subject and description with ' -- '", () =>
		Effect.sync(() => {
			const plan = planDemote([row({ subject: '  subj  ', description: ' desc ' })], [])
			expect(plan.rows[0].item).toBe('subj -- desc')
		}),
	)

	it.effect('item drops an empty part instead of leaving a dangling separator', () =>
		Effect.sync(() => {
			const plan = planDemote([row({ description: '' })], [])
			expect(plan.rows[0].item).toBe('a subject')
		}),
	)

	it.effect(
		'mixed batch: completed + already-linked + empty + eligible, each with its reason',
		() =>
			Effect.sync(() => {
				const plan = planDemote(
					[
						row({ id: 'done', status: 'completed' }),
						row({ id: 'linked', backlogN: 7 }),
						row({ id: 'blank', subject: '', description: '' }),
						row({ id: 'live' }),
					],
					backlog(116),
				)
				expect(plan.rows).toEqual([{ n: 117, item: 'a subject -- a description' }])
				expect(plan.links).toEqual([{ sessionId: SESSION, id: 'live', n: 117 }])
				expect(plan.skipped.map(s => `${s.id}:${s.reason}`)).toEqual([
					'done:completed',
					'linked:already-linked',
					'blank:empty',
				])
			}),
	)

	it.effect('rows with the same task_id in different sessions each get their own n', () =>
		Effect.sync(() => {
			const plan = planDemote([row(), row({ sessionId: 's-other' })], backlog(10))
			expect(plan.links).toEqual([
				{ sessionId: SESSION, id: 't1', n: 11 },
				{ sessionId: 's-other', id: 't1', n: 12 },
			])
		}),
	)
})
