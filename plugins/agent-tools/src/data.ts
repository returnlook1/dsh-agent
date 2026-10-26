/**
 * Business data access: local JSON fixtures under `AGENT_STUDIO_TOOLS_DATA_DIR`.
 *
 * Deliberately dumb and deterministic — no clock, no network, no caching. A missing
 * or malformed fixture throws a structured {@link ToolDataError}, which
 * `defineTool` turns into an `isError` tool result: the model sees the problem and
 * the runtime never crashes (docs/IMPL-PLUGINS.md §2).
 *
 * L3 (parameter-level authorization) lives here too: allowing `query_station` does
 * not authorize every station (docs/DECISIONS.md §3).
 */
import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ToolsSettings } from './runtime.js'

/** One searchable dataset descriptor (`datasets.json`). */
export interface DatasetRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: string[]
}

/** One station with its locally stored series (`stations.json`). */
export interface StationRecord {
  readonly id: string
  readonly name: string
  readonly readings: StationReading[]
}

/** One deterministic sample of a station series. */
export interface StationReading {
  readonly day: string
  readonly value: number
}

/** Raised for missing/malformed fixtures and L3 authorization failures. */
export class ToolDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolDataError'
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(path: string, label: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new ToolDataError(`${label}不存在或不可读：${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new ToolDataError(`${label}不是合法 JSON：${path}`)
  }
}

/** Accept both `{ <key>: [...] }` and a bare array, then hand back the array. */
function readArray(value: unknown, key: string, label: string): unknown[] {
  if (Array.isArray(value)) return value
  if (isPlainRecord(value) && Array.isArray(value[key])) return value[key] as unknown[]
  throw new ToolDataError(`${label} 必须是数组或 { "${key}": [...] } 对象`)
}

function requireStringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolDataError(`${label} 缺少字符串字段 "${key}"`)
  }
  return value
}

/** Load and validate `datasets.json`, sorted by id for deterministic output. */
export function loadDatasets(settings: ToolsSettings): DatasetRecord[] {
  const path = join(settings.dataDir, 'datasets.json')
  const raw = readArray(readJsonFile(path, '数据集索引'), 'datasets', '数据集索引')
  const datasets = raw.map((item, index): DatasetRecord => {
    if (!isPlainRecord(item)) throw new ToolDataError(`数据集索引第 ${index} 项不是对象：${path}`)
    const tags = item['tags']
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) {
      throw new ToolDataError(`数据集索引第 ${index} 项的 tags 必须是字符串数组：${path}`)
    }
    return {
      id: requireStringField(item, 'id', `数据集索引第 ${index} 项`),
      name: requireStringField(item, 'name', `数据集索引第 ${index} 项`),
      description: typeof item['description'] === 'string' ? item['description'] : '',
      tags: (tags as string[] | undefined) ?? [],
    }
  })
  return datasets.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** Load and validate `stations.json`, sorted by id for deterministic lookups. */
export function loadStations(settings: ToolsSettings): StationRecord[] {
  const path = join(settings.dataDir, 'stations.json')
  const raw = readArray(readJsonFile(path, '站点数据'), 'stations', '站点数据')
  const stations = raw.map((item, index): StationRecord => {
    if (!isPlainRecord(item)) throw new ToolDataError(`站点数据第 ${index} 项不是对象：${path}`)
    const readings = item['readings']
    if (!Array.isArray(readings)) {
      throw new ToolDataError(`站点数据第 ${index} 项的 readings 必须是数组：${path}`)
    }
    const parsed: StationReading[] = readings.map((reading, readingIndex) => {
      if (!isPlainRecord(reading)) {
        throw new ToolDataError(`站点数据第 ${index} 项 readings[${readingIndex}] 不是对象：${path}`)
      }
      const day = reading['day']
      const value = reading['value']
      if (typeof day !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ToolDataError(`站点数据第 ${index} 项 readings[${readingIndex}] 需要 { day: string, value: number }：${path}`)
      }
      return { day, value }
    })
    parsed.sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : 0))
    return {
      id: requireStringField(item, 'id', `站点数据第 ${index} 项`),
      name: typeof item['name'] === 'string' ? item['name'] : requireStringField(item, 'id', `站点数据第 ${index} 项`),
      readings: parsed,
    }
  })
  return stations.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * L3 check: a configured station allowlist is mandatory for every station argument.
 * @throws ToolDataError with the operator-facing message from the spec.
 */
export function assertStationAuthorized(settings: ToolsSettings, stationId: string): void {
  const allowlist = settings.allowedStations
  if (allowlist === undefined) return
  if (!allowlist.includes(stationId)) {
    throw new ToolDataError(`站点 ${stationId} 不在授权范围内`)
  }
}

/** Look one station up, or throw a structured error naming the known ids. */
export function requireStation(settings: ToolsSettings, stationId: string): StationRecord {
  const stations = loadStations(settings)
  const station = stations.find((candidate) => candidate.id === stationId)
  if (station === undefined) {
    const known = stations.map((candidate) => candidate.id).join(', ')
    throw new ToolDataError(`未知站点 ${stationId}（可用站点：${known.length > 0 ? known : '无'}）`)
  }
  return station
}

/** Sanitise an id for use in a file name. */
export function safeFileToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return token.length === 0 ? 'unknown' : token
}

/** Atomic write: temporary file in the destination directory, then rename. */
export function writeFileAtomic(path: string, data: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  writeFileSync(temporary, data, 'utf8')
  try {
    if (process.platform === 'win32') rmSync(path, { force: true })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
