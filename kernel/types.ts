export type ServiceId = string;

export interface Project {
  id: string;
  service: ServiceId;
  name: string;
  owner: string;
  createdAt: number;
  settings: Record<string, unknown>;
}

export interface Session {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  lastActivityAt: number;
}

export type EntryType =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "verification"
  | "approval_request"
  | "approval_resolved"
  | "system";

export interface Entry {
  sessionId: string;
  seq: number;
  type: EntryType;
  payload: unknown;
  createdAt: number;
}

export type RunStatus = "queued" | "running" | "blocked" | "ok" | "failed" | "awaiting_approval";

export interface Run {
  id: string;
  sessionId: string;
  projectId: string;
  status: RunStatus;
  prompt: string;
  reply: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  repairAttempts: number;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  seq: number;
  tool: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  durationMs: number;
  createdAt: number;
}

export interface Artifact {
  id: string;
  projectId: string;
  runId: string | null;
  path: string;
  kind: string;
  bytes: number;
  sha256: string;
  createdAt: number;
}

export type DeploymentStatus = "pending" | "live" | "failed" | "stopped";

export interface Deployment {
  id: string;
  projectId: string;
  artifactId: string | null;
  url: string;
  status: DeploymentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CronJob {
  id: string;
  projectId: string;
  schedule: string;
  timezoneOffsetMinutes: number;
  prompt: string;
  enabled: boolean;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  createdAt: number;
}

export interface AuditRecord {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: unknown;
}

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Approval {
  id: string;
  runId: string;
  tool: string;
  input: unknown;
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export type Severity = "info" | "warn" | "block";

export interface Finding {
  verifier: string;
  severity: Severity;
  code: string;
  message: string;
  evidence?: unknown;
}

export type VerificationStatus = "pass" | "warn" | "blocked";

export interface VerificationReport {
  id: string;
  runId: string;
  status: VerificationStatus;
  findings: Finding[];
  createdAt: number;
  durationMs: number;
}

export interface ProposedArtifact {
  path: string;
  kind: string;
  content: string;
}

export interface VerificationInput {
  projectId: string;
  runId: string;
  prompt: string;
  reply: string;
  toolCalls: ToolCallRecord[];
  artifacts: ProposedArtifact[];
  settings: Record<string, unknown>;
}

export type Awaitable<T> = T | Promise<T>;

export interface Verifier {
  name: string;
  description: string;
  run(input: VerificationInput): Awaitable<Finding[]>;
}

/** A verifier that needs no I/O, so callers can read its findings directly. */
export interface SyncVerifier extends Verifier {
  run(input: VerificationInput): Finding[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, string>;
  handler(input: Record<string, unknown>, ctx: ToolContext): Awaitable<unknown>;
}

export interface ToolContext {
  projectId: string;
  runId: string;
  sessionId: string;
  actor: string;
  settings: Record<string, unknown>;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  writeArtifact(path: string, content: string, kind?: string): Promise<Artifact>;
  readArtifact(path: string): Promise<string | null>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  path: string;
}
