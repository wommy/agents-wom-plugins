#!/usr/bin/env bun

// Claude task hooks are synchronous and safety-critical. Delegate to the MCP
// overlay, but always fail open so task creation/completion cannot be blocked.
try {
	const event = await Bun.stdin.text()
	if (event.trim()) {
		const root = process.env.CLAUDE_PLUGIN_ROOT
		if (root) {
			const proc = Bun.spawn(['bun', `${root}/mcp/call.ts`, 'claude', event], {
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'ignore',
				env: process.env,
			})
			await Promise.race([proc.exited, Bun.sleep(2_000)])
		}
	}
} catch {}
process.exit(0)
