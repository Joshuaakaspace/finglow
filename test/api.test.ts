import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTradingService, type TradingService } from "../services/trading/service.ts";
import { createMarketingService, type MarketingService } from "../services/marketing/service.ts";
import { seedTradingDemo, tradingDemoHarness } from "../services/trading/demo.ts";
import { marketingDemoHarness, seedMarketingDemo } from "../services/marketing/demo.ts";
import { tempDir } from "./support/helpers.ts";

interface Client {
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: any }>;
  patch(path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

function client(port: number, apiKey?: string): Client {
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    patch: (p, b) => call("PATCH", p, b),
  };
}

describe("trading HTTP API", () => {
  let dir: { path: string; cleanup: () => void };
  let service: TradingService;
  let api: Client;
  let close: () => Promise<void>;
  let projectId: string;
  let bookId: string;
  let apiKey: string;
  let anonymous: Client;
  let boundPort: number;

  before(async () => {
    dir = tempDir();
    let resolved = "";
    service = createTradingService({
      harness: tradingDemoHarness(() => resolved),
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    const seeded = seedTradingDemo(service.store, service.domain);
    projectId = seeded.projectId;
    bookId = seeded.bookId;
    resolved = bookId;
    const bootstrap = service.ensureBootstrapKey("demo@firm.test");
    assert.ok(bootstrap, "a fresh service should mint a bootstrap key");
    apiKey = bootstrap.key;

    const listener = await service.listen(0);
    close = listener.close;
    boundPort = listener.port;
    api = client(listener.port, apiKey);
    anonymous = client(listener.port);
  });

  after(async () => {
    await close();
    service.close();
    dir.cleanup();
  });

  test("rejects a request with no API key", async () => {
    const { status, body } = await anonymous.get("/projects");
    assert.equal(status, 401);
    assert.match(body.error, /API key is required/);
  });

  test("rejects an unknown API key", async () => {
    const { status, body } = await client(boundPort, "extpo_deadbeefdeadbeefdeadbeefdeadbeef").get("/projects");
    assert.equal(status, 401);
    assert.match(body.error, /unknown or revoked/);
  });

  test("serves /health without a key", async () => {
    const { status, body } = await anonymous.get("/health");
    assert.equal(status, 200);
    assert.equal(body.service, "trading");
  });

  test("reports its capabilities on /health", async () => {
    const { status, body } = await api.get("/health");
    assert.equal(status, 200);
    assert.equal(body.service, "trading");
    assert.ok(body.verifiers.includes("numeric-provenance"));
    assert.ok(body.tools.includes("propose_trade"));
  });

  test("404s an unknown route with a JSON error", async () => {
    const { status, body } = await api.get("/nope");
    assert.equal(status, 404);
    assert.match(body.error, /no route/);
  });

  test("rejects a create with no name", async () => {
    const { status, body } = await api.post("/projects", { owner: "demo@firm.test" });
    assert.equal(status, 400);
    assert.match(body.error, /"name" is required/);
  });

  test("infers the owner from the presenting key", async () => {
    const { status, body } = await api.post("/projects", { name: "Inferred" });
    assert.equal(status, 201);
    assert.equal(body.owner, "demo@firm.test");
  });

  test("runs a turn end to end and exposes the ledger", async () => {
    const session = await api.post(`/projects/${projectId}/sessions`, { title: "recon" });
    assert.equal(session.status, 201);

    const turn = await api.post(`/sessions/${session.body.id}/turns`, { prompt: "reconcile the book" });
    assert.equal(turn.status, 201);
    assert.equal(turn.body.status, "ok");
    assert.match(turn.body.reply, /1 break/);
    assert.deepEqual(turn.body.findings, []);

    const run = await api.get(`/runs/${turn.body.runId}`);
    assert.equal(run.body.run.status, "ok");
    assert.equal(run.body.toolCalls.length, 2);
    assert.equal(run.body.verifications.at(-1).status, "pass");

    const entries = await api.get(`/sessions/${session.body.id}/entries`);
    const types = entries.body.entries.map((e: { type: string }) => e.type);
    assert.deepEqual(types.slice(0, 2), ["user", "tool_call"]);
    assert.ok(types.includes("verification"));
    assert.equal(types.at(-1), "assistant");
  });

  test("serves the book, its breaks and its exposure", async () => {
    const reconcile = await api.get(`/books/${bookId}/reconcile`);
    assert.equal(reconcile.body.breaks.length, 1);
    assert.equal(reconcile.body.breaks[0].symbol, "BBB");

    const exposure = await api.get(`/books/${bookId}/exposure`);
    assert.ok(exposure.body.gross > 0);
  });

  test("accepts new positions and reflects them in the reconciliation", async () => {
    await api.post(`/books/${bookId}/positions`, { symbol: "DDD", quantity: 10, avgPrice: 5 });
    const reconcile = await api.get(`/books/${bookId}/reconcile`);
    assert.equal(reconcile.body.breaks.length, 2);
  });

  test("validates and stores a cron, computing its next firing", async () => {
    const bad = await api.post(`/projects/${projectId}/crons`, { schedule: "not a cron", prompt: "x" });
    assert.equal(bad.status, 400);

    const good = await api.post(`/projects/${projectId}/crons`, {
      schedule: "0 7 * * 1-5",
      prompt: "brief me on the book",
    });
    assert.equal(good.status, 201);
    assert.ok(good.body.nextFireAt > Date.now());
  });

  test("writes an audit trail covering API mutations and run outcomes", async () => {
    const created = await api.post("/projects", { name: "Audited", owner: "ops@firm.test" });
    assert.equal(created.status, 201);

    const { body } = await api.get("/audit");
    const actions = body.audit.map((a: { action: string }) => a.action);
    assert.ok(actions.includes("project.create"), "project creation should be audited");
    assert.ok(actions.includes("run.ok"), "run outcomes should be audited");

    const entry = body.audit.find((a: { action: string }) => a.action === "project.create");
    assert.equal(entry.actor, "ops@firm.test");
    assert.equal(entry.target, created.body.id);
  });
});

describe("marketing HTTP API", () => {
  let dir: { path: string; cleanup: () => void };
  let service: MarketingService;
  let api: Client;
  let close: () => Promise<void>;
  let projectId: string;
  let brandId: string;
  let channels: Record<string, string>;

  before(async () => {
    dir = tempDir();
    let context = { brandId: "", channels: {} as Record<string, string> };
    service = createMarketingService({
      harness: marketingDemoHarness(() => context),
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    const seeded = seedMarketingDemo(service.store, service.domain);
    projectId = seeded.projectId;
    brandId = seeded.brandId;
    channels = seeded.channels;
    context = { brandId, channels };
    const bootstrap = service.ensureBootstrapKey("demo@brand.test");
    assert.ok(bootstrap, "a fresh service should mint a bootstrap key");

    const listener = await service.listen(0);
    close = listener.close;
    api = client(listener.port, bootstrap.key);
  });

  after(async () => {
    await close();
    service.close();
    dir.cleanup();
  });

  test("reports its capabilities on /health", async () => {
    const { body } = await api.get("/health");
    assert.equal(body.service, "marketing");
    assert.ok(body.verifiers.includes("brand-voice"));
    assert.ok(body.verifiers.includes("utm-hygiene"));
  });

  test("serves the platform rulebook", async () => {
    const all = await api.get("/platforms");
    assert.ok(all.body.platforms.x.maxCharacters === 280);

    const one = await api.get("/platforms/instagram");
    assert.equal(one.body.requiresMedia, true);
    assert.equal((await api.get("/platforms/myspace")).status, 404);
  });

  test("drafts a post that clears every check", async () => {
    const session = await api.post(`/projects/${projectId}/sessions`, {});
    const turn = await api.post(`/sessions/${session.body.id}/turns`, {
      prompt: "draft a post about the signup teardown",
    });
    assert.equal(turn.body.status, "ok");
    assert.deepEqual(turn.body.findings, []);

    const run = await api.get(`/runs/${turn.body.runId}`);
    const drafted = run.body.toolCalls.find((c: { tool: string }) => c.tool === "draft_post");
    assert.ok(drafted, "the run should include a draft");
    assert.ok(drafted.output.character_count <= 280);
  });

  test("exposes and updates the brand voice profile", async () => {
    const before = await api.get(`/brands/${brandId}/voice`);
    assert.equal(before.body.emojiAllowed, false);
    assert.ok(before.body.bannedPhrases.includes("game-changer"));

    const updated = await api.post(`/brands/${brandId}/voice`, {
      tone: "warmer",
      readingGradeMax: 10,
      bannedPhrases: ["synergy"],
      emojiAllowed: true,
    });
    assert.equal(updated.status, 201);
    assert.equal(updated.body.emojiAllowed, true);
    assert.deepEqual(updated.body.bannedPhrases, ["synergy"]);
  });

  test("rejects a channel on an unknown platform", async () => {
    const { status, body } = await api.post(`/brands/${brandId}/channels`, { platform: "myspace", handle: "@x" });
    assert.equal(status, 400);
    assert.match(body.error, /unknown platform/);
  });

  test("stores published posts with metrics and aggregates them", async () => {
    await api.post(`/channels/${channels.x}/posts`, {
      body: "A brand new post about importers.",
      metrics: { impressions: 1000, engagements: 50, clicks: 10 },
    });
    const metrics = await api.get(`/channels/${channels.x}/metrics`);
    assert.ok(metrics.body.posts >= 3);
    assert.ok(metrics.body.engagementRate > 0);
  });

  test("reports channel performance from stored analytics", async () => {
    const session = await api.post(`/projects/${projectId}/sessions`, {});
    const turn = await api.post(`/sessions/${session.body.id}/turns`, { prompt: "how did we do on performance" });
    assert.equal(turn.body.status, "ok");
    assert.match(turn.body.reply, /impressions/);
  });
});
