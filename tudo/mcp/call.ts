#!/usr/bin/env bun

const server = `${process.env.PLUGIN_ROOT ?? new URL('..', import.meta.url).pathname}/mcp/server.bundle.js`
const clientVersion = '0.1.3'
const client = process.argv[2]
const event = JSON.parse(process.argv[3] ?? '{}')
const proc = Bun.spawn(['bun', server], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
const requests = [
	{
		jsonrpc: '2.0',
		id: 1,
		method: 'server/discover',
		params: {
			_meta: {
				'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientInfo': { name: 'tudo-hook', version: clientVersion },
				'io.modelcontextprotocol/clientCapabilities': {},
			},
		},
	},
	{
		jsonrpc: '2.0',
		id: 2,
		method: 'tools/call',
		params: {
			name: 'observe_l1_event',
			arguments: { client, event },
			_meta: {
				'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientInfo': { name: 'tudo-hook', version: clientVersion },
				'io.modelcontextprotocol/clientCapabilities': {},
			},
		},
	},
]
// `void`: Bun's stdin writes return promises, but the ordering that matters is
// the byte order on the pipe, which the writes already guarantee. Awaiting each
// one would only add turns before the `await proc.exited` below that actually
// bounds this process.
for (const request of requests) void proc.stdin.write(`${JSON.stringify(request)}\n`)
void proc.stdin.end()
await proc.exited
process.exit(0)
