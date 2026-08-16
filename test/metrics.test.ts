import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { computeMetrics } from "../kernel/metrics.ts";
import { openDatabase } from "../kernel/db.ts";
import { createStore } from "../kernel/store.ts";
import { createTradingService, type TradingService } from "../services/trading/service.ts";
import { seedTradingDemo } from "../services/trading/demo.ts";
import { tempDir } from "./support/helpers.ts";
import type { Harness, HarnessTurnInput } from "../kernel/harness/harness.ts";

describe("metrics on an empty store", () => {
  test("returns zeros rather than dividing by zero", () => {
    const db = openDatabase(":memory:");
    createStore(db);
    const metrics = computeMetrics(db);
    assert.equal(metrics.window.runs, 0);
    assert.equal(metrics.completionRate, 0);
    assert.equal(metrics.repair.rate, 0);
    assert.deepEqual(metrics.topCodes, []);
    assert.equal(metrics.latencyMs.p50, 0);
  });
});

describe("metrics over real runs", () => {
  let dir: { path: string; cleanup: () => void };
  let service: TradingService;
  let bookId: string;
  let projectId: string;

  const build = (turn: (input: HarnessTurnInput) => Promise<string>): void => {
    const harness: Harness = {
      id: "programmable",
      async runTurn(input) {
        return { reply: await turn(input), toolCallCount: 0 };
      },
    };
    service = createTradingService({
      harness,
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    const seeded = seedTradingDemo(service.store, service.domain);
    bookId = seeded.bookId;
    projectId = seeded.projectId;
  };

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    service?.close();
    dir.cleanup();
  });

  test("counts outcomes, repair success and per-verifier blocks", async () => {
    build(async (input) => {
      await input.callTool("reconcile", { book_id: bookId });
      // Blocked on the first attempt, correct once the findings come back.
      return input.repairFindings?.length
        ? "There is 1 break on BBB."
        : "The book ties out with no breaks.";
    });

    const session = service.store.createSession(projectId, "m");
    const outcome = await service.engine.submit(session.id, "reconcile the book");
    assert.equal(outcome.status, "ok");

    const metrics = computeMetrics(service.store.db);
    assert.equal(metrics.window.runs, 1);
    assert.equal(metrics.runs.ok, 1);
    assert.equal(metrics.completionRate, 1);

    assert.equal(metrics.repair.attempted, 1);
    assert.equal(metrics.repair.succeeded, 1);
    assert.equal(metrics.repair.rate, 1);

    assert.ok(metrics.verifiers["reconciliation-tie-out"].blocks >= 1);
    assert.ok(metrics.topCodes.some((c) => c.code === "reconciliation-tie-out/false_clean_claim"));
    assert.ok(metrics.latencyMs.max >= 0);
  });

  test("reports runs that stayed blocked after the repair budget", async () => {
    build(async (input) => {
      await input.callTool("reconcile", { book_id: bookId });
      return "The book ties out with no breaks.";
    });

    const session = service.store.createSession(projectId, "m");
    const outcome = await service.engine.submit(session.id, "reconcile the book");
    assert.equal(outcome.status, "blocked");

    const metrics = computeMetrics(service.store.db);
    assert.equal(metrics.blockedAfterBudget, 1);
    assert.equal(metrics.completionRate, 0);
    assert.equal(metrics.repair.attempted, 1);
    assert.equal(metrics.repair.succeeded, 0);
    assert.equal(metrics.repair.rate, 0);
  });

  test("the time window excludes older runs", async () => {
    build(async () => "nothing to report");
    const session = service.store.createSession(projectId, "m");
    await service.engine.submit(session.id, "status");

    assert.equal(computeMetrics(service.store.db).window.runs, 1);
    assert.equal(computeMetrics(service.store.db, { since: Date.now() + 60_000 }).window.runs, 0);
  });
});
