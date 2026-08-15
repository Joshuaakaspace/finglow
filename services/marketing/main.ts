import { createAnthropicHarness } from "../../kernel/harness/anthropic.ts";
import { createMarketingService } from "./service.ts";
import { marketingDemoHarness, seedMarketingDemo } from "./demo.ts";
import type { Harness } from "../../kernel/harness/harness.ts";

const port = Number(process.env.PORT ?? 8082);
const useLiveModel = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.HARNESS !== "scripted";

let context = { brandId: "", channels: {} as Record<string, string> };
const harness: Harness = useLiveModel ? createAnthropicHarness() : marketingDemoHarness(() => context);

const service = createMarketingService({ harness });

if (service.store.listProjects().length === 0) {
  const seeded = seedMarketingDemo(service.store, service.domain);
  context = { brandId: seeded.brandId, channels: seeded.channels };
  console.log(`[marketing] seeded demo project ${seeded.projectId} brand ${seeded.brandId}`);
} else {
  const project = service.store.listProjects()[0];
  const brandId = String(project.settings.brandId ?? "");
  const channels: Record<string, string> = {};
  for (const channel of service.domain.listChannels(brandId)) channels[channel.platform] = channel.id;
  context = { brandId, channels };
}

const { port: bound, close } = await service.listen(port);
console.log(`[marketing] listening on :${bound} (harness=${harness.id}, model=${useLiveModel ? "live" : "scripted"})`);

const cronTimer = setInterval(() => {
  service.tickCrons().catch((error: unknown) => console.error("[marketing] cron tick failed:", error));
}, 30_000);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[marketing] ${signal} received, shutting down`);
  clearInterval(cronTimer);
  void close()
    .catch((error: unknown) => console.error("[marketing] close failed:", error))
    .finally(() => {
      service.close();
      process.exit(0);
    });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
