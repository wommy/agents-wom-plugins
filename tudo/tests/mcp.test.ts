import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const server = new URL('../mcp/server.ts', import.meta.url).pathname
const repo = new URL('../../..', import.meta.url).pathname
const scratchDirs: string[] = []

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('tudo MCP exposes its L1 mirror and L1↔L2 action surface', async () => {
	const input =
		[
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'server/discover',
				params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
			}),
			JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
			}),
		].join('\n') + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const output = await new Response(proc.stdout).text()
	await proc.exited
	for (const tool of ['observe_l1_event', 'tudo_status', 'tudo_promote', 'tudo_link', 'tudo_demote', 'tudo_add'])
		expect(output).toContain(tool)
	expect(output).toContain('tudo')
	expect(output).toContain('"version":"0.1.3"')
	expect(output).toContain('2026-07-28')
})

test('MCP negotiation retains modern and Claude-supported protocol revisions', async () => {
	const input =
		JSON.stringify({
			jsonrpc: '2.0',
			id: 'legacy-client',
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'conformance-test', version: '1' },
			},
		}) + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const response = JSON.parse((await new Response(proc.stdout).text()).trim()) as {
		result?: { protocolVersion?: string }
	}
	await proc.exited
	expect(response.result?.protocolVersion).toBe('2025-11-25')
})

test('MCP negotiation rejects an unsupported protocol with a bounded diagnostic', async () => {
	const input =
		JSON.stringify({
			jsonrpc: '2.0',
			id: 'unsupported',
			method: 'server/discover',
			params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } },
		}) + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const response = JSON.parse((await new Response(proc.stdout).text()).trim()) as {
		error?: { code?: number; message?: string; data?: { requested?: string; supported?: string[] } }
	}
	await proc.exited
	expect(response.error).toEqual({
		code: -32022,
		message: 'Unsupported protocol version.',
		data: {
			requested: '1999-01-01',
			supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'],
		},
	})
})

test('stdio notifications stay one-way and unknown requests use JSON-RPC errors', async () => {
	const input =
		[
			JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }),
			JSON.stringify({ jsonrpc: '2.0', id: 'missing', method: 'no/such-method' }),
		].join('\n') + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const lines = (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean)
	await proc.exited
	expect(lines).toHaveLength(1)
	expect(JSON.parse(lines[0]!).error).toEqual({ code: -32601, message: 'Method not found' })
})

test('2026-07-28 tool results declare a complete result', async () => {
	const input =
		JSON.stringify({
			jsonrpc: '2.0',
			id: 'status',
			method: 'tools/call',
			params: { name: 'tudo_status', arguments: {} },
		}) + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const line = (await new Response(proc.stdout).text()).trim()
	await proc.exited
	const response = JSON.parse(line) as { result?: { resultType?: string } }
	expect(response.result?.resultType).toBe('complete')
})

test('observer and action tools share the plugin-data mirror path', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tudo-mcp-path-'))
	scratchDirs.push(dir)
	const mirror = join(dir, 'mirror.json')
	const input =
		[
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'observe_l1_event',
					arguments: {
						client: 'claude',
						event: {
							hook_event_name: 'TaskCreated',
							session_id: 'path-test',
							task_id: 'same-path',
							task_subject: 'path parity',
							task_description: 'observer and action read one mirror',
						},
					},
				},
			}),
			JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'tudo_status', arguments: {} },
			}),
		].join('\n') + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, TUDO_MIRROR: mirror },
	})
	const lines = (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean)
	await proc.exited
	expect(lines).toHaveLength(2)
	const status = JSON.parse(lines[1]) as { result?: { structuredContent?: { rows?: unknown[] } } }
	expect(status.result?.structuredContent?.rows).toHaveLength(1)
})

test('stdio server honors the client-owned PLUGIN_DATA fallback', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tudo-plugin-data-'))
	scratchDirs.push(dir)
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !['TUDO_MIRROR', 'XDG_STATE_HOME', 'HOME'].includes(key)),
	)
	const input =
		[
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'observe_l1_event',
					arguments: {
						client: 'claude',
						event: {
							hook_event_name: 'TaskCreated',
							session_id: 'plugin-data-test',
							task_id: 'plugin-data-row',
							task_subject: 'PLUGIN_DATA fallback',
							task_description: 'client-owned state boundary',
						},
					},
				},
			}),
			JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'tudo_status', arguments: {} },
			}),
		].join('\n') + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...env, PLUGIN_DATA: dir },
	})
	const lines = (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean)
	await proc.exited
	const status = JSON.parse(lines[1]!) as { result?: { structuredContent?: { rows?: unknown[] } } }
	expect(status.result?.structuredContent?.rows).toHaveLength(1)
	expect(await Bun.file(join(dir, 'mirror.json')).exists()).toBe(true)
})

test('tudo_link rejects nonexistent backlog identities before writing', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tudo-link-validation-'))
	scratchDirs.push(dir)
	const input =
		[
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'observe_l1_event',
					arguments: {
						client: 'claude',
						event: {
							hook_event_name: 'TaskCreated',
							session_id: 'link-validation-test',
							task_id: 'link-validation-row',
							task_subject: 'link validation',
							task_description: 'invalid n must not become durable state',
						},
					},
				},
			}),
			JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'tudo_link', arguments: { id: 'link-validation-row', n: 999999, repo } },
			}),
			JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'tudo_status', arguments: {} },
			}),
			JSON.stringify({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'tudo_link', arguments: { id: 'link-validation-row', n: 93, repo } },
			}),
			JSON.stringify({
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: { name: 'tudo_status', arguments: {} },
			}),
		].join('\n') + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, TUDO_MIRROR: join(dir, 'mirror.json'), TUDO_REPO: repo },
	})
	const lines = (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean)
	await proc.exited
	const invalid = JSON.parse(lines[1]!) as {
		result?: { structuredContent?: { linked?: boolean; id?: string; n?: number; reason?: string } }
	}
	const afterInvalid = JSON.parse(lines[2]!) as { result?: { structuredContent?: { rows?: Array<{ backlogN?: number }> } } }
	const valid = JSON.parse(lines[3]!) as { result?: { structuredContent?: { linked?: boolean } } }
	const afterValid = JSON.parse(lines[4]!) as { result?: { structuredContent?: { rows?: Array<{ backlogN?: number }> } } }
	expect(invalid.result?.structuredContent).toEqual({
		linked: false,
		id: 'link-validation-row',
		n: 999999,
		reason: `no backlog row n=999999 in ${repo}/data/womr-roadmap.roadmap.toon`,
	})
	expect(afterInvalid.result?.structuredContent?.rows?.[0]?.backlogN).toBeUndefined()
	expect(valid.result?.structuredContent?.linked).toBe(true)
	expect(afterValid.result?.structuredContent?.rows?.[0]?.backlogN).toBe(93)
})

test('tudo_link rejects a second mirror row claiming the same backlog identity', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tudo-link-uniqueness-'))
	scratchDirs.push(dir)
	const event = (id: string) => ({
		client: 'claude',
		event: {
			hook_event_name: 'TaskCreated',
			session_id: 'link-uniqueness-test',
			task_id: id,
			task_subject: `row ${id}`,
			task_description: 'one canonical L2 identity',
		},
	})
	const call = (id: number, name: string, args: Record<string, unknown>) =>
		JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
	const input =
		[
			call(1, 'observe_l1_event', event('duplicate-link-a')),
			call(2, 'observe_l1_event', event('duplicate-link-b')),
			call(3, 'tudo_link', { id: 'duplicate-link-a', n: 93, repo }),
			call(4, 'tudo_link', { id: 'duplicate-link-b', n: 93, repo }),
			call(5, 'tudo_status', {}),
		].join('\n') + '\n'
	const proc = Bun.spawn(['bun', server], {
		stdin: Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, TUDO_MIRROR: join(dir, 'mirror.json'), TUDO_REPO: repo },
	})
	const lines = (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean)
	await proc.exited
	const first = JSON.parse(lines[2]!) as { result?: { structuredContent?: { linked?: boolean } } }
	const second = JSON.parse(lines[3]!) as {
		result?: { structuredContent?: { linked?: boolean; id?: string; n?: number; reason?: string } }
	}
	const status = JSON.parse(lines[4]!) as {
		result?: { structuredContent?: { rows?: Array<{ id?: string; backlogN?: number }> } }
	}
	expect(first.result?.structuredContent?.linked).toBe(true)
	expect(second.result?.structuredContent).toEqual({
		linked: false,
		id: 'duplicate-link-b',
		n: 93,
		reason: 'backlog n=93 already linked to mirror row link-uniqueness-test/duplicate-link-a',
	})
	expect(status.result?.structuredContent?.rows?.map(({ id, backlogN }) => ({ id, backlogN }))).toEqual([
		{ id: 'duplicate-link-a', backlogN: 93 },
		{ id: 'duplicate-link-b', backlogN: undefined },
	])
})

describe('portable MCP shape', () => {
	test('root mcp.json is the closed Agent Plugins MCP document', async () => {
		const config = (await Bun.file(new URL('../mcp.json', import.meta.url)).json()) as Record<
			string,
			unknown
		>
		expect(Object.keys(config).sort()).toEqual(['$schema', 'mcpServers'])
		expect((config.mcpServers as Record<string, unknown>).tudo).toBeDefined()
	})
})
