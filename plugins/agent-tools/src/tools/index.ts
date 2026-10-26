/**
 * The registered tool set, in catalogue order.
 *
 * `apply()` registers exactly this array and `catalog.ts` describes exactly this
 * array, so `dist/catalog.json` cannot drift from what the runtime exposes.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { exportReport, meta as exportReportMeta } from './export-report.js'
import { mapFlyTo, meta as mapFlyToMeta } from './map-fly-to.js'
import { queryStation, meta as queryStationMeta } from './query-station.js'
import { searchDatasets, meta as searchDatasetsMeta } from './search-datasets.js'
import type { BusinessToolMeta } from '../tool-meta.js'

/** One tool plus its catalogue metadata. */
export interface BusinessTool {
  readonly meta: BusinessToolMeta
  readonly definition: ToolDefinition
}

/** Every business tool this plugin owns, in catalogue order. */
export const BUSINESS_TOOLS: readonly BusinessTool[] = [
  { meta: searchDatasetsMeta, definition: searchDatasets },
  { meta: queryStationMeta, definition: queryStation },
  { meta: mapFlyToMeta, definition: mapFlyTo },
  { meta: exportReportMeta, definition: exportReport },
]
