/**
 * `data/store.json` 的原子读写。
 *
 * 设计取舍：
 * - **同步写**：Node 单线程 + 同步原子写（tmp → rename）天然串行，不会出现两个请求
 *   交错读到半成品；避免 promise 队列把"检查状态 → 落库"拉出竞态窗口。
 * - **损坏恢复**：启动时 JSON 不可读 → 备份成 `store.json.corrupt-<ts>`，再以空状态启动
 *   （不静默覆盖损坏文件）。
 *
 * 结构（docs/SERVICE.md §4）：
 * `{ version, projects: { [id]: { config, updatedAt } }, conversations: { [id]: ConversationDto } }`
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfig } from '@agent-studio/shared'
import { agentConfigSchema } from '@agent-studio/shared'
import type {
  ConversationDto,
  ConversationSummary,
} from '@agent-studio/shared'
import type { Logger } from '../logger.js'

export const STORE_VERSION = 1

export interface ProjectRecord {
  config: AgentConfig
  updatedAt: number
}

export interface StoreState {
  version: number
  projects: Record<string, ProjectRecord>
  conversations: Record<string, ConversationDto>
}

function emptyState(): StoreState {
  return { version: STORE_VERSION, projects: {}, conversations: {} }
}

/** 对话 id → 文件名安全字符（会话 id 由服务生成，这里只做防御）。 */
export function assertSafeId(id: string, what = 'id'): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
    throw new Error(`invalid ${what}: ${JSON.stringify(id)}`)
  }
  return id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 宽松但拒绝结构错误的校验：单条坏记录剔除，不因一条脏数据丢掉整个库。 */
function normalizeState(raw: unknown, logger: Logger): StoreState {
  const state = emptyState()
  if (!isRecord(raw)) return state
  if (isRecord(raw.projects)) {
    for (const [id, value] of Object.entries(raw.projects)) {
      if (!isRecord(value)) continue
      const parsed = agentConfigSchema.safeParse(value.config)
      const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : Date.now()
      if (!parsed.success) {
        logger.warn('store: dropping unreadable project record', { projectId: id })
        continue
      }
      state.projects[id] = { config: parsed.data, updatedAt }
    }
  }
  if (isRecord(raw.conversations)) {
    for (const [id, value] of Object.entries(raw.conversations)) {
      if (!isRecord(value)) continue
      if (typeof value.sessionId !== 'string' || !isRecord(value.config)) {
        logger.warn('store: dropping unreadable conversation record', { conversationId: id })
        continue
      }
      state.conversations[id] = value as unknown as ConversationDto
    }
  }
  return state
}

export class Store {
  private state: StoreState = emptyState()

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 读盘；损坏时备份 + 空状态（并立刻写回一个合法空文件，避免下次再判损坏）。 */
  init(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(this.filePath)) {
      this.state = emptyState()
      this.persist()
      return
    }
    const raw = fs.readFileSync(this.filePath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${this.now()}`
      fs.copyFileSync(this.filePath, backupPath)
      this.logger.error('store.json 损坏，已备份并以空状态启动', {
        backupPath,
        error: error instanceof Error ? error.message : String(error),
      })
      this.state = emptyState()
      this.persist()
      return
    }
    this.state = normalizeState(parsed, this.logger)
  }

  /** 原子写：先写同目录临时文件再 rename（同卷 rename 是原子的）。 */
  private persist(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.tmp-${process.pid}-${this.now()}`)
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    fs.renameSync(tmpPath, this.filePath)
  }

  /* ------------------------------------------------------------------ project */

  getProject(projectId: string): ProjectRecord | undefined {
    return this.state.projects[projectId]
  }

  saveProject(projectId: string, config: AgentConfig): ProjectRecord {
    const record: ProjectRecord = { config, updatedAt: this.now() }
    this.state.projects[projectId] = record
    this.persist()
    return record
  }

  /* ------------------------------------------------------------- conversation */

  getConversation(id: string): ConversationDto | undefined {
    return this.state.conversations[id]
  }

  createConversation(record: ConversationDto): ConversationDto {
    this.state.conversations[record.id] = record
    this.persist()
    return record
  }

  updateConversation(id: string, patch: Partial<Omit<ConversationDto, 'id'>>): ConversationDto | undefined {
    const current = this.state.conversations[id]
    if (current === undefined) return undefined
    const next: ConversationDto = { ...current, ...patch, id: current.id, updatedAt: patch.updatedAt ?? this.now() }
    this.state.conversations[id] = next
    this.persist()
    return next
  }

  /**
   * 启动修复：上一个进程崩溃时遗留的 `running` 对话已经没有人推进（运行时不跨进程），
   * 置回 `idle` 并记录原因，避免对话被永久锁死。
   */
  repairRunningConversations(reason = '服务重启时该轮未完成'): number {
    const ids = Object.values(this.state.conversations)
      .filter((record) => record.status === 'running')
      .map((record) => record.id)
    if (ids.length === 0) return 0
    const timestamp = this.now()
    for (const id of ids) {
      const current = this.state.conversations[id]
      if (current === undefined) continue
      this.state.conversations[id] = { ...current, status: 'idle', lastError: reason, updatedAt: timestamp }
    }
    this.persist()
    return ids.length
  }

  listConversations(options: { projectId?: string; limit?: number } = {}): ConversationSummary[] {
    const limit = options.limit ?? 50
    return Object.values(this.state.conversations)
      .filter((record) => options.projectId === undefined || record.projectId === options.projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((record) => ({
        id: record.id,
        projectId: record.projectId,
        title: record.title,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount,
      }))
  }

  /** 排障/测试用只读快照。 */
  snapshot(): StoreState {
    return this.state
  }

  /** 存储文件路径（排障用）。 */
  get path(): string {
    return this.filePath
  }
}
