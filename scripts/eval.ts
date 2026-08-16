import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, loadCases, runEvalSuite, type EvalReport } from "../kernel/eval.ts";
import { createTradingService } from "../services/trading/service.ts";
import { createMarketingService } from "../services/marketing/service.ts";
import { seedTradingDemo } from "../services/trading/demo.ts";
import { seedMarketingDemo } from "../services/marketing/demo.ts";
import type { Harness } from "../kernel/harness/harness.ts";
import type { Verifier } from "../kernel/types.ts";

/** The suites judge verifiers against fixed output, so no model is involved. */
const inertHarness: Harness = {
  id: "inert",
  runTurn: async () => ({ reply: "", toolCallCount: 0 }),
};

const ROOT = new URL("..", import.meta.url).pathname;

interface Suite {
  name: string;
  verifiers: Verifier[];
  context: Record<string, string>;
  casesPath: string;
  close(): void;
}

function tradingSuite(workspace: string): Suite {
  const service = createTradingService({
    harness: inertHarness,
    databasePath: ":memory:",
    workspaceDir: join(workspace, "trading"),
  });
  const seeded = seedTradingDemo(service.store, service.domain);
  return {
    name: "trading",
    verifiers: service.engine.verifiers,
    context: { bookId: seeded.bookId, projectId: seeded.projectId },
    casesPath: join(ROOT, "evals", "trading.json"),
    close: () => service.close(),
  };
}

function marketingSuite(workspace: string): Suite {
  const service = createMarketingService({
    harness: inertHarness,
    databasePath: ":memory:",
    workspaceDir: join(workspace, "marketing"),
  });
  const seeded = seedMarketingDemo(service.store, service.domain);
  return {
    name: "marketing",
    verifiers: service.engine.verifiers,
    context: {
      brandId: seeded.brandId,
      projectId: seeded.projectId,
      xChannel: seeded.channels.x,
      liChannel: seeded.channels.linkedin,
      igChannel: seeded.channels.instagram,
    },
    casesPath: join(ROOT, "evals", "marketing.json"),
    close: () => service.close(),
  };
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const workspace = mkdtempSync(join(tmpdir(), "extpo-eval-"));
const reports: EvalReport[] = [];

try {
  const suites = [tradingSuite, marketingSuite]
    .map((build) => build(workspace))
    .filter((suite) => wanted.length === 0 || wanted.includes(suite.name));

  for (const suite of suites) {
    const cases = loadCases(suite.casesPath, suite.context);
    const report = await runEvalSuite(suite.name, suite.verifiers, cases);
    reports.push(report);
    console.log(formatReport(report));
    suite.close();
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

const total = reports.reduce((n, r) => n + r.total, 0);
const correct = reports.reduce((n, r) => n + r.correct, 0);
const falsePositives = reports.reduce((n, r) => n + r.falsePositives.length, 0);
const falseNegatives = reports.reduce((n, r) => n + r.falseNegatives.length, 0);

console.log(`\n${"═".repeat(78)}`);
console.log(
  `TOTAL ${correct}/${total} correct   ${falsePositives} false positive(s)   ${falseNegatives} false negative(s)`,
);
console.log("═".repeat(78));

if (correct !== total) {
  console.log("\nA false positive means the gate rejected output that was fine — the failure mode");
  console.log("that makes the system annoying rather than merely wrong. Fix those first.\n");
  process.exit(1);
}
