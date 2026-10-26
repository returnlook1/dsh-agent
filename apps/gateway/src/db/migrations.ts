/**
 * 版本化 DDL（docs/IMPL-GATEWAY.md §2）。字段名与契约完全一致。
 *
 * 追加迁移时只允许新增版本，禁止修改已发布的旧版本 SQL。
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

const V1 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','published','disabled')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  current_version INTEGER NOT NULL DEFAULT 0,
  draft_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_versions (
  agent_id TEXT NOT NULL REFERENCES agents(id), version INTEGER NOT NULL,
  config_json TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, warnings_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE agent_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('allow','deny','ask'))
);

CREATE UNIQUE INDEX ux_agent_permissions ON agent_permissions(version_id, tool_name);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL,
  config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL,
  dsh_session_id TEXT, runtime_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle','running','failed','closed')),
  title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE INDEX ix_sessions_user ON agent_sessions(user_id, updated_at DESC);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  role TEXT NOT NULL, content TEXT NOT NULL, sequence INTEGER NOT NULL,
  tool_calls_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_messages_seq ON agent_messages(session_id, sequence);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  approval_id TEXT NOT NULL, tool TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  arguments_preview TEXT NOT NULL DEFAULT '', arguments_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','allowed','rejected','expired','cancelled')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by TEXT
);

CREATE INDEX ix_approvals_session ON approvals(session_id, created_at DESC);

CREATE TABLE agent_tool_audit (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL, user_id TEXT NOT NULL,
  call_id TEXT NOT NULL, tool TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL,
  arguments_preview TEXT NOT NULL DEFAULT '', arguments_digest TEXT NOT NULL DEFAULT '',
  error TEXT, duration_ms INTEGER, approval_id TEXT, at INTEGER NOT NULL
);

CREATE INDEX ix_audit_session ON agent_tool_audit(session_id, at DESC);
CREATE INDEX ix_audit_agent ON agent_tool_audit(agent_id, at DESC);

CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL,
  session_id TEXT NOT NULL, profile TEXT NOT NULL, home TEXT NOT NULL,
  workspace TEXT NOT NULL, policy_version INTEGER NOT NULL,
  pid INTEGER, status TEXT NOT NULL, started_at INTEGER NOT NULL, stopped_at INTEGER,
  last_error TEXT
);
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial-schema', sql: V1 },
]
