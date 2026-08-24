import { describe, expect, test } from 'bun:test'

const root = new URL('..', import.meta.url)
const readJson = async (relativePath: string) =>
	(await Bun.file(new URL(relativePath, root)).json()) as Record<string, unknown>
const readText = (relativePath: string) => Bun.file(new URL(relativePath, root)).text()

describe('client projections', () => {
	test('portable, Codex, and Claude manifests retain one plugin identity', async () => {
		const [portable, codex, claude] = await Promise.all([
			readJson('plugin.json'),
			readJson('.codex-plugin/plugin.json'),
			readJson('.claude-plugin/plugin.json'),
		])

		for (const manifest of [portable, codex, claude]) {
			expect(manifest.name).toBe('tudo')
			expect(manifest.version).toBe('0.1.3')
		}
	})

	test('Codex projection loads only its native plan hook section', async () => {
		const codex = await readJson('.codex-plugin/plugin.json')

		expect(codex.skills).toBe('./skills/')
		expect(codex.mcpServers).toBeUndefined()
		expect(codex.hooks).toBe('./hooks/codex/hooks.json')
		const hooks = await readJson('hooks/codex/hooks.json')
		expect(JSON.stringify(hooks)).toContain('^update_plan$')
		expect(JSON.stringify(hooks)).not.toContain('TaskCreated')
		expect(JSON.stringify(hooks)).not.toContain('TaskCompleted')
	})

	test('Claude projection retains only Claude task lifecycle hooks', async () => {
		const portable = await readJson('plugin.json')
		const claudeHooks = await readJson('hooks/claude/hooks.json')

		expect(JSON.stringify(portable)).toContain('hooks/claude/hooks.json')
		expect(JSON.stringify(claudeHooks)).toContain('TaskCreated')
		expect(JSON.stringify(claudeHooks)).toContain('TaskCompleted')
		expect(JSON.stringify(claudeHooks)).not.toContain('update_plan')
	})

	test('portable skill is Agent Skills-shaped and provider-neutral', async () => {
		const skill = await readText('skills/tudo/SKILL.md')
		const [, frontmatter = ''] = skill.split('---', 3)
		const name = frontmatter.match(/^name:\s*([^\n]+)/m)?.[1]?.trim()
		const description = frontmatter.match(/^description:\s*([^\n]+)/m)?.[1]?.trim()

		expect(name).toBe('tudo')
		expect(description?.length).toBeGreaterThan(0)
		expect(description?.length ?? 0).toBeLessThanOrEqual(1024)
		expect(skill).not.toMatch(/Claude's TaskCreated|TaskCompleted events/)
	})
})
