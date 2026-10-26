/**
 * 最小分级日志器。
 *
 * 网关是库代码，禁止 `console.log`：所有输出走 stderr，便于子进程 stdout 保持干净
 * （DSH 运行时 stdout 是 JSON-RPC 专用）。默认级别 `info`，由 `LOG_LEVEL` 控制。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

export interface Logger {
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
  child(bindings: Record<string, unknown>): Logger
}

function serializeDetails(details: unknown): string {
  if (details === undefined) return ''
  if (details instanceof Error) {
    return ` ${details.name}: ${details.message}${details.stack ? `\n${details.stack}` : ''}`
  }
  try {
    return ` ${JSON.stringify(details)}`
  } catch {
    return ' [unserializable details]'
  }
}

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info

  const emit = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, details?: unknown): void => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return
    const extra = Object.keys(bindings).length > 0 ? ` ${JSON.stringify(bindings)}` : ''
    process.stderr.write(`[${new Date().toISOString()}] ${entryLevel.toUpperCase()}${extra} ${message}${serializeDetails(details)}\n`)
  }

  return {
    debug: (message, details) => emit('debug', message, details),
    info: (message, details) => emit('info', message, details),
    warn: (message, details) => emit('warn', message, details),
    error: (message, details) => emit('error', message, details),
    child: (extraBindings) => createLogger(level, { ...bindings, ...extraBindings }),
  }
}

/** 测试与脚本用：完全不输出。 */
export const silentLogger: Logger = createLogger('silent')
