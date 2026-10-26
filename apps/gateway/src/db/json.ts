/** JSON 列的解析工具：解析失败视为数据损坏，记录日志并抛错，绝不静默降级。 */
import type { z } from 'zod'
import type { Logger } from '../logger.js'

export class DataCorruptionError extends Error {
  readonly column: string

  constructor(column: string, cause: unknown) {
    super(`corrupted JSON column: ${column}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'DataCorruptionError'
    this.column = column
  }
}

export function parseJsonColumn<T>(
  schema: z.ZodType<T>,
  raw: string,
  column: string,
  logger: Logger,
): T {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    logger.error('corrupted JSON column', { column, error: error instanceof Error ? error.message : String(error) })
    throw new DataCorruptionError(column, error)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    logger.error('JSON column failed validation', { column, issues: parsed.error.issues })
    throw new DataCorruptionError(column, parsed.error)
  }
  return parsed.data
}
