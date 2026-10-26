/**
 * Agent Service HTTP API。
 *
 * 契约来源：`docs/SERVICE.md` §7 + `@agent-studio/shared` 的 DTO。
 * 这里只做「HTTP ↔ 类型」：所有响应都经过窄化函数校验，JSON 边界不向
 * 业务代码扩散 `any`；调用方拿到的永远是共享契约里的类型。
 */
import type {
  AgentConfigPatch,
  AgentConfigSnapshot,
  ConversationDto,
  ConversationStatus,
  ConversationSummary,
  CreateConversationRequest,
  CreateConversationResponse,
  McpServerListResponse,
  McpServerSummaryDto,
  MessageDto,
  MessageListResponse,
  ProjectAgentConfigDto,
  SkillCatalogResponse,
  SkillSummaryDto,
  ToolCallRecord,
} from '@agent-studio/shared'

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../constants'

const API_BASE = '/api'

/** `GET /api/health` 的响应（不在 shared 契约里）。 */
export interface ServiceHealth {
  ok: boolean
  version?: string
  dshVersion?: string
  runtimes?: number
  uptimeSec?: number
}

export class AgentApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AgentApiError'
    this.status = status
    this.code = code
  }
}

export function isAgentApiError(error: unknown): error is AgentApiError {
  return error instanceof AgentApiError
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && error.name === 'AbortError'
}

/** 面向 UI 的错误文案。 */
export function describeApiError(error: unknown): string {
  if (error instanceof AgentApiError) return error.message
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return '未知错误'
}

/* ------------------------------------------------------------ HTTP 传输层 */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT'
  body?: unknown
  signal?: AbortSignal
  accept?: string
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = { method: options.method ?? 'GET' }
  const headers = new Headers()
  headers.set('Accept', options.accept ?? 'application/json')
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(options.body)
  }
  init.headers = headers
  if (options.signal !== undefined) init.signal = options.signal

  try {
    return await fetch(`${API_BASE}${path}`, init)
  } catch (error) {
    if (isAbortError(error)) throw new AgentApiError(0, 'ABORTED', '请求已取消')
    throw new AgentApiError(0, 'NETWORK_ERROR', '无法连接 Agent 服务（默认 127.0.0.1:8787），请确认服务已启动')
  }
}

function statusFallback(status: number): string {
  switch (status) {
    case 400:
      return '请求参数不合法'
    case 401:
      return '服务令牌无效'
    case 404:
      return '请求的资源不存在'
    case 409:
      return '资源状态冲突，请刷新后重试'
    case 503:
      return '服务暂时不可用'
    default:
      return status >= 500 ? '服务内部错误' : '请求失败'
  }
}

async function toApiError(response: Response): Promise<AgentApiError> {
  const fallback = statusFallback(response.status)
  let text = ''
  try {
    text = await response.text()
  } catch {
    return new AgentApiError(response.status, `HTTP_${response.status}`, fallback)
  }
  if (text.trim().length === 0) {
    return new AgentApiError(response.status, `HTTP_${response.status}`, fallback)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return new AgentApiError(response.status, `HTTP_${response.status}`, text.slice(0, 200))
  }
  const record = asRecord(parsed)
  const nested = record === null ? null : asRecord(record['error'])
  if (nested !== null) {
    const code = readString(nested, 'code') ?? `HTTP_${response.status}`
    const message = readString(nested, 'message') ?? fallback
    return new AgentApiError(response.status, code, message)
  }
  return new AgentApiError(response.status, `HTTP_${response.status}`, fallback)
}

async function requestJson(path: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await request(path, options)
  if (!response.ok) throw await toApiError(response)
  if (response.status === 204) return null
  const text = await response.text()
  if (text.trim().length === 0) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AgentApiError(response.status, 'CONTRACT_ERROR', '服务返回了无法解析的 JSON')
  }
}

/* ------------------------------------------------------------- 窄化工具 */

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as JsonRecord
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : []
}

function contractError(message: string): AgentApiError {
  return new AgentApiError(502, 'CONTRACT_ERROR', `服务响应不符合契约：${message}`)
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readOptionalNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringArray(record: JsonRecord, key: string): string[] | null {
  const value = record[key]
  if (!Array.isArray(value)) return null
  const items = value as unknown[]
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function parseStatus(value: unknown): ConversationStatus {
  if (value === 'idle' || value === 'running' || value === 'failed') return value
  throw contractError('对话状态不是 idle / running / failed')
}

function parseSkillSource(value: unknown): SkillSummaryDto['source'] {
  switch (value) {
    case 'project':
    case 'custom':
    case 'user':
    case 'bundled':
      return value
    default:
      return 'bundled'
  }
}

/* --------------------------------------------------------------- 解析器 */

function parseSkill(value: unknown): SkillSummaryDto {
  const record = asRecord(value)
  if (record === null) throw contractError('skills 条目不是对象')
  const name = readString(record, 'name')
  const description = readString(record, 'description')
  if (name === null || description === null) throw contractError('skills 条目缺少 name / description')
  return {
    name,
    description,
    whenToUse: readOptionalString(record, 'whenToUse'),
    source: parseSkillSource(record['source']),
    path: readOptionalString(record, 'path'),
  }
}

export function parseSkillCatalog(value: unknown): SkillCatalogResponse {
  const record = asRecord(value)
  if (record === null) throw contractError('技能清单响应不是对象')
  const skillsValue = record['skills']
  if (!Array.isArray(skillsValue)) throw contractError('技能清单响应缺少 skills 数组')
  const skills = asUnknownArray(skillsValue).map(parseSkill)

  const roots: SkillCatalogResponse['roots'] = []
  const rootsValue = record['roots']
  if (Array.isArray(rootsValue)) {
    for (const item of asUnknownArray(rootsValue)) {
      const root = asRecord(item)
      if (root === null) continue
      const path = readString(root, 'path')
      if (path === null) continue
      roots.push({ path, source: parseSkillSource(root['source']) })
    }
  }
  return { skills, roots }
}

function parseMcpServer(value: unknown): McpServerSummaryDto {
  const record = asRecord(value)
  if (record === null) throw contractError('MCP 服务器条目不是对象')
  const id = readString(record, 'id')
  const name = readString(record, 'name')
  const transport = record['transport']
  if (id === null || name === null) throw contractError('MCP 服务器条目缺少 id / name')
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw contractError('MCP transport 不是 stdio / streamable-http')
  }
  return {
    id,
    name,
    transport,
    enabled: record['enabled'] !== false,
    description: readOptionalString(record, 'description'),
  }
}

export function parseMcpServerCatalog(value: unknown): McpServerListResponse {
  const record = asRecord(value)
  if (record === null) throw contractError('MCP 响应不是对象')
  const serversValue = record['servers']
  if (!Array.isArray(serversValue)) throw contractError('MCP 响应缺少 servers 数组')
  return {
    servers: asUnknownArray(serversValue).map(parseMcpServer),
    configPath: readOptionalString(record, 'configPath') ?? '',
  }
}

interface AgentConfigFields {
  skills: string[]
  mcpServers: string[]
  provider: string
  model: string
  systemPrompt: string
}

function parseAgentConfigFields(record: JsonRecord): AgentConfigFields {
  return {
    skills: readStringArray(record, 'skills') ?? [],
    mcpServers: readStringArray(record, 'mcpServers') ?? [],
    provider: readString(record, 'provider') ?? DEFAULT_PROVIDER,
    model: readString(record, 'model') ?? DEFAULT_MODEL,
    systemPrompt: readOptionalString(record, 'systemPrompt') ?? '',
  }
}

export function parseProjectAgentConfig(value: unknown, fallbackProjectId: string): ProjectAgentConfigDto {
  let record = asRecord(value)
  if (record === null) throw contractError('项目配置响应不是对象')
  // 兼容 `{ config: {...} }` 包装（契约里是直接返回）。
  if (!('provider' in record) && !('skills' in record)) {
    const nested = asRecord(record['config'])
    if (nested !== null) record = nested
  }
  if (!('provider' in record) && !('skills' in record)) {
    throw contractError('项目配置响应缺少 skills / provider')
  }
  const saved = record['saved']
  return {
    projectId: readString(record, 'projectId') ?? fallbackProjectId,
    ...parseAgentConfigFields(record),
    saved: typeof saved === 'boolean' ? saved : false,
    updatedAt: readOptionalNumber(record, 'updatedAt'),
  }
}

function parseConfigSnapshot(record: JsonRecord, fallbackProjectId: string): AgentConfigSnapshot {
  return {
    ...parseAgentConfigFields(record),
    configKey: readOptionalString(record, 'configKey') ?? '',
    projectId: readOptionalString(record, 'projectId') ?? fallbackProjectId,
    createdAt: readOptionalNumber(record, 'createdAt') ?? 0,
    inheritedFromProject: record['inheritedFromProject'] === true,
  }
}

function parseToolCall(value: unknown): ToolCallRecord {
  const record = asRecord(value)
  if (record === null) throw contractError('toolCalls 条目不是对象')
  const callId = readString(record, 'callId')
  const tool = readString(record, 'tool')
  const status = record['status']
  if (callId === null || tool === null) throw contractError('toolCalls 条目缺少 callId / tool')
  if (status !== 'running' && status !== 'succeeded' && status !== 'failed') {
    throw contractError('toolCalls.status 不是 running / succeeded / failed')
  }
  return {
    callId,
    tool,
    status,
    argumentsPreview: readOptionalString(record, 'argumentsPreview'),
    error: readOptionalString(record, 'error'),
    durationMs: readOptionalNumber(record, 'durationMs'),
  }
}

export function parseMessageDto(value: unknown, fallbackConversationId: string): MessageDto {
  const record = asRecord(value)
  if (record === null) throw contractError('消息条目不是对象')
  const id = readString(record, 'id')
  const content = readString(record, 'content')
  const role = record['role']
  if (id === null || content === null) throw contractError('消息条目缺少 id / content')
  if (role !== 'user' && role !== 'assistant') throw contractError('消息 role 不是 user / assistant')

  let toolCalls: ToolCallRecord[] | undefined
  const rawToolCalls = record['toolCalls']
  if (rawToolCalls !== undefined && rawToolCalls !== null) {
    if (!Array.isArray(rawToolCalls)) throw contractError('消息的 toolCalls 不是数组')
    toolCalls = asUnknownArray(rawToolCalls).map(parseToolCall)
  }

  return {
    id,
    conversationId: readString(record, 'conversationId') ?? fallbackConversationId,
    role,
    content,
    sequence: readNumber(record, 'sequence') ?? 0,
    createdAt: readNumber(record, 'createdAt') ?? 0,
    toolCalls,
  }
}

export function parseMessageList(value: unknown, fallbackConversationId: string): MessageListResponse {
  if (Array.isArray(value)) {
    return {
      conversationId: fallbackConversationId,
      messages: asUnknownArray(value).map((item) => parseMessageDto(item, fallbackConversationId)),
    }
  }
  const record = asRecord(value)
  if (record === null) throw contractError('消息列表响应不是对象')
  const messagesValue = record['messages']
  if (!Array.isArray(messagesValue)) throw contractError('消息列表响应缺少 messages 数组')
  const truncated = record['truncated']
  return {
    conversationId: readString(record, 'conversationId') ?? fallbackConversationId,
    messages: asUnknownArray(messagesValue).map((item) => parseMessageDto(item, fallbackConversationId)),
    ...(typeof truncated === 'boolean' ? { truncated } : {}),
  }
}

export function parseConversationDto(value: unknown): ConversationDto {
  let record = asRecord(value)
  if (record === null) throw contractError('对话详情响应不是对象')
  // 兼容 `{ conversation: {...} }` 包装（契约里是直接返回 DTO）。
  if (!('id' in record) && !('sessionId' in record)) {
    const nested = asRecord(record['conversation'])
    if (nested !== null) record = nested
  }
  const id = readString(record, 'id')
  const projectId = readString(record, 'projectId')
  const sessionId = readString(record, 'sessionId')
  if (id === null || projectId === null || sessionId === null) {
    throw contractError('对话详情缺少 id / projectId / sessionId')
  }
  const configRecord = asRecord(record['config']) ?? {}
  return {
    id,
    projectId,
    sessionId,
    config: parseConfigSnapshot(configRecord, projectId),
    status: parseStatus(record['status']),
    title: readOptionalString(record, 'title') ?? '',
    createdAt: readOptionalNumber(record, 'createdAt') ?? 0,
    updatedAt: readOptionalNumber(record, 'updatedAt') ?? 0,
    messageCount: readOptionalNumber(record, 'messageCount') ?? 0,
    lastError: readOptionalString(record, 'lastError'),
  }
}

function parseConversationSummary(value: unknown): ConversationSummary {
  const record = asRecord(value)
  if (record === null) throw contractError('对话列表条目不是对象')
  const id = readString(record, 'id')
  const projectId = readString(record, 'projectId')
  if (id === null || projectId === null) throw contractError('对话列表条目缺少 id / projectId')
  return {
    id,
    projectId,
    title: readOptionalString(record, 'title') ?? '',
    status: parseStatus(record['status']),
    createdAt: readOptionalNumber(record, 'createdAt') ?? 0,
    updatedAt: readOptionalNumber(record, 'updatedAt') ?? 0,
    messageCount: readOptionalNumber(record, 'messageCount') ?? 0,
  }
}

export function parseConversationList(value: unknown): ConversationSummary[] {
  if (Array.isArray(value)) {
    return asUnknownArray(value).map(parseConversationSummary)
  }
  const record = asRecord(value)
  if (record === null) throw contractError('对话列表响应不是对象')
  const listValue = Array.isArray(record['conversations'])
    ? (record['conversations'] as unknown[])
    : Array.isArray(record['items'])
      ? (record['items'] as unknown[])
      : null
  if (listValue === null) throw contractError('对话列表响应缺少 conversations 数组')
  return listValue.map(parseConversationSummary)
}

export function parseCreateConversationResponse(value: unknown): CreateConversationResponse {
  const record = asRecord(value)
  if (record === null) throw contractError('创建对话响应不是对象')
  const nested = asRecord(record['conversation']) ?? record
  const conversationId = readString(nested, 'conversationId') ?? readString(nested, 'id')
  const sessionId = readString(nested, 'sessionId')
  if (conversationId === null || sessionId === null) {
    throw contractError('创建对话响应缺少 conversationId / sessionId')
  }
  const configRecord = asRecord(nested['config']) ?? {}
  return {
    conversationId,
    sessionId,
    config: parseConfigSnapshot(configRecord, readOptionalString(nested, 'projectId') ?? ''),
  }
}

export function parseHealth(value: unknown): ServiceHealth {
  const record = asRecord(value)
  if (record === null) throw contractError('健康检查响应不是对象')
  const ok = record['ok']
  if (typeof ok !== 'boolean') throw contractError('健康检查响应缺少 ok')
  return {
    ok,
    version: readOptionalString(record, 'version'),
    dshVersion: readOptionalString(record, 'dshVersion'),
    runtimes: readOptionalNumber(record, 'runtimes'),
    uptimeSec: readOptionalNumber(record, 'uptimeSec'),
  }
}

/* ---------------------------------------------------------------- API */

export async function getHealth(): Promise<ServiceHealth> {
  return parseHealth(await requestJson('/health'))
}

export async function getSkills(): Promise<SkillCatalogResponse> {
  return parseSkillCatalog(await requestJson('/skills'))
}

export async function getMcpServers(): Promise<McpServerListResponse> {
  return parseMcpServerCatalog(await requestJson('/mcp-servers'))
}

export async function getProjectAgentConfig(projectId: string): Promise<ProjectAgentConfigDto> {
  const path = `/projects/${encodeURIComponent(projectId)}/agent-config`
  return parseProjectAgentConfig(await requestJson(path), projectId)
}

/** 保存项目默认配置；服务端返回空体时返回 null，由调用方保留本地值。 */
export async function putProjectAgentConfig(
  projectId: string,
  patch: AgentConfigPatch,
): Promise<ProjectAgentConfigDto | null> {
  const path = `/projects/${encodeURIComponent(projectId)}/agent-config`
  const value = await requestJson(path, { method: 'PUT', body: patch })
  return value === null ? null : parseProjectAgentConfig(value, projectId)
}

export async function createConversation(payload: CreateConversationRequest): Promise<CreateConversationResponse> {
  const value = await requestJson('/conversations', { method: 'POST', body: payload })
  return parseCreateConversationResponse(value)
}

export async function listConversations(params: {
  projectId?: string
  limit?: number
}): Promise<ConversationSummary[]> {
  const search = new URLSearchParams()
  if (params.projectId !== undefined && params.projectId.length > 0) {
    search.set('projectId', params.projectId)
  }
  search.set('limit', String(params.limit ?? 50))
  const value = await requestJson(`/conversations?${search.toString()}`)
  return parseConversationList(value)
}

export async function getConversation(conversationId: string): Promise<ConversationDto> {
  return parseConversationDto(await requestJson(`/conversations/${encodeURIComponent(conversationId)}`))
}

export async function getMessages(conversationId: string): Promise<MessageListResponse> {
  const path = `/conversations/${encodeURIComponent(conversationId)}/messages`
  return parseMessageList(await requestJson(path), conversationId)
}

/**
 * 发送消息并打开 SSE 响应。
 *
 * 进入流之前的所有错误（404 / 409 / 5xx / 网络）都以 `AgentApiError` 抛出；
 * 进入流之后服务端只会用 `message.failed` 事件表达失败。
 */
export async function openMessageStream(
  conversationId: string,
  content: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const path = `/conversations/${encodeURIComponent(conversationId)}/messages`
  const response = await request(path, {
    method: 'POST',
    body: { content },
    signal,
    accept: 'text/event-stream',
  })
  if (!response.ok) throw await toApiError(response)
  if (response.body === null) {
    throw new AgentApiError(502, 'SSE_UNAVAILABLE', '服务未返回事件流')
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('application/json')) {
    const text = await response.text()
    throw new AgentApiError(
      502,
      'SSE_UNAVAILABLE',
      text.trim().length > 0 ? text.slice(0, 200) : '服务未返回事件流',
    )
  }
  return response.body
}
