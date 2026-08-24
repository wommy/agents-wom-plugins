import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HANDLER = new URL('../hooks-handlers/codex-plan-observer.ts', import.meta.url).pathname
const PLUGIN_ROOT = new URL('..', import.meta.url).pathname

test('Codex plan hook waits for the stdio MCP receipt', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tudo-codex-hook-'))
	const planLog = join(dir, 'codex-plan.jsonl')
	try {
		const proc = Bun.spawn(['bun', HANDLER], {
			stdin: Buffer.from(
				JSON.stringify({
					tool_name: 'update_plan',
					session_id: 'codex-hook-test',
					plan: [{ step: 'hook receipt', status: 'in_progress' }],
				}),
			),
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, PLUGIN_ROOT, TUDO_PLAN_LOG: planLog },
		})
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)
		expect(await Bun.file(planLog).text()).toContain('codex-hook-test')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}, 10_000)
