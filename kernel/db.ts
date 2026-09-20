import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const KERNEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS entries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  reply TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  repair_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_id TEXT,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deployments_project ON deployments(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at INTEGER,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crons_due ON crons(enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_run ON verifications(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id, status);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys(owner);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
`;

export function openDatabase(path: string, domainSchema = ""): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(KERNEL_SCHEMA);
  if (domainSchema) db.exec(domainSchema);
  return db;
}

export type Db = DatabaseSync;

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}
