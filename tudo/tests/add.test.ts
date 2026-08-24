import { describe, expect, it } from '@effect/bun-test'
import * as Effect from 'effect/Effect'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { insertAgentRow, type MirrorRow } from '../lib/mirror.ts'
import * as act from '../lib/act.ts'

function row(overrides: Partial<MirrorRow> = {}): MirrorRow {
	return {
		sessionId: 'agent',
		id: 't1',
		subject: 'a subject',
		description: '',
		status: 'pending',
		owner: 'agent',
		seenAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

describe('insertAgentRow', () => {
	it.effect('inserts a new agent row', () =>
		Effect.sync(() => {
			const next = insertAgentRow([], row({ id: 'a', subject: 'hello' }))
			expect(next).toHaveLength(1)
			expect(next[0].id).toBe('a')
			expect(next[0].subject).toBe('hello')
			expect(next[0].status).toBe('pending')
			expect(next[0].owner).toBe('agent')
		}),
	)

	it.effect('duplicate (sessionId,id) is idempotent — returns same rows', () =>
		Effect.sync(() => {
			const start = [row({ sessionId: 'agent', id: 'dup', subject: 'first' })]
			const next = insertAgentRow(start, row({ sessionId: 'agent', id: 'dup', subject: 'second' }))
			expect(next).toHaveLength(1)
			expect(next[0].subject).toBe('first')
		}),
	)

	it.effect('same id in different session is a different row', () =>
		Effect.sync(() => {
			const start = [row({ sessionId: 'agent', id: 'x', subject: 'first' })]
			const next = insertAgentRow(start, row({ sessionId: 'other', id: 'x', subject: 'other' }))
			expect(next).toHaveLength(2)
		}),
	)
})

// Serialize all act.add integration checks in one effect to avoid concurrent
// process.env.TUDO_MIRROR races (bun:test runs it.effect concurrently).
describe('tudo_add via act.add', () => {
	it.effect('happy path, duplicate guard, empty-subject guard, sessionId and backlogN', () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), 'tudo-add-serial-'))
			const mirror = join(dir, 'mirror.json')
			const before = process.env.TUDO_MIRROR
			process.env.TUDO_MIRROR = mirror
			try {
				// happy path
				const r1 = (yield* Effect.promise(() => act.add({ id: 'add-1', subject: 'hello add' }))) as Record<string, unknown>
				expect(r1.created).toBe(true)
				expect((r1 as { path: string }).path).toBe(mirror)
				let status = (yield* Effect.promise(() => act.status())) as { rows: readonly MirrorRow[] }
				expect(status.rows).toHaveLength(1)
				expect(status.rows[0].id).toBe('add-1')
				expect(status.rows[0].subject).toBe('hello add')
				expect(status.rows[0].status).toBe('pending')
				expect(status.rows[0].owner).toBe('agent')
				expect(status.rows[0].sessionId).toBe('agent')

				// duplicate guard
				yield* Effect.promise(() => act.add({ id: 'dup-1', subject: 'first' }))
				const dup2 = (yield* Effect.promise(() => act.add({ id: 'dup-1', subject: 'second' }))) as Record<string, unknown>
				expect(dup2).toEqual({ created: false, reason: 'duplicate' })
				status = (yield* Effect.promise(() => act.status())) as { rows: readonly MirrorRow[] }
				expect(status.rows.filter(r => r.id === 'dup-1')).toHaveLength(1)
				expect(status.rows.find(r => r.id === 'dup-1')!.subject).toBe('first')

				// empty-subject guard
				const empty = (yield* Effect.promise(() => act.add({ id: 'empty-1', subject: '   ' }))) as Record<string, unknown>
				expect(empty).toEqual({ created: false, reason: 'empty' })
				status = (yield* Effect.promise(() => act.status())) as { rows: readonly MirrorRow[] }
				expect(status.rows.find(r => r.id === 'empty-1')).toBeUndefined()

				// sessionId override and scoping
				const s1 = (yield* Effect.promise(() => act.add({ id: 's-1', subject: 'hello', sessionId: 'custom' }))) as Record<string, unknown>
				expect(s1.created).toBe(true)
				const s2 = (yield* Effect.promise(() => act.add({ id: 's-1', subject: 'hello2', sessionId: 'custom' }))) as Record<string, unknown>
				expect(s2).toEqual({ created: false, reason: 'duplicate' })
				const s3 = (yield* Effect.promise(() => act.add({ id: 's-1', subject: 'hello3', sessionId: 'other' }))) as Record<string, unknown>
				expect(s3.created).toBe(true)
				status = (yield* Effect.promise(() => act.status())) as { rows: readonly MirrorRow[] }
				expect(status.rows.filter(r => r.id === 's-1')).toHaveLength(2)

				// backlogN is stored when provided
				const b1 = (yield* Effect.promise(() => act.add({ id: 'b-1', subject: 'with backlog', backlogN: 42 }))) as Record<string, unknown>
				expect(b1.created).toBe(true)
				status = (yield* Effect.promise(() => act.status())) as { rows: readonly MirrorRow[] }
				expect(status.rows.find(r => r.id === 'b-1')!.backlogN).toBe(42)
			} finally {
				if (before === undefined) delete process.env.TUDO_MIRROR
				else process.env.TUDO_MIRROR = before
				rmSync(dir, { recursive: true, force: true })
			}
		}),
	)
})
