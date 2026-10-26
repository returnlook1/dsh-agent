/**
 * `data/conversations/<id>.jsonl`：一行一条 `MessageDto`（追加写）。
 *
 * 为什么是 JSONL：
 * - 追加是 O(1)，进程崩溃最多丢半行（读取时跳过坏行并标 `truncated`）；
 * - 真正的对话上下文在 DSH 原生 session 里，这里只是"便于前端回放"的精简记录。
 *
 * 工具调用的状态会从 running 变成 succeeded/failed，JSONL 不能原地改，
 * 因此提供 `patch()`：整体重写（tmp + rename）。同一对话同一时刻只有一个 turn
 * （服务层保证），所以重写是安全的。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { MessageDto } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import { assertSafeId } from './Store.js'

export interface MessageListResult {
  messages: MessageDto[]
  truncated: boolean
}

export class MessageLog {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true })
  }

  private fileFor(conversationId: string): string {
    return path.join(this.dir, `${assertSafeId(conversationId, 'conversationId')}.jsonl`)
  }

  /** 追加一条消息（单行 JSON + 换行）。 */
  append(message: MessageDto): MessageDto {
    const filePath = this.fileFor(message.conversationId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, `${JSON.stringify(message)}\n`, 'utf8')
    return message
  }

  /** 按落盘顺序读取；坏行跳过并标 truncated（半个写入的尾行是预期情况）。 */
  list(conversationId: string): MessageListResult {
    const filePath = this.fileFor(conversationId)
    if (!fs.existsSync(filePath)) return { messages: [], truncated: false }

    const raw = fs.readFileSync(filePath, 'utf8')
    const messages: MessageDto[] = []
    let truncated = false
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        messages.push(JSON.parse(line) as MessageDto)
      } catch {
        truncated = true
        this.logger.warn('message log: skipping unreadable line', { conversationId })
      }
    }
    messages.sort((a, b) => a.sequence - b.sequence)
    return { messages, truncated }
  }

  /** 用更新后的消息整体重写（工具调用状态变化时使用）。 */
  rewrite(conversationId: string, messages: readonly MessageDto[]): void {
    const filePath = this.fileFor(conversationId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    const body = messages.map((message) => `${JSON.stringify(message)}\n`).join('')
    fs.writeFileSync(tmpPath, body, 'utf8')
    fs.renameSync(tmpPath, filePath)
  }

  /** 按 id 就地更新一条消息；返回更新后的记录（找不到返回 undefined）。 */
  patch(conversationId: string, messageId: string, updater: (message: MessageDto) => MessageDto): MessageDto | undefined {
    const { messages } = this.list(conversationId)
    let updated: MessageDto | undefined
    const next = messages.map((message) => {
      if (message.id !== messageId) return message
      updated = updater(message)
      return updated
    })
    if (updated !== undefined) this.rewrite(conversationId, next)
    return updated
  }
}
