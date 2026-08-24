/**
 * Handler-level proof. TaskCreated/TaskCompleted fire synchronously and can
 * BLOCK: a non-zero exit makes Claude Code delete the task or refuse the
 * completion. So "exit 0 on every path" is a data-safety assertion, and it can
 * only be proven by running the real process.
 */
import { afterEach, describe, expect, it } from '@effect/bun-test'
import * as Effect from 'effect/Effect'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MirrorRow } from '../lib/mirror.ts'

const HANDLER = join(import.meta.dir, '..', 'hooks-handlers', 'task-mirror.ts')

const scratchDirs: string[] = []

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'tudo-test-'))
	scratchDirs.push(dir)
	return dir
}

interface RunResult {
	readonly exitCode: number
	readonly mirror: readonly MirrorRow[] | undefined
}

/** Run the real handler with `stdin` piped in and TUDO_MIRROR pinned to a scratch file. */
function runHandler(stdin: string, mirrorFile: string): Effect.Effect<RunResult> {
	return Effect.promise(async () => {
		const proc = Bun.spawn(['bun', HANDLER], {
			stdin: Buffer.from(stdin),
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, TUDO_MIRROR: mirrorFile },
		})
		const exitCode = await proc.exited
		let mirror: readonly MirrorRow[] | undefined
		try {
			mirror = JSON.parse(readFileSync(mirrorFile, 'utf8')) as readonly MirrorRow[]
		} catch {
			mirror = undefined
		}
		return { exitCode, mirror }
	})
}

const createdPayload = JSON.stringify({
	session_id: 's-abc',
	transcript_path: '/tmp/t.jsonl',
	cwd: '/tmp',
	permission_mode: 'default',
	hook_event_name: 'TaskCreated',
	task_id: 't1',
	task_subject: 'ship the thing',
	task_description: 'all of it',
	teammate_name: 'scout',
})

const completedPayload = JSON.stringify({
	session_id: 's-abc',
	transcript_path: '/tmp/t.jsonl',
	cwd: '/tmp',
	permission_mode: 'default',
	hook_event_name: 'TaskCompleted',
	task_id: 't1',
})

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('task-mirror handler', () => {
	it.effect(
		'a valid TaskCreated writes the row (positive control for the exit-0 assertions)',
		() =>
			Effect.gen(function* () {
				const file = join(scratch(), 'mirror.json')
				const result = yield* runHandler(createdPayload, file)
				expect(result.exitCode).toBe(0)
				expect(result.mirror).toHaveLength(1)
				expect(result.mirror?.[0]).toMatchObject({
					sessionId: 's-abc',
					id: 't1',
					subject: 'ship the thing',
					status: 'pending',
					owner: 'scout',
				})
			}),
		20_000,
	)

	it.effect(
		'a malformed payload exits 0 and writes nothing — a crash would delete the task',
		() =>
			Effect.gen(function* () {
				const file = join(scratch(), 'mirror.json')
				const result = yield* runHandler('{not json at all', file)
				expect(result.exitCode).toBe(0)
				expect(result.mirror).toBeUndefined()
			}),
		20_000,
	)

	it.effect(
		'an unknown hook event exits 0 and writes nothing',
		() =>
			Effect.gen(function* () {
				const file = join(scratch(), 'mirror.json')
				const result = yield* runHandler(
					JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'TaskCreate' }),
					file,
				)
				expect(result.exitCode).toBe(0)
				expect(result.mirror).toBeUndefined()
			}),
		20_000,
	)

	it.effect(
		'empty stdin exits 0',
		() =>
			Effect.gen(function* () {
				const file = join(scratch(), 'mirror.json')
				const result = yield* runHandler('', file)
				expect(result.exitCode).toBe(0)
				expect(result.mirror).toBeUndefined()
			}),
		20_000,
	)

	it.effect(
		'a CORRUPT existing mirror still records the event — recovery is real, not a comment',
		() =>
			Effect.gen(function* () {
				const file = join(scratch(), 'mirror.json')
				writeFileSync(file, '{invalid json')
				const result = yield* runHandler(createdPayload, file)
				expect(result.exitCode).toBe(0)
				expect(result.mirror).toHaveLength(1)
				expect(result.mirror?.[0]).toMatchObject({ id: 't1', status: 'pending' })
			}),
		20_000,
	)

	it.effect(
		'TaskCompleted after TaskCreated updates status through the real file, keeping subject',
		() =>
			Effect.gen(function* () {
				const file = join(scratch(), 'mirror.json')
				yield* runHandler(createdPayload, file)
				const result = yield* runHandler(completedPayload, file)
				expect(result.exitCode).toBe(0)
				expect(result.mirror).toHaveLength(1)
				expect(result.mirror?.[0]).toMatchObject({
					id: 't1',
					status: 'completed',
					subject: 'ship the thing',
				})
			}),
		30_000,
	)
})
