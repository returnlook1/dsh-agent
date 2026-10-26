/** SQLite 行形状（snake_case，与 DDL 一一对应）。 */
export interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  role: 'admin' | 'user'
  created_at: number
}

export interface AgentRow {
  id: string
  name: string
  description: string
  status: 'draft' | 'published' | 'disabled'
  owner_id: string
  current_version: number
  draft_json: string
  created_at: number
  updated_at: number
}

export interface AgentVersionRow {
  agent_id: string
  version: number
  config_json: string
  created_at: number
  created_by: string
  verified: number
  warnings_json: string
}

export interface AgentPermissionRow {
  id: number
  version_id: string
  tool_name: string
  action: 'allow' | 'deny' | 'ask'
}

export interface McpServerRow {
  id: string
  name: string
  transport: string
  config_json: string
  enabled: number
  created_at: number
  updated_at: number
}

export interface SessionRow {
  id: string
  user_id: string
  agent_id: string
  agent_version: number
  dsh_session_id: string | null
  runtime_id: string | null
  status: 'idle' | 'running' | 'failed' | 'closed'
  title: string
  created_at: number
  updated_at: number
}

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  sequence: number
  tool_calls_json: string
  created_at: number
}

export interface ApprovalRow {
  id: string
  session_id: string
  approval_id: string
  tool: string
  description: string
  arguments_preview: string
  arguments_digest: string
  status: 'pending' | 'allowed' | 'rejected' | 'expired' | 'cancelled'
  created_at: number
  expires_at: number
  decided_at: number | null
  decided_by: string | null
}

export interface AuditRow {
  id: string
  session_id: string
  runtime_id: string
  agent_id: string
  agent_version: number
  user_id: string
  call_id: string
  tool: string
  decision: string
  status: string
  arguments_preview: string
  arguments_digest: string
  error: string | null
  duration_ms: number | null
  approval_id: string | null
  at: number
}

export interface RuntimeRow {
  id: string
  agent_id: string
  agent_version: number
  session_id: string
  profile: string
  home: string
  workspace: string
  policy_version: number
  pid: number | null
  status: string
  started_at: number
  stopped_at: number | null
  last_error: string | null
}
