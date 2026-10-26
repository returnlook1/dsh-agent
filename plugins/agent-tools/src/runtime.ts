/**
 * Per-process runtime settings for the business tools.
 *
 * Tool definitions are module-level `const`s (they must be, `defineTool` returns a
 * static definition), so deployment paths are resolved once by `apply()` and kept
 * in this tiny module instead of being threaded through every `execute`.
 *
 * Everything is read from environment variables at `apply()` time; nothing is ever
 * read from model output, user messages or tool arguments (docs/IMPL-PLUGINS.md).
 */
import { join } from 'node:path'

/** Deployment options; every field defaults to a documented env var. */
export interface Config {
  /** Directory holding `datasets.json` / `stations.json`. Defaults to `AGENT_STUDIO_TOOLS_DATA_DIR`. */
  readonly dataDir?: string
  /** Directory report tasks are written to. Defaults to `AGENT_STUDIO_OUTPUT_DIR`. */
  readonly outputDir?: string
  /** Authorized station ids. Defaults to `AGENT_STUDIO_ALLOWED_STATIONS` (comma separated). */
  readonly allowedStations?: readonly string[]
}

/** Resolved, immutable deployment settings. */
export interface ToolsSettings {
  readonly dataDir: string
  readonly outputDir: string
  /** `undefined` = no station allowlist configured (L3 check disabled). */
  readonly allowedStations: readonly string[] | undefined
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function parseStationList(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined
  const stations = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return stations.length === 0 ? undefined : stations
}

/**
 * Resolve deployment settings from config + environment.
 * @param config optional overrides; config wins over the environment.
 */
export function resolveToolsSettings(config: Config = {}): ToolsSettings {
  const dataDir = config.dataDir ?? readEnv('AGENT_STUDIO_TOOLS_DATA_DIR') ?? join(process.cwd(), '.studio', 'data')
  const outputDir = config.outputDir ?? readEnv('AGENT_STUDIO_OUTPUT_DIR') ?? join(process.cwd(), '.studio', 'output')
  const allowedStations = config.allowedStations ?? parseStationList(readEnv('AGENT_STUDIO_ALLOWED_STATIONS'))
  return { dataDir, outputDir, allowedStations }
}

let current: ToolsSettings | undefined

/** Install settings for this process (called once from `apply`). */
export function setToolsSettings(settings: ToolsSettings): void {
  current = settings
}

/**
 * Read the installed settings.
 * @throws Error when a tool runs before `apply()` installed the settings — a
 * configuration bug must surface as a tool error, never as silent defaults.
 */
export function toolsSettings(): ToolsSettings {
  if (current === undefined) {
    throw new Error('agent-tools 尚未初始化：apply() 未运行')
  }
  return current
}
