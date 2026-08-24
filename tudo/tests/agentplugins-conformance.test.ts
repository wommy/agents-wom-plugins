import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const root = new URL('..', import.meta.url)
const rootPath = realpathSync(root.pathname)
const readJson = async (path: string) => (await Bun.file(new URL(path, root)).json()) as Record<string, unknown>

const within = (base: string, target: string): boolean => {
	const rel = relative(resolve(base), resolve(target))
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${'/'}`) && !isAbsolute(rel))
}

const pluginVersion = (value: unknown): string | undefined =>
	typeof value === 'string' ? value.match(/\/schemas\/([^/]+)\//)?.[1] : undefined

const validName = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length >= 1 &&
	value.length <= 64 &&
	/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) &&
	!value.includes('--') &&
	!value.includes('..')

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const validStdio = (entry: Record<string, unknown>): boolean => {
	const allowed = new Set(['type', 'command', 'args', 'env', 'cwd'])
	if (Object.keys(entry).some(key => !allowed.has(key))) return false
	if (entry.type !== 'stdio' || typeof entry.command !== 'string' || entry.command.length === 0 || /\s/.test(entry.command)) return false
	if (entry.command.includes('${')) return false
	if (entry.command.includes('/')) {
		if (!entry.command.startsWith('./')) return false
		if (!within(rootPath, resolve(rootPath, entry.command))) return false
	}
	if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(value => typeof value !== 'string'))) return false
	if (entry.env !== undefined) {
		if (!isRecord(entry.env)) return false
		for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
			if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA' || typeof value !== 'string') return false
		}
	}
	if (entry.cwd !== undefined) {
		if (typeof entry.cwd !== 'string') return false
		const cwd = entry.cwd
		if (cwd === '${PLUGIN_ROOT}' || cwd === '${PLUGIN_DATA}') return true
		if (cwd.startsWith('${PLUGIN_ROOT}/'))
			return within(rootPath, resolve(rootPath, cwd.slice('${PLUGIN_ROOT}/'.length)))
		if (cwd.startsWith('${PLUGIN_DATA}/'))
			return within('/plugin-data', resolve('/plugin-data', cwd.slice('${PLUGIN_DATA}/'.length)))
		if (cwd.startsWith('./')) return within(rootPath, resolve(rootPath, cwd))
		return false
	}
	return true
}

const validUrl = (value: unknown): value is string => {
	if (typeof value !== 'string') return false
	try {
		const url = new URL(value)
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return false
		if (url.protocol === 'https:') return true
		const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1')
		if (hostname === 'localhost' || hostname === '::1') return true
		const octets = hostname.split('.').map(Number)
		return octets.length === 4 && octets[0] === 127 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
	} catch {
		return false
	}
}

const validHeaders = (value: unknown): boolean => {
	if (!isRecord(value)) return false
	return Object.entries(value).every(([name, header]) =>
		/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) && typeof header === 'string' && !/[\r\n]/.test(header),
	)
}

const validRemote = (entry: Record<string, unknown>): boolean => {
	const allowed = new Set(['type', 'url', 'headers'])
	if (Object.keys(entry).some(key => !allowed.has(key))) return false
	if (!['streamable-http', 'sse'].includes(String(entry.type)) || !validUrl(entry.url)) return false
	return entry.headers === undefined || validHeaders(entry.headers)
}

const validServer = (entry: unknown): boolean =>
	isRecord(entry) && (entry.type === 'stdio' ? validStdio(entry) : validRemote(entry))

const validMcpDocument = (value: unknown): boolean => {
	if (!isRecord(value) || Object.keys(value).some(key => !['$schema', 'mcpServers'].includes(key))) return false
	if (value.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' || !isRecord(value.mcpServers)) return false
	return Object.values(value.mcpServers).every(validServer)
}

const resolvedWithin = (base: string, target: string): boolean => {
	try {
		return within(realpathSync(base), realpathSync(target))
	} catch {
		return false
	}
}

describe('Agent Plugins 1.0.0 package boundaries', () => {
	test('portable manifest and MCP schema versions match and top-level objects are closed', async () => {
		const plugin = await readJson('plugin.json')
		const mcp = await readJson('mcp.json')
		expect(Object.keys(plugin).every(key => ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'].includes(key))).toBe(true)
		expect(Object.keys(mcp).sort()).toEqual(['$schema', 'mcpServers'])
		expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
		expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
		expect(pluginVersion(plugin.$schema)).toBe('1.0.0')
		expect(pluginVersion(mcp.$schema)).toBe(pluginVersion(plugin.$schema))
		expect(typeof plugin.name).toBe('string')
		expect(typeof mcp.mcpServers).toBe('object')
		expect(validName(plugin.name)).toBe(true)
		expect(validMcpDocument(mcp)).toBe(true)
		expect(plugin).not.toHaveProperty('mcpServers')
	})

	test('portable stdio entry stays within command, placeholder, env, and cwd rules', async () => {
		const mcp = await readJson('mcp.json')
		const entry = (mcp.mcpServers as Record<string, unknown>).tudo as Record<string, unknown>
		expect(validStdio(entry)).toBe(true)
		expect(realpathSync(resolve(rootPath, 'mcp/server.bundle.js'))).toSatisfy(path => within(rootPath, path))
	})

	test('boundary mutations are rejected without changing the valid package', () => {
		const base = {
			type: 'stdio',
			command: 'bun',
			args: ['${PLUGIN_ROOT}/mcp/server.bundle.js'],
			env: { DATA: '${PLUGIN_DATA}' },
			cwd: '${PLUGIN_ROOT}',
		}
		const invalid = [
			{ ...base, command: 'bun --shell' },
			{ ...base, command: '${PLUGIN_ROOT}/bun' },
			{ ...base, command: '../bun' },
			{ ...base, command: './../bun' },
			{ ...base, command: './../../outside' },
			{ ...base, cwd: '../outside' },
			{ ...base, cwd: '${PLUGIN_ROOT}/../outside' },
			{ ...base, cwd: '${PLUGIN_DATA}/../outside' },
			{ ...base, cwd: '${PLUGIN_ROOT}x/mcp' },
			{ ...base, env: { PLUGIN_DATA: '/override' } },
			{ ...base, extra: true },
		]
		for (const entry of invalid) expect(validStdio(entry)).toBe(false)
		expect(validName('Bad-Name')).toBe(false)
		expect(validName('has--double')).toBe(false)
		expect(validName('ok.name-2')).toBe(true)
		// Args and env values are opaque strings; only cwd/command are package paths.
		expect(validStdio({ ...base, args: ['--roadmap', '/host/authority/roadmap.toon'] })).toBe(true)
		expect(validStdio({ ...base, env: { ROADMAP: '../host/authority/roadmap.toon' } })).toBe(true)
		expect(validStdio({ ...base, cwd: './mcp' })).toBe(true)
		expect(validStdio({ ...base, cwd: '${PLUGIN_ROOT}/mcp' })).toBe(true)
		expect(validStdio({ ...base, cwd: '${PLUGIN_DATA}/state' })).toBe(true)
	})

	test('closed MCP variants reject cross-transport fields and malformed object shapes', () => {
		const stdio = { type: 'stdio', command: 'bun' }
		const remote = { type: 'streamable-http', url: 'https://example.test/mcp' }
		expect(validServer(stdio)).toBe(true)
		expect(validServer(remote)).toBe(true)
		expect(validServer({ ...stdio, url: 'https://example.test/mcp' })).toBe(false)
		expect(validServer({ ...remote, command: 'bun' })).toBe(false)
		expect(validServer({ type: 'stdio', command: '' })).toBe(false)
		expect(validServer({ type: 'stdio', command: 'bun', env: [] })).toBe(false)
		expect(validServer({ type: 'stdio', command: 'bun', env: null })).toBe(false)
		expect(validServer({ type: 'future', url: 'https://example.test/mcp' })).toBe(false)
		expect(validMcpDocument({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: [] })).toBe(false)
		expect(validMcpDocument({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { good: remote, bad: { type: 'stdio', command: 'bun', url: 'https://example.test' } } })).toBe(false)
	})

	test('remote transport URL and header boundaries follow the spec', () => {
		const valid = { type: 'streamable-http', url: 'https://example.test/mcp', headers: { 'X-Tenant': 'public' } }
		expect(validRemote(valid)).toBe(true)
		for (const url of [
			'http://example.test/mcp',
			'https://user:pass@example.test/mcp',
			'https://example.test/mcp#fragment',
			'file:///tmp/server',
			'/relative/mcp',
		]) expect(validRemote({ ...valid, url })).toBe(false)
		for (const url of ['http://localhost/mcp', 'http://127.0.0.1/mcp', 'http://127.42.1.9/mcp', 'http://[::1]/mcp'])
			expect(validRemote({ ...valid, url })).toBe(true)
		expect(validRemote({ ...valid, headers: { 'X-Test': 1 } })).toBe(false)
		expect(validRemote({ ...valid, headers: { 'Bad Header': 'x' } })).toBe(false)
		expect(validRemote({ ...valid, headers: { 'X-Test': 'line\nbreak' } })).toBe(false)
		expect(validRemote({ ...valid, extra: true })).toBe(false)
	})

	test('filesystem containment follows resolved paths, including symlink escapes', () => {
		const dir = mkdtempSync(join(tmpdir(), 'tudo-agentplugins-boundary-'))
		try {
			const root = join(dir, 'plugin')
			const outside = join(dir, 'outside')
			mkdirSync(join(root, 'bin'), { recursive: true })
			mkdirSync(outside)
			writeFileSync(join(root, 'bin', 'ok'), '')
			writeFileSync(join(outside, 'secret'), '')
			symlinkSync(outside, join(root, 'linked-outside'))
			expect(resolvedWithin(root, join(root, 'bin', 'ok'))).toBe(true)
			expect(resolvedWithin(root, join(root, 'linked-outside', 'secret'))).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
