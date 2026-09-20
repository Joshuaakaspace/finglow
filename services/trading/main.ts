import { createAnthropicHarness } from "../../kernel/harness/anthropic.ts";
import { createTradingService } from "./service.ts";
import { createWorker } from "../../kernel/worker.ts";
import { seedTradingDemo, tradingDemoHarness } from "./demo.ts";
import type { Harness } from "../../kernel/harness/harness.ts";

const port = Number(process.env.PORT ?? 8081);
const useLiveModel = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.HARNESS !== "scripted";

let bookId = "";
const harness: Harness = useLiveModel ? createAnthropicHarness() : tradingDemoHarness(() => bookId);

const service = createTradingService({ harness });

if (service.store.listProjects().length === 0) {
  const seeded = seedTradingDemo(service.store, service.domain);
  bookId = seeded.bookId;
  console.log(`[trading] seeded demo project ${seeded.projectId} book ${seeded.bookId}`);
} else {
  const project = service.store.listProjects()[0];
  bookId = String(project.settings.bookId ?? "");
}

const bootstrap = service.ensureBootstrapKey(process.env.BOOTSTRAP_OWNER ?? "admin@local");
if (bootstrap) {
  console.log(`[trading] no API keys existed; minted an admin key (shown once): ${bootstrap.key}`);
}

const { port: bound, close } = await service.listen(port);
console.log(`[trading] listening on :${bound} (harness=${harness.id}, model=${useLiveModel ? "live" : "scripted"})`);

const worker = createWorker({
  engine: service.engine,
  tickCrons: (at) => service.tickCrons(at),
  intervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 15_000),
  onError: (error, phase) => console.error(`[trading] worker ${phase} failed:`, error),
});
service.onWorkQueued(() => void worker.runOnce());
worker.start();

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[trading] ${signal} received, shutting down`);
  void worker.stop();
  void close()
    .catch((error: unknown) => console.error("[trading] close failed:", error))
    .finally(() => {
      service.close();
      process.exit(0);
    });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
