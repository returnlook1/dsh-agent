/**
 * `agent-tools` — the business tools exposed to restricted agents.
 *
 * Registers the four catalogue tools on `ctx.tools`. This is the only one of the
 * three plugins allowed to import a `@deepseek-ai/*` *value* at runtime
 * (`defineTool`, a pure tool-definition factory pinned to the runtime version); it
 * never imports Cordis at runtime, so it cannot mint a second `Context`.
 *
 * Authorization is NOT implemented here: the policy plugin decides whether these
 * tools may run. This plugin owns L3 (parameter-level authorization: which stations
 * a user may touch).
 */
import type { Context } from '@deepseek-ai/cordis'

import { resolveToolsSettings, setToolsSettings, type Config } from './runtime.js'
import { BUSINESS_TOOLS } from './tools/index.js'

/** Plugin name used by Cordis fiber diagnostics. */
export const name = 'agent-tools'

/** Hard service dependency: these tools live on the tool registry. */
export const inject: string[] = ['tools']

export { buildCatalog, CATALOG_GENERATED_BY, CATALOG_VERSION } from './catalog.js'
export type { ToolCatalog, ToolCatalogEntry } from './catalog.js'
export { BUSINESS_TOOLS } from './tools/index.js'
export type { BusinessTool } from './tools/index.js'
export type { Config } from './runtime.js'

/**
 * Resolve deployment settings and register every business tool.
 * @param ctx plugin context carrying `ctx.tools`.
 * @param config optional overrides; environment variables win otherwise.
 */
export function apply(ctx: Context, config: Config = {}): void {
  setToolsSettings(resolveToolsSettings(config))
  for (const tool of BUSINESS_TOOLS) {
    ctx.tools.register(tool.definition)
  }
}
