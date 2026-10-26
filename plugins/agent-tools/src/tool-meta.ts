/**
 * Catalogue metadata for the four business tools, kept next to the definitions.
 *
 * `dist/catalog.json` is generated from these values plus the *compiled* tool
 * definitions (see `src/catalog.ts`), so the catalogue the gateway reads can never
 * drift from what the plugin actually registers — `catalog.test.ts` enforces it.
 */

/** `toolRiskSchema` from `packages/shared/src/agent-config.ts`. */
export type ToolRisk = 'low' | 'medium' | 'high' | 'critical'

/** Non-executable description of one business tool (feeds `toolCatalogEntrySchema`). */
export interface BusinessToolMeta {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly risk: ToolRisk
  /** Recommended action for a restricted agent profile (`capabilities.tools`). */
  readonly defaultAction: 'allow' | 'ask'
  /** `true` when the tool must go through a human approval channel. */
  readonly requiresApprovalChannel: boolean
  /** Whether the tool may be enabled for a restricted agent at all. */
  readonly restrictedAllowed: boolean
}
