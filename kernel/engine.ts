import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
import type { Sandbox } from "./sandbox.ts";
import type { CommandPolicy } from "./policy.ts";
import { evaluateCommand } from "./policy.ts";
import { runVerification } from "./verify.ts";
import { selectSkills } from "./skills.ts";
import { ApprovalDenied, ApprovalRequired, ToolDenied, type Harness } from "./harness/harness.ts";
import type {
  Artifact,
  Finding,
  ProposedArtifact,
  Run,
  Skill,
  ToolContext,
  ToolDefinition,
  Verifier,
} from "./types.ts";

export interface EngineOptions {
  store: Store;
  sandbox: Sandbox;
  harness: Harness;
  tools: ToolDefinition[];
  verifiers: Verifier[];
  skills: Skill[];
  policy: CommandPolicy;
  systemPrompt: string;
  /** Tools that always pause for a human, regardless of the command policy. */
  gatedTools?: Set<string>;
  maxRepairAttempts?: number;
  turnTimeoutMs?: number;
}

export interface RunOutcome {
  run: Run;
  status: Run["status"];
  reply: string | null;
  findings: Finding[];
  artifacts: Artifact[];
}

function inputFingerprint(tool: string, input: unknown): string {
  return createHash("sha256").update(`${tool}:${JSON.stringify(input ?? null)}`).digest("hex").slice(0, 32);
}

export function createEngine(options: EngineOptions) {
  const {
    store,
    sandbox,
    harness,
    tools,
    verifiers,
    skills,
    policy,
    systemPrompt,
    gatedTools = new Set<string>(),
    maxRepairAttempts = 1,
    turnTimeoutMs = 120_000,
  } = options;

  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  async function executeRun(run: Run): Promise<RunOutcome> {
    const project = store.getProject(run.projectId);
    if (!project) throw new Error(`project not found: ${run.projectId}`);

    const approvals = store.listApprovals(run.id);
    const approved = new Set(
      approvals.filter((a) => a.status === "approved").map((a) => inputFingerprint(a.tool, a.input)),
    );
    const denied = new Set(
      approvals.filter((a) => a.status === "denied").map((a) => inputFingerprint(a.tool, a.input)),
    );

    const proposedArtifacts: ProposedArtifact[] = [];
    const savedArtifacts: Artifact[] = [];

    const ctx: ToolContext = {
      projectId: run.projectId,
      runId: run.id,
      sessionId: run.sessionId,
      actor: project.owner,
      settings: project.settings,

      async exec(command, execOpts = {}) {
        const verdict = evaluateCommand(policy, command);
        if (verdict.decision === "deny") throw new ToolDenied("execute", `${verdict.reason} (${verdict.matched ?? ""})`);
        if (verdict.decision === "require_approval") {
          const fingerprint = inputFingerprint("execute", { command });
          if (denied.has(fingerprint)) throw new ApprovalDenied("execute");
          if (!approved.has(fingerprint)) {
            const approval = store.createApproval({
              runId: run.id,
              tool: "execute",
              input: { command },
              reason: verdict.reason,
            });
            throw new ApprovalRequired(approval.id, "execute", verdict.reason);
          }
        }
        return await sandbox.exec(run.projectId, command, execOpts);
      },

      async writeArtifact(path, content, kind = "file") {
        await sandbox.writeFile(run.projectId, path, content);
        const artifact = store.recordArtifact({ projectId: run.projectId, runId: run.id, path, kind, content });
        proposedArtifacts.push({ path, kind, content });
        savedArtifacts.push(artifact);
        return artifact;
      },

      async readArtifact(path) {
        return await sandbox.readFile(run.projectId, path);
      },
    };

    async function callTool(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; output: unknown }> {
      const definition = toolsByName.get(name);
      if (!definition) {
        const output = { error: `unknown tool: ${name}` };
        store.recordToolCall({ runId: run.id, tool: name, input, output, ok: false, durationMs: 0 });
        return { ok: false, output };
      }

      if (gatedTools.has(name)) {
        const fingerprint = inputFingerprint(name, input);
        if (denied.has(fingerprint)) throw new ApprovalDenied(name);
        if (!approved.has(fingerprint)) {
          const approval = store.createApproval({
            runId: run.id,
            tool: name,
            input,
            reason: `${name} has external effects and requires approval`,
          });
          throw new ApprovalRequired(approval.id, name, "external effect");
        }
      }

      const startedAt = Date.now();
      try {
        const output = await definition.handler(input, ctx);
        const record = store.recordToolCall({
          runId: run.id,
          tool: name,
          input,
          output,
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        store.appendEntry(run.sessionId, "tool_call", { tool: name, input, seq: record.seq });
        store.appendEntry(run.sessionId, "tool_result", { tool: name, output, seq: record.seq });
        return { ok: true, output };
      } catch (error) {
        if (error instanceof ApprovalRequired || error instanceof ApprovalDenied) throw error;
        const output =
          error instanceof ToolDenied
            ? { error: error.message, denied_by: "command_policy", reason: error.denyReason }
            : { error: error instanceof Error ? error.message : String(error) };
        store.recordToolCall({
          runId: run.id,
          tool: name,
          input,
          output,
          ok: false,
          durationMs: Date.now() - startedAt,
        });
        store.appendEntry(run.sessionId, "tool_result", { tool: name, output, failed: true });
        return { ok: false, output };
      }
    }

    const history = store.listEntries(run.sessionId).filter((e) => e.seq < Number.MAX_SAFE_INTEGER);
    const selected = selectSkills(skills, run.prompt);

    let repairFindings: Finding[] = [];
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("turn timed out")), turnTimeoutMs);

      let reply: string;
      try {
        const result = await harness.runTurn({
          systemPrompt,
          prompt: run.prompt,
          history,
          tools,
          skills: selected,
          repairFindings,
          callTool,
          signal: controller.signal,
        });
        reply = result.reply;
      } catch (error) {
        clearTimeout(timer);

        if (error instanceof ApprovalRequired) {
          store.setRunStatus(run.id, "awaiting_approval");
          store.appendEntry(run.sessionId, "approval_request", {
            approvalId: error.approvalId,
            tool: error.tool,
            reason: error.approvalReason,
          });
          store.audit(project.owner, "run.awaiting_approval", run.id, { approvalId: error.approvalId });
          const updated = store.getRun(run.id)!;
          return { run: updated, status: updated.status, reply: null, findings: [], artifacts: savedArtifacts };
        }

        const message = error instanceof Error ? error.message : String(error);
        store.finishRun(run.id, "failed", { error: message });
        store.appendEntry(run.sessionId, "system", { error: message });
        store.audit(project.owner, "run.failed", run.id, { error: message });
        const updated = store.getRun(run.id)!;
        return { run: updated, status: "failed", reply: null, findings: [], artifacts: savedArtifacts };
      }
      clearTimeout(timer);

      const verification = await runVerification(verifiers, {
        projectId: run.projectId,
        runId: run.id,
        prompt: run.prompt,
        reply,
        toolCalls: store.listToolCalls(run.id),
        artifacts: proposedArtifacts,
        settings: project.settings,
      });

      store.recordVerification({
        runId: run.id,
        status: verification.status,
        findings: verification.findings,
        durationMs: verification.durationMs,
      });
      store.appendEntry(run.sessionId, "verification", {
        status: verification.status,
        findings: verification.findings,
        attempt,
      });

      if (verification.status !== "blocked") {
        store.finishRun(run.id, "ok", { reply });
        store.appendEntry(run.sessionId, "assistant", reply);
        store.audit(project.owner, "run.ok", run.id, {
          verification: verification.status,
          findings: verification.findings.length,
        });
        const updated = store.getRun(run.id)!;
        return { run: updated, status: "ok", reply, findings: verification.findings, artifacts: savedArtifacts };
      }

      if (attempt >= maxRepairAttempts) {
        store.finishRun(run.id, "blocked", { reply, error: "verification blocked the output" });
        store.appendEntry(run.sessionId, "system", {
          blocked: true,
          findings: verification.findings.filter((f) => f.severity === "block"),
        });
        store.audit(project.owner, "run.blocked", run.id, { findings: verification.findings.length });
        const updated = store.getRun(run.id)!;
        return { run: updated, status: "blocked", reply, findings: verification.findings, artifacts: savedArtifacts };
      }

      attempt = store.bumpRepairAttempts(run.id);
      repairFindings = verification.findings.filter((f) => f.severity === "block");
      proposedArtifacts.length = 0;
    }
  }

  return {
    tools,
    verifiers,
    skills,

    /** Enqueue a prompt and run it to completion. */
    async submit(sessionId: string, prompt: string): Promise<RunOutcome> {
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`session not found: ${sessionId}`);
      store.appendEntry(sessionId, "user", prompt);
      const run = store.createRun({ sessionId, projectId: session.projectId, prompt });
      store.setRunStatus(run.id, "running");
      return await executeRun({ ...run, status: "running" });
    },

    /** Queue a prompt for the background worker instead of running it inline. */
    enqueue(sessionId: string, prompt: string): Run {
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`session not found: ${sessionId}`);
      store.appendEntry(sessionId, "user", prompt);
      return store.createRun({ sessionId, projectId: session.projectId, prompt });
    },

    /** Resume a run that was suspended on an approval. */
    async resume(runId: string): Promise<RunOutcome> {
      const run = store.getRun(runId);
      if (!run) throw new Error(`run not found: ${runId}`);
      if (run.status !== "awaiting_approval") throw new Error(`run ${runId} is ${run.status}, not awaiting_approval`);
      store.setRunStatus(runId, "running");
      return await executeRun({ ...run, status: "running" });
    },

    /** Drain queued runs; used by the background worker. */
    async drainOnce(): Promise<number> {
      let handled = 0;
      for (;;) {
        const run = store.claimQueuedRun();
        if (!run) return handled;
        handled++;
        await executeRun(run);
      }
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
