import { describe, expect, it } from '@effect/bun-test'

import { planPromote } from '../lib/demote.ts'
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

describe('planPromote', () => {
	it('returns unfinished rows the task list does not have', () => {
		const mirror = [row({ id: '1' }), row({ id: '2' })]
		expect(planPromote(mirror, new Set(['1'])).map(r => r.id)).toEqual(['2'])
	})

	it('never returns a row the task list already has', () => {
		const mirror = [row({ id: '1' }), row({ id: '2' })]
		expect(planPromote(mirror, new Set(['1', '2']))).toEqual([])
	})

	it('skips completed rows — they are not unfinished work', () => {
		const mirror = [row({ id: '1', status: 'completed' }), row({ id: '2' })]
		expect(planPromote(mirror, new Set()).map(r => r.id)).toEqual(['2'])
	})

	/**
	 * The wipe guard. An empty mirror is an ordinary state — a cleared
	 * XDG_STATE_HOME, a fresh machine, a resumed session whose hooks never
	 * wired. If absence from the mirror could ever imply "remove from L1",
	 * every one of those days would silently destroy the task list.
	 */
	it('an empty mirror asks for nothing, however full the task list is', () => {
		expect(planPromote([], new Set(['1', '2', '3', '4', '5']))).toEqual([])
	})

	/**
	 * Rows present in L1 but unknown to the mirror are LEFT ALONE. This is the
	 * inverse the signature refuses to express: the result is rows to add, so
	 * there is no way for a caller to read a deletion out of it.
	 */
	it('reports nothing about task-list ids the mirror has never seen', () => {
		const mirror = [row({ id: '1' })]
		const result = planPromote(mirror, new Set(['1', '99', '100']))
		expect(result).toEqual([])
		expect(result.some(r => r.id === '99' || r.id === '100')).toBe(false)
	})

	it('carries the backlog link forward so a promoted task keeps its L2 identity', () => {
		const mirror = [row({ id: '1', backlogN: 122 })]
		expect(planPromote(mirror, new Set())[0]?.backlogN).toBe(122)
	})
})
