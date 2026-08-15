import { createAnthropicHarness } from "../../kernel/harness/anthropic.ts";
import { createTradingService } from "./service.ts";
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

const { port: bound, close } = await service.listen(port);
console.log(`[trading] listening on :${bound} (harness=${harness.id}, model=${useLiveModel ? "live" : "scripted"})`);

const cronTimer = setInterval(() => {
  service.tickCrons().catch((error: unknown) => console.error("[trading] cron tick failed:", error));
}, 30_000);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[trading] ${signal} received, shutting down`);
  clearInterval(cronTimer);
  void close()
    .catch((error: unknown) => console.error("[trading] close failed:", error))
    .finally(() => {
      service.close();
      process.exit(0);
    });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
