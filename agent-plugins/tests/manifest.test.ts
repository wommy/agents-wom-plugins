import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'

const root = realpathSync(new URL('..', import.meta.url).pathname)
const within = (base: string, target: string) => {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!rel.startsWith(`..${'/'}`) && rel !== '..' && !isAbsolute(rel))
}

describe('agent-plugins spike', () => {
  test('manifest follows Agent Plugins v1 identity rules', async () => {
    const manifest = await Bun.file(join(root, 'plugin.json')).json()
    expect(Object.keys(manifest).every((key) => [
      '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions',
    ].includes(key))).toBe(true)
    expect(manifest.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(manifest.name).toBe('agent-plugins')
    expect(manifest.name).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
    expect(manifest.name).not.toMatch(/--|\.\./)
  })

  test('portable skill remains in the plugin root', () => {
    const skill = join(root, 'skills', 'agent-plugins', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(lstatSync(skill).isFile()).toBe(true)
    expect(within(root, realpathSync(skill))).toBe(true)
  })

  test('spike has no MCP registration surface', () => {
    expect(existsSync(join(root, 'mcp.json'))).toBe(false)
  })
})
