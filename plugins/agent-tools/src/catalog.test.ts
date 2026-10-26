/**
 * Catalog ↔ tool registry parity (requirement #7).
 *
 * Loads the **built** `dist/index.js`, registers the tools against a fake `ctx`,
 * and proves `dist/catalog.json` describes exactly what was registered: same names,
 * same order, same compiled parameter JSON Schema, same risk/approval metadata.
 * Also catches a stale `catalog.json` (someone edited a tool and forgot to rebuild).
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIST_ENTRY = new URL('../dist/index.js', import.meta.url)
const DIST_CATALOG = new URL('../dist/catalog.json', import.meta.url)
if (!existsSync(DIST_ENTRY) || !existsSync(DIST_CATALOG)) {
  throw new Error(
    'dist 不完整：请先运行 `npm run build -w @agent-studio/plugin-agent-tools`（tsc + scripts/build-catalog.mjs）',
  )
}

const plugin = await import(DIST_ENTRY.href)
const catalog = JSON.parse(readFileSync(DIST_CATALOG, 'utf8')) as {
  catalogVersion: number
  generatedBy: string
  entries: Array<Record<string, unknown>>
}

interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render: unknown }
}

function registerTools(): RegisteredTool[] {
  const registered: RegisteredTool[] = []
  const ctx = {
    tools: {
      register(definition: RegisteredTool) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  plugin.apply(ctx as never, { dataDir: '/tmp/agent-tools-unused', outputDir: '/tmp/agent-tools-unused' })
  return registered
}

const EXPECTED_NAMES = ['search_datasets', 'query_station', 'map_fly_to', 'export_report']

describe('catalog.json', () => {
  it('declares the shared catalogue envelope', () => {
    expect(catalog.catalogVersion).toBe(1)
    expect(catalog.generatedBy).toBe('agent-tools')
  })

  it('lists exactly the four business tools, in registration order', () => {
    expect(catalog.entries.map((entry) => entry['name'])).toEqual(EXPECTED_NAMES)
  })

  it('stays in sync with a freshly derived catalogue (no stale build)', () => {
    expect(plugin.buildCatalog()).toEqual(catalog)
  })

  it('matches the registered tools name-for-name', () => {
    const registered = registerTools()
    expect(registered.map((tool) => tool.name)).toEqual(catalog.entries.map((entry) => entry['name']))
  })

  it('repeats each registered tool description and compiled parameter schema', () => {
    const registered = registerTools()
    for (const definition of registered) {
      const entry = catalog.entries.find((candidate) => candidate['name'] === definition.name)
      expect(entry, definition.name).toBeDefined()
      expect(entry?.['description']).toBe(definition.description)
      expect(entry?.['parameters']).toEqual(definition.parameters)
      expect(entry?.['source']).toBe('business')
    }
  })

  it('carries the documented risk and approval metadata', () => {
    const byName = new Map(catalog.entries.map((entry) => [entry['name'] as string, entry]))
    expect(byName.get('search_datasets')).toMatchObject({ risk: 'low', requiresApprovalChannel: false })
    expect(byName.get('query_station')).toMatchObject({ risk: 'low', requiresApprovalChannel: false })
    expect(byName.get('map_fly_to')).toMatchObject({ risk: 'low', requiresApprovalChannel: false })
    expect(byName.get('export_report')).toMatchObject({ risk: 'high', requiresApprovalChannel: true })
  })

  it('gives every entry a title, a description and a JSON-Schema object of parameters', () => {
    for (const entry of catalog.entries) {
      expect(typeof entry['title']).toBe('string')
      expect((entry['title'] as string).length).toBeGreaterThan(0)
      expect(typeof entry['description']).toBe('string')
      expect((entry['description'] as string).length).toBeGreaterThan(0)
      expect(typeof entry['parameters']).toBe('object')
      expect(entry['parameters']).not.toBeNull()
    }
  })

  it('registers tools that declare the mandatory output contract', () => {
    for (const definition of registerTools()) {
      expect(typeof definition.output.render, definition.name).toBe('function')
      expect(typeof definition.output.schema, definition.name).toBe('object')
    }
  })
})
