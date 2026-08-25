#!/usr/bin/env bun

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import * as Effect from 'effect/Effect'
import { encode } from '@womr/toon'
import * as act from '../lib/act.ts'
import { mirrorPath } from '../lib/paths.ts'
import type { MirrorRow } from '../lib/mirror.ts'

type RequestId = string | number
type Rpc = { id?: RequestId; method?: string; params?: Record<string, unknown> }

const SERVER_VERSION = '0.1.3'
const SUPPORTED_PROTOCOL_VERSIONS = [
	'2026-07-28',
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
	'2024-10-07',
] as const

const statePath = await Effect.runPromise(mirrorPath)
const planLog = process.env.TUDO_PLAN_LOG ?? `${dirname(statePath)}/codex-plan.jsonl`

const toolDefinitions = [
	{ name: 'observe_l1_event', description: 'Observe L1 lifecycle when hooks are cold (resumed session misses TaskCreated/update_plan). Args: client "claude"|"codex", event=hook payload. Use when mirror behind plan. Non-blocking; gotcha: does not create L2/L3 receipt — you still must demote/promote explicitly.', inputSchema: { type: 'object', required: ['client', 'event'], properties: { client: { type: 'string', enum: ['claude', 'codex'] }, event: { type: 'object' } } } },
	{ name: 'tudo_status', description: 'Read durable L1 mirror projection (path + rows). No args. Purpose: prove unfinished work survived session end. Gotcha: empty rows ≠ done — mirror only knows what hooks/agents told it; check mirrorRows count before claiming done.', inputSchema: { type: 'object', properties: {} } },
	{ name: 'tudo_promote', description: 'Report unfinished mirror rows absent from your L1 plan (additive mirror→L1). Args: have string[] = ids already in plan (omit/empty at fresh session). Purpose: repopulate L1 after cold start. Gotcha: never creates or deletes tasks — you must call harness task-create; no removal channel.', inputSchema: { type: 'object', properties: { have: { type: 'array', items: { type: 'string' } } } } },
	{ name: 'tudo_link', description: 'Link existing L1 mirror row to existing L2 backlog identity. Args: id (mirror row), n (backlog row), repo (womr checkout), roadmap? (default womr-roadmap.roadmap.toon). Purpose: deduplicate without double-writing. Gotcha: validates n exists in data/<roadmap> and rejects duplicate ownership; same-row (id,n) is idempotent.', inputSchema: { type: 'object', required: ['id', 'n', 'repo'], properties: { id: { type: 'string' }, n: { type: 'integer' }, repo: { type: 'string' }, roadmap: { type: 'string' } } } },
	{ name: 'tudo_demote', description: 'Plan L1→L2 demotion by default; only writes with apply:true. Args: repo, roadmap?, apply boolean (default false). Purpose: durable L2 frontier. Gotcha: plans without writing unless apply:true; apply appends via host toon rail then links mirror atomically. L3 Kanban untouched.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, roadmap: { type: 'string' }, apply: { type: 'boolean', default: false } } } },
	{ name: 'tudo_add', description: 'Agent-side insert into L1 mirror when hooks cold or bootstrapping. Args: id, subject (required, non-empty), description?, backlogN?, sessionId? (default "agent"). Purpose: keep L1 visible without harness event. Gotcha: idempotent on (sessionId,id); rejects empty subject without write.', inputSchema: { type: 'object', required: ['id', 'subject'], properties: { id: { type: 'string' }, subject: { type: 'string' }, description: { type: 'string' }, backlogN: { type: 'integer', minimum: 1 }, sessionId: { type: 'string' } } } },
] as const

const reply = (id: RequestId, result: unknown) =>
	JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), result })

const error = (id: RequestId | undefined, code: number, message: string) =>
	JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), error: { code, message } })

const requestedProtocolVersion = (params: Record<string, unknown> | undefined): string | undefined => {
	if (typeof params?.protocolVersion === 'string') return params.protocolVersion
	const meta = params?._meta
	if (typeof meta !== 'object' || meta === null) return undefined
	const version = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']
	return typeof version === 'string' ? version : undefined
}

const unsupportedProtocol = (id: RequestId | undefined, requested: string) =>
	JSON.stringify({
		jsonrpc: '2.0',
		...(id === undefined ? {} : { id }),
		error: {
			code: -32022,
			message: 'Unsupported protocol version.',
			data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested },
		},
	})

async function observe(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const client = args.client
	const event = args.event
	if (client === 'claude') {
		const { applyTaskEvent, parseHookEvent } = await import('../lib/mirror.ts')
		const parsed = parseHookEvent(event, new Date().toISOString())
		if (parsed._tag === 'None') return { accepted: false, reason: 'not a Claude task event' }
		let rows: readonly MirrorRow[] = []
		try {
			rows = JSON.parse(await readFile(statePath, 'utf8')) as readonly MirrorRow[]
		} catch {}
		await mkdir(dirname(statePath), { recursive: true })
		await writeFile(statePath, JSON.stringify(applyTaskEvent(rows, parsed.value), null, 2))
		return { accepted: true, projection: 'claude-task-mirror' }
	}
	if (client === 'codex' && typeof event === 'object' && event !== null) {
		await mkdir(dirname(planLog), { recursive: true })
		await appendFile(planLog, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`)
		return { accepted: true, projection: 'codex-plan-observation' }
	}
	return { accepted: false, reason: 'unknown client or event' }
}

const handle = async (line: string): Promise<void> => {
	if (line.trim() === '') return
	let request: Rpc
	try {
		request = JSON.parse(line) as Rpc
	} catch {
		console.log(error(undefined, -32700, 'Parse error'))
		return
	}
	if (typeof request.method !== 'string') {
		if (request.id !== undefined) console.log(error(request.id, -32600, 'Invalid Request'))
		return
	}
	const id = request.id
	const respond = (payload: unknown) => {
		if (id !== undefined) console.log(reply(id, payload))
	}
	if (request.method === 'server/discover') {
		const requested = requestedProtocolVersion(request.params)
		if (requested !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested as never)) {
			console.log(unsupportedProtocol(id, requested))
			return
		}
		respond({
			resultType: 'complete',
			supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
			capabilities: { tools: { listChanged: false } },
			_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'tudo', version: SERVER_VERSION } },
		})
	} else if (request.method === 'initialize') {
		const requested = requestedProtocolVersion(request.params)
		if (requested !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested as never)) {
			console.log(unsupportedProtocol(id, requested))
			return
		}
		respond({
			protocolVersion: requested ?? '2026-07-28',
			capabilities: { tools: {} },
			serverInfo: { name: 'tudo', version: SERVER_VERSION },
		})
	} else if (request.method === 'tools/list') {
		respond({
			resultType: 'complete',
			tools: toolDefinitions,
			ttlMs: 60_000,
			cacheScope: 'public',
		})
	} else if (request.method === 'tools/call' && request.params?.name === 'observe_l1_event') {
		const result = await observe((request.params.arguments ?? {}) as Record<string, unknown>)
		respond({
			resultType: 'complete',
			content: [{ type: 'text', text: encode(result) }],
			structuredContent: result,
		})
	} else if (request.method === 'tools/call') {
		const args = (request.params?.arguments ?? {}) as Record<string, unknown>
		const name = request.params?.name
		const result = name === 'tudo_status' ? await act.status() : name === 'tudo_promote' ? await act.promote({ have: Array.isArray(args.have) ? args.have.filter((id): id is string => typeof id === 'string') : [] }) : name === 'tudo_link' && typeof args.id === 'string' && typeof args.n === 'number' && typeof args.repo === 'string' ? await act.link({ id: args.id, n: args.n, repo: args.repo, ...(typeof args.roadmap === 'string' ? { roadmap: args.roadmap } : {}) }) : name === 'tudo_add' && typeof args.id === 'string' && typeof args.subject === 'string' ? await act.add({ id: args.id, subject: args.subject, ...(typeof args.description === 'string' ? { description: args.description } : {}), ...(typeof args.backlogN === 'number' ? { backlogN: args.backlogN } : {}), ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}) }) : name === 'tudo_demote' ? await act.demote({ ...(typeof args.repo === 'string' ? { repo: args.repo } : {}), ...(typeof args.roadmap === 'string' ? { roadmap: args.roadmap } : {}), apply: args.apply === true }) : undefined
		if (result === undefined) {
			if (id !== undefined) console.log(error(id, -32602, 'Unknown tool or invalid arguments'))
			return
		}
		respond({
			resultType: 'complete',
			content: [{ type: 'text', text: encode(result) }],
			structuredContent: result,
		})
	} else if (id !== undefined) {
		console.log(error(id, -32601, 'Method not found'))
	}
}

// MCP stdio is a live newline-delimited stream. Do not await stdin.text():
// clients keep stdin open while waiting for discovery/tool responses.
const decoder = new TextDecoder()
let pending = ''
for await (const chunk of Bun.stdin.stream()) {
	pending += decoder.decode(chunk, { stream: true })
	let newline = pending.indexOf('\n')
	while (newline >= 0) {
		const line = pending.slice(0, newline)
		pending = pending.slice(newline + 1)
		await handle(line)
		newline = pending.indexOf('\n')
	}
}
if (pending.trim() !== '') await handle(pending)
