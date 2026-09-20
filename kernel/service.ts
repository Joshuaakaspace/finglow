import { createEngine, type Engine } from "./engine.ts";
import { openDatabase } from "./db.ts";
import { createStore, type Store } from "./store.ts";
import { createLocalSandbox, type Sandbox } from "./sandbox.ts";
import {
  createRouter,
  createHttpServer,
  badRequest,
  notFound,
  forbidden,
  requireString,
  optionalString,
  optionalObject,
  type RequestContext,
  type Router,
} from "./http.ts";
import { nextCronFire } from "./cron.ts";
import { computeMetrics } from "./metrics.ts";
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
  /** Authentication is on unless a caller explicitly opts out (tests, local-only runs). */
  requireAuth?: boolean;
}

export interface Service {
  id: string;
  store: Store;
  sandbox: Sandbox;
  engine: Engine;
  router: Router;
  listen(port: number): Promise<{ port: number; close: () => Promise<void> }>;
  tickCrons(now?: number): Promise<number>;
  /** Mint the first admin key if the deployment has none. Returns it once. */
  ensureBootstrapKey(owner: string): { id: string; key: string } | null;
  /** Register a callback fired when a run is queued, so a worker can wake early. */
  onWorkQueued(notify: () => void): void;
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

  const requireAuth = definition.requireAuth !== false;
  let workNotifier: (() => void) | null = null;
  const router = createRouter();

  /**
   * A key sees only its owner's projects. Admin keys see everything. A project
   * the caller may not see is reported as missing rather than forbidden, so the
   * API does not confirm that someone else's id exists.
   */
  const visibleProject = (ctx: RequestContext, projectId: string) => {
    const project = store.getProject(projectId);
    if (!project) throw notFound(`project ${projectId}`);
    if (ctx.principal && !ctx.principal.admin && project.owner !== ctx.principal.owner) {
      throw notFound(`project ${projectId}`);
    }
    return project;
  };

  const visibleSession = (ctx: RequestContext, sessionId: string) => {
    const session = store.getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId}`);
    visibleProject(ctx, session.projectId);
    return session;
  };

  const visibleRun = (ctx: RequestContext, runId: string) => {
    const run = store.getRun(runId);
    if (!run) throw notFound(`run ${runId}`);
    visibleProject(ctx, run.projectId);
    return run;
  };

  const requireAdmin = (ctx: RequestContext): void => {
    if (ctx.principal && !ctx.principal.admin) throw forbidden("this route requires an admin key");
  };

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
    const requestedOwner = optionalString(ctx.body, "owner");
    if (requestedOwner && ctx.principal && !ctx.principal.admin && requestedOwner !== ctx.principal.owner) {
      throw forbidden("only an admin key can create a project for another owner");
    }
    const owner = requestedOwner ?? ctx.principal?.owner;
    if (!owner) throw badRequest('"owner" is required');

    const project = store.createProject({
      service: definition.id,
      name: requireString(ctx.body, "name"),
      owner,
      settings: optionalObject(ctx.body, "settings") ?? {},
    });
    store.audit(project.owner, "project.create", project.id, { name: project.name });
    return project;
  });

  router.get("/projects", (ctx) => {
    const requested = ctx.query.get("owner") ?? undefined;
    const scope = ctx.principal && !ctx.principal.admin ? ctx.principal.owner : requested;
    return { projects: store.listProjects(scope) };
  });

  router.get("/projects/:id", (ctx) => visibleProject(ctx, ctx.params.id));

  router.patch("/projects/:id/settings", (ctx) => {
    const project = visibleProject(ctx, ctx.params.id);
    const settings = optionalObject(ctx.body, "settings");
    if (!settings) throw badRequest('"settings" object is required');
    store.updateProjectSettings(project.id, { ...project.settings, ...settings });
    return store.getProject(project.id);
  });

  router.post("/projects/:id/sessions", (ctx) => {
    const project = visibleProject(ctx, ctx.params.id);
    return store.createSession(project.id, optionalString(ctx.body, "title"));
  });

  router.get("/projects/:id/sessions", (ctx) => {
    visibleProject(ctx, ctx.params.id);
    return { sessions: store.listSessions(ctx.params.id) };
  });

  router.get("/sessions/:id/entries", (ctx) => {
    visibleSession(ctx, ctx.params.id);
    return { entries: store.listEntries(ctx.params.id) };
  });

  router.post("/sessions/:id/turns", async (ctx) => {
    const session = visibleSession(ctx, ctx.params.id);
    const prompt = requireString(ctx.body, "prompt");

    // Long turns can be handed to the worker instead of held open on the request.
    if ((ctx.body as Record<string, unknown>).async === true) {
      const queued = engine.enqueue(session.id, prompt);
      workNotifier?.();
      return { runId: queued.id, status: queued.status, reply: null, findings: [], artifacts: [], approvals: [] };
    }

    const outcome = await engine.submit(session.id, prompt);
    return {
      runId: outcome.run.id,
      status: outcome.status,
      reply: outcome.reply,
      findings: outcome.findings,
      artifacts: outcome.artifacts,
      approvals: store.listApprovals(outcome.run.id).filter((a) => a.status === "pending"),
    };
  });

  router.get("/sessions/:id/runs", (ctx) => {
    visibleSession(ctx, ctx.params.id);
    return { runs: store.listRuns(ctx.params.id) };
  });

  router.get("/runs/:id", (ctx) => {
    const run = visibleRun(ctx, ctx.params.id);
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
    visibleRun(ctx, runId);
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

  router.get("/projects/:id/artifacts", (ctx) => {
    visibleProject(ctx, ctx.params.id);
    return { artifacts: store.listArtifacts(ctx.params.id) };
  });

  router.get("/projects/:id/artifacts/content", async (ctx) => {
    visibleProject(ctx, ctx.params.id);
    const path = ctx.query.get("path");
    if (!path) throw badRequest('"path" query parameter is required');
    const content = await sandbox.readFile(ctx.params.id, path);
    if (content === null) throw notFound(`artifact ${path}`);
    return { path, content };
  });

  router.post("/projects/:id/deployments", (ctx) => {
    const project = visibleProject(ctx, ctx.params.id);
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

  router.get("/projects/:id/deployments", (ctx) => {
    visibleProject(ctx, ctx.params.id);
    return { deployments: store.listDeployments(ctx.params.id) };
  });

  router.post("/projects/:id/crons", (ctx) => {
    const project = visibleProject(ctx, ctx.params.id);
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

  router.get("/projects/:id/crons", (ctx) => {
    visibleProject(ctx, ctx.params.id);
    return { crons: store.listCrons(ctx.params.id) };
  });

  router.get("/audit", (ctx) => {
    requireAdmin(ctx);
    return { audit: store.listAudit(Number(ctx.query.get("limit") ?? 100)) };
  });

  router.get("/metrics", (ctx) => {
    requireAdmin(ctx);
    const windowHours = Number(ctx.query.get("hours") ?? 0);
    const since = windowHours > 0 ? Date.now() - windowHours * 3_600_000 : undefined;
    return { service: definition.id, ...computeMetrics(db, { since }) };
  });

  router.post("/keys", (ctx) => {
    requireAdmin(ctx);
    const key = store.createApiKey({
      name: requireString(ctx.body, "name"),
      owner: requireString(ctx.body, "owner"),
      admin: (ctx.body as Record<string, unknown>).admin === true,
    });
    store.audit(ctx.principal?.owner ?? "bootstrap", "key.create", key.id, { name: requireString(ctx.body, "name") });
    return { ...key, warning: "this is the only time the key is shown" };
  });

  router.get("/keys", (ctx) => {
    requireAdmin(ctx);
    return { keys: store.listApiKeys() };
  });

  router.delete("/keys/:id", (ctx) => {
    requireAdmin(ctx);
    if (!store.revokeApiKey(ctx.params.id)) throw notFound(`active key ${ctx.params.id}`);
    store.audit(ctx.principal?.owner ?? "bootstrap", "key.revoke", ctx.params.id, {});
    return { revoked: ctx.params.id };
  });

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
        authenticate: requireAuth ? (key) => store.authenticate(key) : undefined,
        publicRoutes: new Set(["GET /health"]),
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
    onWorkQueued(notify: () => void) {
      workNotifier = notify;
    },

    ensureBootstrapKey(owner: string) {
      if (store.countApiKeys() > 0) return null;
      const key = store.createApiKey({ name: "bootstrap", owner, admin: true });
      store.audit(owner, "key.bootstrap", key.id, {});
      return key;
    },

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
