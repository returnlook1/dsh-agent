/**
 * `dist/catalog.json` builder.
 *
 * The catalogue is derived from the *same* `BUSINESS_TOOLS` array that `apply()`
 * registers, including each tool's compiled `parameters` JSON Schema, so the file
 * the gateway reads describes exactly what this runtime exposes. The build step
 * (`node scripts/build-catalog.mjs`) imports the compiled module and writes the
 * JSON atomically; `catalog.test.ts` re-derives it and compares.
 *
 * Shape contract: `packages/shared/src/catalog.ts` `toolCatalogSchema` /
 * `toolCatalogEntrySchema`.
 */
import type { ToolRisk } from './tool-meta.js'
import { BUSINESS_TOOLS } from './tools/index.js'

/** Only catalogue version this plugin emits. */
export const CATALOG_VERSION = 1

/** Value of `generatedBy` in every emitted catalogue. */
export const CATALOG_GENERATED_BY = 'agent-tools'

/** One `toolCatalogEntrySchema` entry. */
export interface ToolCatalogEntry {
  name: string
  title: string
  description: string
  source: 'business'
  risk: ToolRisk
  /** Compiled parameter JSON Schema (the gateway renders per-parameter auth hints). */
  parameters?: Record<string, unknown>
  requiresApprovalChannel: boolean
  restrictedAllowed: boolean
}

/** `toolCatalogSchema` */
export interface ToolCatalog {
  catalogVersion: typeof CATALOG_VERSION
  generatedBy: string
  entries: ToolCatalogEntry[]
}

/**
 * Build the catalogue for the currently compiled tool set.
 * @returns a fresh, deterministic object (dependency-free, safe to JSON.stringify).
 */
export function buildCatalog(): ToolCatalog {
  return {
    catalogVersion: CATALOG_VERSION,
    generatedBy: CATALOG_GENERATED_BY,
    entries: BUSINESS_TOOLS.map(({ meta, definition }) => ({
      name: meta.name,
      title: meta.title,
      description: meta.description,
      source: 'business' as const,
      risk: meta.risk,
      parameters: definition.parameters as unknown as Record<string, unknown>,
      requiresApprovalChannel: meta.requiresApprovalChannel,
      restrictedAllowed: meta.restrictedAllowed,
    })),
  }
}
