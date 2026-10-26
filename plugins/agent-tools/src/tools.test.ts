/**
 * Business-tool behaviour: parameter bounds, L3 station authorization, fixture
 * errors and deterministic output (docs/IMPL-PLUGINS.md §4).
 *
 * `defineTool(...)` returns a `ToolDefinition` whose `execute` is deliberately
 * erased to `Promise<unknown>` (the precise inference lives on the options object),
 * so the tests narrow results through {@link call}.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { setToolsSettings, type ToolsSettings } from './runtime.js'
import { exportReport } from './tools/export-report.js'
import { mapFlyTo } from './tools/map-fly-to.js'
import { queryStation } from './tools/query-station.js'
import { searchDatasets } from './tools/search-datasets.js'

const DAYS = Array.from({ length: 10 }, (_, index) => ({
  day: `2026-10-${String(index + 1).padStart(2, '0')}`,
  value: 10 + index,
}))

const DATASETS = {
  datasets: [
    { id: 'ds-air', name: '空气质量数据', description: 'AQI 与颗粒物', tags: ['air', '空气质量'] },
    { id: 'ds-water', name: '水质监测数据', description: '河流与水库水质', tags: ['water', '水质'] },
  ],
}

const STATIONS = {
  stations: [
    { id: 'ST-001', name: '一号站', readings: DAYS },
    { id: 'ST-002', name: '二号站', readings: DAYS.slice(0, 3) },
  ],
}

interface Sample {
  day: string
  value: number
}

interface QueryResult {
  stationId: string
  stationName: string
  days: number
  samples: Sample[]
  source: string
}

interface SearchResult {
  keyword: string
  total: number
  datasets: Array<{ id: string; name: string; description: string; tags: string[] }>
}

interface MapResult {
  action: string
  longitude: number
  latitude: number
  zoom: number
}

interface ExportResult {
  reportId: string
  path: string
  format: string
  stationId: string
  rows: number
}

function runContext(): ToolRunContext {
  // `defineTool` only forwards `exec` to the body; these tools read `signal` only.
  return { callId: 'call-1', signal: new AbortController().signal } as unknown as ToolRunContext
}

/** Invoke one registered tool and narrow its erased result type. */
async function call<T>(
  tool: { execute(args: unknown, exec: ToolRunContext): Promise<unknown> },
  args: unknown,
): Promise<T> {
  return (await tool.execute(args, runContext())) as T
}

type Fixture = Omit<ToolsSettings, 'allowedStations'>

/** Create a temp fixture directory, install settings, and return the paths. */
function installFixture(options: { writeFixtures?: boolean; allowedStations?: readonly string[] } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-'))
  const dataDir = join(root, 'data')
  const outputDir = join(root, 'output')
  if (options.writeFixtures !== false) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'datasets.json'), JSON.stringify(DATASETS, null, 2), 'utf8')
    writeFileSync(join(dataDir, 'stations.json'), JSON.stringify(STATIONS, null, 2), 'utf8')
  }
  setToolsSettings({
    dataDir,
    outputDir,
    allowedStations: options.allowedStations === undefined ? ['ST-001'] : options.allowedStations,
  })
  return { dataDir, outputDir }
}

/** Re-install settings over the same fixture with a different station allowlist. */
function withAllowlist(fixture: Fixture, allowedStations: readonly string[] | undefined): void {
  setToolsSettings({ ...fixture, allowedStations })
}

describe('query_station', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = installFixture()
  })

  it('rejects days below 1 (the DSL has no numeric bounds)', async () => {
    await expect(queryStation.execute({ stationId: 'ST-001', days: 0 }, runContext())).rejects.toThrow(
      /`days` 必须在 1\.\.30 之间/,
    )
  })

  it('rejects days above 30', async () => {
    await expect(queryStation.execute({ stationId: 'ST-001', days: 31 }, runContext())).rejects.toThrow(
      /`days` 必须在 1\.\.30 之间/,
    )
  })

  it('rejects a non-integer days value at the argument-schema layer', async () => {
    // `type: 'integer'` is enforced by `defineTool`'s wrapper before `execute` runs.
    await expect(queryStation.execute({ stationId: 'ST-001', days: 2.5 }, runContext())).rejects.toThrow(
      /must be an integer/,
    )
  })

  it('rejects a station outside the authorized list', async () => {
    await expect(queryStation.execute({ stationId: 'ST-002', days: 3 }, runContext())).rejects.toThrow(
      '站点 ST-002 不在授权范围内',
    )
  })

  it('rejects an unknown station with the known ids in the message', async () => {
    withAllowlist(fixture, undefined)
    await expect(queryStation.execute({ stationId: 'ST-999', days: 3 }, runContext())).rejects.toThrow(
      /未知站点 ST-999/,
    )
  })

  it('returns the trailing window, sorted by day', async () => {
    const value = await call<QueryResult>(queryStation, { stationId: 'ST-001', days: 3 })
    expect(value.days).toBe(3)
    expect(value.samples.map((sample) => sample.day)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10'])
    expect(value.source).toBe('local')
  })

  it('clamps to the available readings', async () => {
    withAllowlist(fixture, ['ST-002'])
    const value = await call<QueryResult>(queryStation, { stationId: 'ST-002', days: 30 })
    expect(value.days).toBe(3)
  })

  it('surfaces a structured error when the fixture is missing', async () => {
    installFixture({ writeFixtures: false })
    await expect(queryStation.execute({ stationId: 'ST-001', days: 2 }, runContext())).rejects.toThrow(
      /站点数据不存在或不可读/,
    )
  })

  it('skips the station allowlist when none is configured', async () => {
    withAllowlist(fixture, undefined)
    const value = await call<QueryResult>(queryStation, { stationId: 'ST-002', days: 2 })
    expect(value.stationId).toBe('ST-002')
  })
})

describe('search_datasets', () => {
  beforeEach(() => {
    installFixture()
  })

  it('matches name, description and tags', async () => {
    const value = await call<SearchResult>(searchDatasets, { keyword: 'water' })
    expect(value.total).toBe(1)
    expect(value.datasets[0]?.id).toBe('ds-water')
  })

  it('is case-insensitive and deterministic (sorted by id)', async () => {
    const value = await call<SearchResult>(searchDatasets, { keyword: '数据' })
    expect(value.datasets.map((dataset) => dataset.id)).toEqual(['ds-air', 'ds-water'])
    const again = await call<SearchResult>(searchDatasets, { keyword: '数据' })
    expect(again).toEqual(value)
  })

  it('rejects a keyword longer than 80 characters', async () => {
    await expect(searchDatasets.execute({ keyword: 'x'.repeat(81) }, runContext())).rejects.toThrow(
      /`keyword` 长度必须在 1\.\.80 之间/,
    )
  })

  it('returns an empty result set instead of failing', async () => {
    const value = await call<SearchResult>(searchDatasets, { keyword: 'nothing-matches' })
    expect(value.total).toBe(0)
    expect(value.datasets).toEqual([])
  })
})

describe('map_fly_to', () => {
  beforeEach(() => {
    installFixture()
  })

  it('returns a deterministic camera instruction with the default zoom', async () => {
    const value = await call<MapResult>(mapFlyTo, { longitude: 116.4, latitude: 39.9 })
    expect(value).toEqual({ action: 'flyTo', longitude: 116.4, latitude: 39.9, zoom: 8 })
  })

  it('rejects out-of-range coordinates', async () => {
    await expect(mapFlyTo.execute({ longitude: 200, latitude: 0 }, runContext())).rejects.toThrow(/longitude/)
    await expect(mapFlyTo.execute({ longitude: 0, latitude: -91 }, runContext())).rejects.toThrow(/latitude/)
  })

  it('rejects an out-of-range zoom', async () => {
    await expect(mapFlyTo.execute({ longitude: 0, latitude: 0, zoom: 19 }, runContext())).rejects.toThrow(/zoom/)
  })
})

describe('export_report', () => {
  beforeEach(() => {
    installFixture()
  })

  it('writes a stable report task and returns its identity', async () => {
    const value = await call<ExportResult>(exportReport, { stationId: 'ST-001', format: 'pdf' })
    expect(value).toEqual({
      reportId: 'rpt-ST-001-pdf-10',
      path: value.path,
      format: 'pdf',
      stationId: 'ST-001',
      rows: 10,
    })
    expect(value.path.endsWith('rpt-ST-001-pdf-10.pdf')).toBe(true)
  })

  it('produces the same report id for the same input', async () => {
    const first = await call<ExportResult>(exportReport, { stationId: 'ST-001', format: 'xlsx' })
    const second = await call<ExportResult>(exportReport, { stationId: 'ST-001', format: 'xlsx' })
    expect(second.reportId).toBe(first.reportId)
    expect(second.path).toBe(first.path)
  })

  it('enforces the station allowlist (L3) for high-risk tools too', async () => {
    await expect(exportReport.execute({ stationId: 'ST-002', format: 'pdf' }, runContext())).rejects.toThrow(
      '站点 ST-002 不在授权范围内',
    )
  })
})
