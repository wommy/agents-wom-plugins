#!/usr/bin/env bun

/**
 * Codex-only thin overlay for the native `update_plan` tool.
 */

const raw = await Bun.stdin.text()
if (raw.trim() === '') process.exit(0)

try {
	const event = JSON.parse(raw) as Record<string, unknown>
	if (event.tool_name !== 'update_plan') process.exit(0)
	const root = process.env.PLUGIN_ROOT
	if (root) {
		const proc = Bun.spawn(['bun', `${root}/mcp/call.ts`, 'codex', JSON.stringify(event)], {
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
			env: process.env,
		})
		await proc.exited
	}
} catch {
	// Hooks must never interfere with the native plan lifecycle.
}

process.exit(0)
