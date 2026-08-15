import { createEngine, type Engine } from "./engine.ts";
import { openDatabase } from "./db.ts";
import { createStore, type Store } from "./store.ts";
import { createLocalSandbox, type Sandbox } from "./sandbox.ts";
import { createRouter, createHttpServer, badRequest, notFound, requireString, optionalString, optionalObject, type Router } from "./http.ts";
import { nextCronFire } from "./cron.ts";
import { loadSkills } from "./skills.ts";
import type { CommandPolicy } from "./policy.ts";
import type { Harness } from "./harness/harness.ts";
import type { ToolDefinition, Verifier } from "./types.ts";

export interface ServiceDefinition {
  /** Stable identifier, e.g. "trading" or "marketing". */
  id: string;
  databasePath: string;
  workspaceDir: string;
  skillsDir: string;
  systemPrompt: string;
  domainSchema?: string;
  policy: CommandPolicy;
  gatedTools?: Set<string>;
  buildTools(deps: { store: Store; sandbox: Sandbox }): ToolDefinition[];
  buildVerifiers(deps: { store: Store }): Verifier[];
  buildRoutes?(deps: { store: Store; router: Router; engine: Engine; sandbox: Sandbox }): void;
  harness: Harness;
  maxRepairAttempts?: number;
}

export interface Service {
  id: string;
  store: Store;
  sandbox: Sandbox;
  engine: Engine;
  router: Router;
  listen(port: number): Promise<{ port: number; close: () => Promise<void> }>;
  tickCrons(now?: number): Promise<number>;
  close(): void;
}

export function createService(definition: ServiceDefinition): Service {
  const db = openDatabase(definition.databasePath, definition.domainSchema);
  const store = createStore(db);
  const sandbox = createLocalSandbox({ baseDir: definition.workspaceDir });
  const skills = loadSkills(definition.skillsDir);

  const tools = definition.buildTools({ store, sandbox });
  const verifiers = definition.buildVerifiers({ store });

  const engine = createEngine({
    store,
    sandbox,
    harness: definition.harness,
    tools,
    verifiers,
    skills,
    policy: definition.policy,
    systemPrompt: definition.systemPrompt,
    gatedTools: definition.gatedTools,
    maxRepairAttempts: definition.maxRepairAttempts,
  });

  const router = createRouter();

  router.get("/health", () => ({
    service: definition.id,
    status: "ok",
    harness: definition.harness.id,
    tools: tools.map((t) => t.name),
    verifiers: verifiers.map((v) => v.name),
    skills: skills.map((s) => s.name),
  }));

  router.get("/routes", () => ({ routes: router.routes() }));

  router.post("/projects", (ctx) => {
    const project = store.createProject({
      service: definition.id,
      name: requireString(ctx.body, "name"),
      owner: requireString(ctx.body, "owner"),
      settings: optionalObject(ctx.body, "settings") ?? {},
    });
    store.audit(project.owner, "project.create", project.id, { name: project.name });
    return project;
  });

  router.get("/projects", (ctx) => ({ projects: store.listProjects(ctx.query.get("owner") ?? undefined) }));

  router.get("/projects/:id", (ctx) => {
    const project = store.getProject(ctx.params.id);
    if (!project) throw notFound(`project ${ctx.params.id}`);
    return project;
  });

  router.patch("/projects/:id/settings", (ctx) => {
    const project = store.getProject(ctx.params.id);
    if (!project) throw notFound(`project ${ctx.params.id}`);
    const settings = optionalObject(ctx.body, "settings");
    if (!settings) throw badRequest('"settings" object is required');
    store.updateProjectSettings(project.id, { ...project.settings, ...settings });
    return store.getProject(project.id);
  });

  router.post("/projects/:id/sessions", (ctx) => {
    const project = store.getProject(ctx.params.id);
    if (!project) throw notFound(`project ${ctx.params.id}`);
    return store.createSession(project.id, optionalString(ctx.body, "title"));
  });

  router.get("/projects/:id/sessions", (ctx) => ({ sessions: store.listSessions(ctx.params.id) }));

  router.get("/sessions/:id/entries", (ctx) => ({ entries: store.listEntries(ctx.params.id) }));

  router.post("/sessions/:id/turns", async (ctx) => {
    const session = store.getSession(ctx.params.id);
    if (!session) throw notFound(`session ${ctx.params.id}`);
    const outcome = await engine.submit(session.id, requireString(ctx.body, "prompt"));
    return {
      runId: outcome.run.id,
      status: outcome.status,
      reply: outcome.reply,
      findings: outcome.findings,
      artifacts: outcome.artifacts,
      approvals: store.listApprovals(outcome.run.id).filter((a) => a.status === "pending"),
    };
  });

  router.get("/sessions/:id/runs", (ctx) => ({ runs: store.listRuns(ctx.params.id) }));

  router.get("/runs/:id", (ctx) => {
    const run = store.getRun(ctx.params.id);
    if (!run) throw notFound(`run ${ctx.params.id}`);
    return {
      run,
      toolCalls: store.listToolCalls(run.id),
      verifications: store.listVerifications(run.id),
      approvals: store.listApprovals(run.id),
    };
  });

  router.post("/approvals/:id/decide", async (ctx) => {
    const approved = (ctx.body as Record<string, unknown> | undefined)?.approved;
    if (typeof approved !== "boolean") throw badRequest('"approved" boolean is required');
    const decidedBy = requireString(ctx.body, "decidedBy");

    const runId = requireString(ctx.body, "runId");
    const approval = store.listApprovals(runId).find((a) => a.id === ctx.params.id);
    if (!approval) throw notFound(`approval ${ctx.params.id}`);
    if (approval.status !== "pending") throw badRequest(`approval already ${approval.status}`);

    store.decideApproval(approval.id, approved ? "approved" : "denied", decidedBy);
    store.audit(decidedBy, approved ? "approval.approved" : "approval.denied", approval.id, { runId });

    const run = store.getRun(runId);
    if (!run) throw notFound(`run ${runId}`);
    const outcome = await engine.resume(runId);
    return {
      runId,
      status: outcome.status,
      reply: outcome.reply,
      findings: outcome.findings,
      approvals: store.listApprovals(runId).filter((a) => a.status === "pending"),
    };
  });

  router.get("/projects/:id/artifacts", (ctx) => ({ artifacts: store.listArtifacts(ctx.params.id) }));

  router.get("/projects/:id/artifacts/content", async (ctx) => {
    const path = ctx.query.get("path");
    if (!path) throw badRequest('"path" query parameter is required');
    const content = await sandbox.readFile(ctx.params.id, path);
    if (content === null) throw notFound(`artifact ${path}`);
    return { path, content };
  });

  router.post("/projects/:id/deployments", (ctx) => {
    const project = store.getProject(ctx.params.id);
    if (!project) throw notFound(`project ${ctx.params.id}`);
    const artifactId = optionalString(ctx.body, "artifactId") ?? null;
    const deployment = store.createDeployment({
      projectId: project.id,
      artifactId,
      url: `https://${definition.id}.local/${project.id}/${artifactId ?? "latest"}`,
    });
    store.setDeploymentStatus(deployment.id, "live");
    store.audit(project.owner, "deployment.create", deployment.id, { projectId: project.id });
    return store.listDeployments(project.id).find((d) => d.id === deployment.id);
  });

  router.get("/projects/:id/deployments", (ctx) => ({ deployments: store.listDeployments(ctx.params.id) }));

  router.post("/projects/:id/crons", (ctx) => {
    const project = store.getProject(ctx.params.id);
    if (!project) throw notFound(`project ${ctx.params.id}`);
    const schedule = requireString(ctx.body, "schedule");
    const prompt = requireString(ctx.body, "prompt");
    const tz = Number((ctx.body as Record<string, unknown>).timezoneOffsetMinutes ?? 0);
    let nextFireAt: number | null;
    try {
      nextFireAt = nextCronFire(schedule, Date.now(), tz);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "invalid cron expression");
    }
    return store.createCron({
      projectId: project.id,
      schedule,
      prompt,
      nextFireAt,
      timezoneOffsetMinutes: Number.isFinite(tz) ? tz : 0,
    });
  });

  router.get("/projects/:id/crons", (ctx) => ({ crons: store.listCrons(ctx.params.id) }));

  router.get("/audit", (ctx) => ({ audit: store.listAudit(Number(ctx.query.get("limit") ?? 100)) }));

  definition.buildRoutes?.({ store, router, engine, sandbox });

  return {
    id: definition.id,
    store,
    sandbox,
    engine,
    router,

    async listen(port: number) {
      const server = createHttpServer({
        router,
        onError: (error, where) => {
          const status = (error as { status?: number }).status;
          if (status && status < 500) return;
          console.error(`[${definition.id}] ${where.method} ${where.path}:`, error);
        },
      });
      await new Promise<void>((resolvePromise) => server.listen(port, resolvePromise));
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      return {
        port: actual,
        close: () =>
          new Promise<void>((resolvePromise, rejectPromise) =>
            server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
          ),
      };
    },

    /** Fire every cron that is due, reschedule it, and run its prompt. */
    async tickCrons(now = Date.now()) {
      const due = store.dueCrons(now);
      for (const cron of due) {
        const session = store.createSession(cron.projectId, `cron ${cron.schedule}`);
        let next: number | null = null;
        try {
          next = nextCronFire(cron.schedule, now, cron.timezoneOffsetMinutes);
        } catch {
          store.setCronEnabled(cron.id, false, null);
        }
        store.markCronFired(cron.id, now, next);
        store.audit("system", "cron.fire", cron.id, { projectId: cron.projectId });
        await engine.submit(session.id, cron.prompt);
      }
      return due.length;
    },

    close() {
      db.close();
    },
  };
}
