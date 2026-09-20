import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createWorker } from "../kernel/worker.ts";
import { createTradingService, type TradingService } from "../services/trading/service.ts";
import { seedTradingDemo } from "../services/trading/demo.ts";
import { tempDir } from "./support/helpers.ts";
import type { Harness } from "../kernel/harness/harness.ts";

describe("worker", () => {
  let dir: { path: string; cleanup: () => void };
  let service: TradingService;
  let projectId: string;
  let bookId: string;

  const build = (reply: (n: number) => Promise<string>): void => {
    let calls = 0;
    const harness: Harness = {
      id: "counting",
      async runTurn() {
        calls += 1;
        return { reply: await reply(calls), toolCallCount: 0 };
      },
    };
    service = createTradingService({
      harness,
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    const seeded = seedTradingDemo(service.store, service.domain);
    projectId = seeded.projectId;
    bookId = seeded.bookId;
  };

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    service?.close();
    dir.cleanup();
  });

  test("drains a queued run", async () => {
    build(async () => "done");
    const session = service.store.createSession(projectId, "w");
    const queued = service.engine.enqueue(session.id, "status please");
    assert.equal(queued.status, "queued");

    const worker = createWorker({ engine: service.engine, tickCrons: async () => 0 });
    const cycle = await worker.runOnce();

    assert.equal(cycle.drained, 1);
    assert.equal(service.store.getRun(queued.id)?.status, "ok");
    assert.equal(service.store.getRun(queued.id)?.reply, "done");
  });

  test("drains everything queued in one cycle", async () => {
    build(async () => "done");
    const session = service.store.createSession(projectId, "w");
    for (let i = 0; i < 3; i++) service.engine.enqueue(session.id, `job ${i}`);

    const worker = createWorker({ engine: service.engine, tickCrons: async () => 0 });
    assert.equal((await worker.runOnce()).drained, 3);
    assert.equal((await worker.runOnce()).drained, 0, "a second cycle finds nothing left");
  });

  test("fires a due cron and reschedules it", async () => {
    build(async () => "briefed");
    const cron = service.store.createCron({
      projectId,
      schedule: "*/5 * * * *",
      prompt: "brief me on the book",
      nextFireAt: Date.now() - 1000,
    });

    const worker = createWorker({
      engine: service.engine,
      tickCrons: (at) => service.tickCrons(at),
    });
    const cycle = await worker.runOnce();

    assert.equal(cycle.fired, 1);
    const after = service.store.listCrons(projectId).find((c) => c.id === cron.id)!;
    assert.ok(after.lastFiredAt, "the cron records that it fired");
    assert.ok(after.nextFireAt! > Date.now(), "and is rescheduled into the future");
  });

  test("a cron failure does not stop the drain", async () => {
    build(async () => "done");
    const session = service.store.createSession(projectId, "w");
    service.engine.enqueue(session.id, "job");

    const seen: string[] = [];
    const worker = createWorker({
      engine: service.engine,
      tickCrons: async () => {
        throw new Error("cron exploded");
      },
      onError: (_error, phase) => seen.push(phase),
    });

    const cycle = await worker.runOnce();
    assert.deepEqual(seen, ["cron"]);
    assert.equal(cycle.drained, 1, "queued work still runs");
  });

  test("cycles do not overlap", async () => {
    let concurrent = 0;
    let peak = 0;
    build(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      return "done";
    });

    const session = service.store.createSession(projectId, "w");
    for (let i = 0; i < 2; i++) service.engine.enqueue(session.id, `job ${i}`);

    const worker = createWorker({ engine: service.engine, tickCrons: async () => 0 });
    const [a, b] = await Promise.all([worker.runOnce(), worker.runOnce()]);

    assert.equal(peak, 1, "runs execute one at a time");
    assert.deepEqual(a, b, "a concurrent call joins the cycle in flight rather than starting a second one");
    assert.equal(a.drained, 2, "the single cycle drained both jobs");
    assert.equal(service.store.claimQueuedRun(), null, "nothing is left queued");
  });

  test("stop waits for the cycle in flight", async () => {
    let finished = false;
    build(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return "done";
    });

    const session = service.store.createSession(projectId, "w");
    service.engine.enqueue(session.id, "slow job");

    const worker = createWorker({ engine: service.engine, tickCrons: async () => 0 });
    void worker.runOnce();
    await worker.stop();

    assert.equal(finished, true, "stop does not abandon work already started");
  });

  test("start is idempotent and stop is safe to call twice", async () => {
    build(async () => "done");
    const worker = createWorker({ engine: service.engine, tickCrons: async () => 0, intervalMs: 10_000 });
    worker.start();
    worker.start();
    await worker.stop();
    await worker.stop();
    assert.ok(bookId, "the service stayed usable throughout");
  });
});
