import type { Db } from "./db.ts";
import { fromJson, toJson } from "./db.ts";
import { newId, now, sha256 } from "./ids.ts";
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  AuditRecord,
  CronJob,
  Deployment,
  DeploymentStatus,
  Entry,
  EntryType,
  Finding,
  Project,
  Run,
  RunStatus,
  Session,
  ToolCallRecord,
  VerificationReport,
  VerificationStatus,
} from "./types.ts";

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const nstr = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const nnum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

export function createStore(db: Db) {
  const projectRow = (r: Row): Project => ({
    id: str(r.id),
    service: str(r.service),
    name: str(r.name),
    owner: str(r.owner),
    createdAt: num(r.created_at),
    settings: fromJson<Record<string, unknown>>(r.settings_json, {}),
  });

  const sessionRow = (r: Row): Session => ({
    id: str(r.id),
    projectId: str(r.project_id),
    title: nstr(r.title),
    createdAt: num(r.created_at),
    lastActivityAt: num(r.last_activity_at),
  });

  const runRow = (r: Row): Run => ({
    id: str(r.id),
    sessionId: str(r.session_id),
    projectId: str(r.project_id),
    status: str(r.status) as RunStatus,
    prompt: str(r.prompt),
    reply: nstr(r.reply),
    error: nstr(r.error),
    createdAt: num(r.created_at),
    startedAt: nnum(r.started_at),
    finishedAt: nnum(r.finished_at),
    repairAttempts: num(r.repair_attempts),
  });

  const toolCallRow = (r: Row): ToolCallRecord => ({
    id: str(r.id),
    runId: str(r.run_id),
    seq: num(r.seq),
    tool: str(r.tool),
    input: fromJson<unknown>(r.input_json, null),
    output: fromJson<unknown>(r.output_json, null),
    ok: num(r.ok) === 1,
    durationMs: num(r.duration_ms),
    createdAt: num(r.created_at),
  });

  const artifactRow = (r: Row): Artifact => ({
    id: str(r.id),
    projectId: str(r.project_id),
    runId: nstr(r.run_id),
    path: str(r.path),
    kind: str(r.kind),
    bytes: num(r.bytes),
    sha256: str(r.sha256),
    createdAt: num(r.created_at),
  });

  const cronRow = (r: Row): CronJob => ({
    id: str(r.id),
    projectId: str(r.project_id),
    schedule: str(r.schedule),
    timezoneOffsetMinutes: num(r.timezone_offset_minutes),
    prompt: str(r.prompt),
    enabled: num(r.enabled) === 1,
    nextFireAt: nnum(r.next_fire_at),
    lastFiredAt: nnum(r.last_fired_at),
    createdAt: num(r.created_at),
  });

  return {
    db,

    createProject(input: { service: string; name: string; owner: string; settings?: Record<string, unknown> }): Project {
      const project: Project = {
        id: newId("prj"),
        service: input.service,
        name: input.name,
        owner: input.owner,
        createdAt: now(),
        settings: input.settings ?? {},
      };
      db.prepare(
        "INSERT INTO projects (id, service, name, owner, created_at, settings_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(project.id, project.service, project.name, project.owner, project.createdAt, toJson(project.settings));
      return project;
    },

    getProject(id: string): Project | null {
      const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
      return r ? projectRow(r) : null;
    },

    listProjects(owner?: string): Project[] {
      const rows = owner
        ? (db.prepare("SELECT * FROM projects WHERE owner = ? ORDER BY created_at DESC").all(owner) as Row[])
        : (db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Row[]);
      return rows.map(projectRow);
    },

    updateProjectSettings(id: string, settings: Record<string, unknown>): void {
      db.prepare("UPDATE projects SET settings_json = ? WHERE id = ?").run(toJson(settings), id);
    },

    createSession(projectId: string, title?: string): Session {
      const t = now();
      const session: Session = { id: newId("ses"), projectId, title: title ?? null, createdAt: t, lastActivityAt: t };
      db.prepare(
        "INSERT INTO sessions (id, project_id, title, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?)",
      ).run(session.id, session.projectId, session.title, session.createdAt, session.lastActivityAt);
      return session;
    },

    getSession(id: string): Session | null {
      const r = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
      return r ? sessionRow(r) : null;
    },

    listSessions(projectId: string): Session[] {
      const rows = db
        .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY last_activity_at DESC")
        .all(projectId) as Row[];
      return rows.map(sessionRow);
    },

    touchSession(id: string): void {
      db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").run(now(), id);
    },

    appendEntry(sessionId: string, type: EntryType, payload: unknown): Entry {
      const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM entries WHERE session_id = ?").get(sessionId) as
        | Row
        | undefined;
      const seq = num(row?.m) + 1;
      const createdAt = now();
      db.prepare(
        "INSERT INTO entries (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(sessionId, seq, type, toJson(payload), createdAt);
      db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").run(createdAt, sessionId);
      return { sessionId, seq, type, payload, createdAt };
    },

    listEntries(sessionId: string, limit = 500): Entry[] {
      const rows = db
        .prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY seq ASC LIMIT ?")
        .all(sessionId, limit) as Row[];
      return rows.map((r) => ({
        sessionId: str(r.session_id),
        seq: num(r.seq),
        type: str(r.type) as EntryType,
        payload: fromJson<unknown>(r.payload_json, null),
        createdAt: num(r.created_at),
      }));
    },

    createRun(input: { sessionId: string; projectId: string; prompt: string }): Run {
      const run: Run = {
        id: newId("run"),
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: "queued",
        prompt: input.prompt,
        reply: null,
        error: null,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        repairAttempts: 0,
      };
      db.prepare(
        "INSERT INTO runs (id, session_id, project_id, status, prompt, created_at, repair_attempts) VALUES (?, ?, ?, ?, ?, ?, 0)",
      ).run(run.id, run.sessionId, run.projectId, run.status, run.prompt, run.createdAt);
      return run;
    },

    getRun(id: string): Run | null {
      const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
      return r ? runRow(r) : null;
    },

    listRuns(sessionId: string, limit = 50): Run[] {
      const rows = db
        .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(sessionId, limit) as Row[];
      return rows.map(runRow);
    },

    claimQueuedRun(): Run | null {
      const r = db
        .prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get() as Row | undefined;
      if (!r) return null;
      const changes = db
        .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), str(r.id));
      if (Number(changes.changes) !== 1) return null;
      return this.getRun(str(r.id));
    },

    finishRun(id: string, status: RunStatus, patch: { reply?: string | null; error?: string | null } = {}): void {
      db.prepare("UPDATE runs SET status = ?, reply = ?, error = ?, finished_at = ? WHERE id = ?").run(
        status,
        patch.reply ?? null,
        patch.error ?? null,
        now(),
        id,
      );
    },

    setRunStatus(id: string, status: RunStatus): void {
      db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
    },

    bumpRepairAttempts(id: string): number {
      db.prepare("UPDATE runs SET repair_attempts = repair_attempts + 1 WHERE id = ?").run(id);
      const r = db.prepare("SELECT repair_attempts AS n FROM runs WHERE id = ?").get(id) as Row | undefined;
      return num(r?.n);
    },

    recordToolCall(input: {
      runId: string;
      tool: string;
      input: unknown;
      output: unknown;
      ok: boolean;
      durationMs: number;
    }): ToolCallRecord {
      const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM tool_calls WHERE run_id = ?").get(input.runId) as
        | Row
        | undefined;
      const rec: ToolCallRecord = {
        id: newId("tc"),
        runId: input.runId,
        seq: num(row?.m) + 1,
        tool: input.tool,
        input: input.input,
        output: input.output,
        ok: input.ok,
        durationMs: input.durationMs,
        createdAt: now(),
      };
      db.prepare(
        "INSERT INTO tool_calls (id, run_id, seq, tool, input_json, output_json, ok, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(rec.id, rec.runId, rec.seq, rec.tool, toJson(rec.input), toJson(rec.output), rec.ok ? 1 : 0, rec.durationMs, rec.createdAt);
      return rec;
    },

    listToolCalls(runId: string): ToolCallRecord[] {
      const rows = db.prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY seq ASC").all(runId) as Row[];
      return rows.map(toolCallRow);
    },

    recordArtifact(input: {
      projectId: string;
      runId: string | null;
      path: string;
      kind: string;
      content: string;
    }): Artifact {
      const bytes = Buffer.byteLength(input.content, "utf8");
      const artifact: Artifact = {
        id: newId("art"),
        projectId: input.projectId,
        runId: input.runId,
        path: input.path,
        kind: input.kind,
        bytes,
        sha256: sha256(input.content),
        createdAt: now(),
      };
      db.prepare(
        "INSERT INTO artifacts (id, project_id, run_id, path, kind, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        artifact.id,
        artifact.projectId,
        artifact.runId,
        artifact.path,
        artifact.kind,
        artifact.bytes,
        artifact.sha256,
        artifact.createdAt,
      );
      return artifact;
    },

    listArtifacts(projectId: string): Artifact[] {
      const rows = db
        .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC")
        .all(projectId) as Row[];
      return rows.map(artifactRow);
    },

    recordVerification(input: {
      runId: string;
      status: VerificationStatus;
      findings: Finding[];
      durationMs: number;
    }): VerificationReport {
      const report: VerificationReport = {
        id: newId("ver"),
        runId: input.runId,
        status: input.status,
        findings: input.findings,
        durationMs: input.durationMs,
        createdAt: now(),
      };
      db.prepare(
        "INSERT INTO verifications (id, run_id, status, findings_json, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(report.id, report.runId, report.status, toJson(report.findings), report.durationMs, report.createdAt);
      return report;
    },

    listVerifications(runId: string): VerificationReport[] {
      const rows = db
        .prepare("SELECT * FROM verifications WHERE run_id = ? ORDER BY created_at ASC")
        .all(runId) as Row[];
      return rows.map((r) => ({
        id: str(r.id),
        runId: str(r.run_id),
        status: str(r.status) as VerificationStatus,
        findings: fromJson<Finding[]>(r.findings_json, []),
        durationMs: num(r.duration_ms),
        createdAt: num(r.created_at),
      }));
    },

    createApproval(input: { runId: string; tool: string; input: unknown; reason: string }): Approval {
      const approval: Approval = {
        id: newId("apr"),
        runId: input.runId,
        tool: input.tool,
        input: input.input,
        reason: input.reason,
        status: "pending",
        createdAt: now(),
        decidedAt: null,
        decidedBy: null,
      };
      db.prepare(
        "INSERT INTO approvals (id, run_id, tool, input_json, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(approval.id, approval.runId, approval.tool, toJson(approval.input), approval.reason, approval.status, approval.createdAt);
      return approval;
    },

    decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">, decidedBy: string): void {
      db.prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(
        status,
        now(),
        decidedBy,
        id,
      );
    },

    listApprovals(runId: string): Approval[] {
      const rows = db.prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Row[];
      return rows.map((r) => ({
        id: str(r.id),
        runId: str(r.run_id),
        tool: str(r.tool),
        input: fromJson<unknown>(r.input_json, null),
        reason: str(r.reason),
        status: str(r.status) as ApprovalStatus,
        createdAt: num(r.created_at),
        decidedAt: nnum(r.decided_at),
        decidedBy: nstr(r.decided_by),
      }));
    },

    createDeployment(input: { projectId: string; artifactId: string | null; url: string }): Deployment {
      const t = now();
      const deployment: Deployment = {
        id: newId("dep"),
        projectId: input.projectId,
        artifactId: input.artifactId,
        url: input.url,
        status: "pending",
        createdAt: t,
        updatedAt: t,
      };
      db.prepare(
        "INSERT INTO deployments (id, project_id, artifact_id, url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(deployment.id, deployment.projectId, deployment.artifactId, deployment.url, deployment.status, t, t);
      return deployment;
    },

    setDeploymentStatus(id: string, status: DeploymentStatus): void {
      db.prepare("UPDATE deployments SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    },

    listDeployments(projectId: string): Deployment[] {
      const rows = db
        .prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC")
        .all(projectId) as Row[];
      return rows.map((r) => ({
        id: str(r.id),
        projectId: str(r.project_id),
        artifactId: nstr(r.artifact_id),
        url: str(r.url),
        status: str(r.status) as DeploymentStatus,
        createdAt: num(r.created_at),
        updatedAt: num(r.updated_at),
      }));
    },

    createCron(input: {
      projectId: string;
      schedule: string;
      prompt: string;
      nextFireAt: number | null;
      timezoneOffsetMinutes?: number;
    }): CronJob {
      const cron: CronJob = {
        id: newId("cron"),
        projectId: input.projectId,
        schedule: input.schedule,
        timezoneOffsetMinutes: input.timezoneOffsetMinutes ?? 0,
        prompt: input.prompt,
        enabled: true,
        nextFireAt: input.nextFireAt,
        lastFiredAt: null,
        createdAt: now(),
      };
      db.prepare(
        "INSERT INTO crons (id, project_id, schedule, timezone_offset_minutes, prompt, enabled, next_fire_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      ).run(cron.id, cron.projectId, cron.schedule, cron.timezoneOffsetMinutes, cron.prompt, cron.nextFireAt, cron.createdAt);
      return cron;
    },

    listCrons(projectId?: string): CronJob[] {
      const rows = projectId
        ? (db.prepare("SELECT * FROM crons WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[])
        : (db.prepare("SELECT * FROM crons ORDER BY created_at DESC").all() as Row[]);
      return rows.map(cronRow);
    },

    dueCrons(at: number): CronJob[] {
      const rows = db
        .prepare("SELECT * FROM crons WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?")
        .all(at) as Row[];
      return rows.map(cronRow);
    },

    markCronFired(id: string, firedAt: number, nextFireAt: number | null): void {
      db.prepare("UPDATE crons SET last_fired_at = ?, next_fire_at = ? WHERE id = ?").run(firedAt, nextFireAt, id);
    },

    setCronEnabled(id: string, enabled: boolean, nextFireAt: number | null): void {
      db.prepare("UPDATE crons SET enabled = ?, next_fire_at = ? WHERE id = ?").run(enabled ? 1 : 0, nextFireAt, id);
    },

    audit(actor: string, action: string, target: string, detail: unknown = {}): AuditRecord {
      const rec: AuditRecord = { id: newId("aud"), at: now(), actor, action, target, detail };
      db.prepare("INSERT INTO audit (id, at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?, ?)").run(
        rec.id,
        rec.at,
        rec.actor,
        rec.action,
        rec.target,
        toJson(rec.detail),
      );
      return rec;
    },

    listAudit(limit = 100): AuditRecord[] {
      const rows = db.prepare("SELECT * FROM audit ORDER BY at DESC LIMIT ?").all(limit) as Row[];
      return rows.map((r) => ({
        id: str(r.id),
        at: num(r.at),
        actor: str(r.actor),
        action: str(r.action),
        target: str(r.target),
        detail: fromJson<unknown>(r.detail_json, {}),
      }));
    },
  };
}

export type Store = ReturnType<typeof createStore>;
