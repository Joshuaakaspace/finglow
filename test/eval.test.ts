import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, runEvalSuite, substitute, formatReport, type EvalCase } from "../kernel/eval.ts";
import { createTradingService } from "../services/trading/service.ts";
import { createMarketingService } from "../services/marketing/service.ts";
import { seedTradingDemo } from "../services/trading/demo.ts";
import { seedMarketingDemo } from "../services/marketing/demo.ts";
import { tempDir } from "./support/helpers.ts";
import type { Harness } from "../kernel/harness/harness.ts";
import type { Verifier } from "../kernel/types.ts";

const ROOT = new URL("..", import.meta.url).pathname;

const inert: Harness = { id: "inert", runTurn: async () => ({ reply: "", toolCallCount: 0 }) };

const alwaysBlocks: Verifier = {
  name: "always",
  description: "",
  run: () => [{ verifier: "always", severity: "block", code: "nope", message: "no" }],
};
const neverBlocks: Verifier = { name: "never", description: "", run: () => [] };

function makeCase(id: string, label: EvalCase["label"]): EvalCase {
  return { id, label, prompt: "p", reply: "r" };
}

describe("eval placeholder substitution", () => {
  test("replaces placeholders throughout a nested case", () => {
    const result = substitute(
      { a: "{{id}}", b: ["x{{id}}", { c: "{{other}}" }], n: 5 },
      { id: "book_1", other: "chan_2" },
    );
    assert.deepEqual(result, { a: "book_1", b: ["xbook_1", { c: "chan_2" }], n: 5 });
  });

  test("leaves unknown placeholders alone rather than blanking them", () => {
    assert.equal(substitute("{{missing}}", {}), "{{missing}}");
  });
});

describe("eval corpus loading", () => {
  test("rejects duplicate case ids", () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, "dupes.json");
      writeFileSync(
        path,
        JSON.stringify({ cases: [makeCase("same", "should_pass"), makeCase("same", "should_block")] }),
      );
      assert.throws(() => loadCases(path), /duplicate case id/);
    } finally {
      dir.cleanup();
    }
  });
});

describe("eval scoring", () => {
  test("scores a perfect gate", async () => {
    const report = await runEvalSuite("t", [neverBlocks], [makeCase("a", "should_pass")]);
    assert.equal(report.correct, 1);
    assert.equal(report.falsePositives.length, 0);
    assert.equal(report.falsePositiveRate, 0);
  });

  test("counts a false positive when correct output is blocked", async () => {
    const report = await runEvalSuite("t", [alwaysBlocks], [makeCase("a", "should_pass")]);
    assert.equal(report.correct, 0);
    assert.equal(report.falsePositives.length, 1);
    assert.equal(report.falsePositiveRate, 1);
    assert.equal(report.byVerifier.always.falseBlocks, 1);
  });

  test("counts a false negative when bad output survives", async () => {
    const report = await runEvalSuite("t", [neverBlocks], [makeCase("a", "should_block")]);
    assert.equal(report.falseNegatives.length, 1);
    assert.equal(report.recall, 0);
  });

  test("computes precision and recall over a mixed corpus", async () => {
    const report = await runEvalSuite("t", [alwaysBlocks], [
      makeCase("bad1", "should_block"),
      makeCase("bad2", "should_block"),
      makeCase("good", "should_pass"),
    ]);
    assert.equal(report.recall, 1);
    assert.equal(report.precision, 2 / 3);
    assert.equal(report.falsePositiveRate, 1);
  });

  test("a case blocked for the wrong reason is not counted correct", async () => {
    const report = await runEvalSuite("t", [alwaysBlocks], [
      { ...makeCase("a", "should_block"), expectCodes: ["some_other_code"] },
    ]);
    assert.equal(report.correct, 0);
    assert.equal(report.missedCodes.length, 1);
    assert.deepEqual(report.missedCodes[0].missingCodes, ["some_other_code"]);
  });

  test("formats a report without throwing on an empty verifier set", () => {
    assert.match(formatReport({
      suite: "s",
      total: 0,
      correct: 0,
      falsePositives: [],
      falseNegatives: [],
      missedCodes: [],
      recall: 1,
      precision: 1,
      falsePositiveRate: 0,
      byVerifier: {},
      cases: [],
      durationMs: 0,
    }), /0\/0 correct/);
  });
});

describe("shipped corpora", () => {
  test("the trading corpus scores 100% against the trading verifiers", async () => {
    const dir = tempDir();
    const service = createTradingService({
      harness: inert,
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    try {
      const seeded = seedTradingDemo(service.store, service.domain);
      const cases = loadCases(join(ROOT, "evals", "trading.json"), { bookId: seeded.bookId });
      assert.ok(cases.length >= 20, "corpus should be substantial");

      const report = await runEvalSuite("trading", service.engine.verifiers, cases);
      assert.equal(report.falsePositives.length, 0, formatReport(report));
      assert.equal(report.falseNegatives.length, 0, formatReport(report));
      assert.equal(report.correct, report.total, formatReport(report));
    } finally {
      service.close();
      dir.cleanup();
    }
  });

  test("the marketing corpus scores 100% against the marketing verifiers", async () => {
    const dir = tempDir();
    const service = createMarketingService({
      harness: inert,
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    try {
      const seeded = seedMarketingDemo(service.store, service.domain);
      const cases = loadCases(join(ROOT, "evals", "marketing.json"), {
        brandId: seeded.brandId,
        xChannel: seeded.channels.x,
        liChannel: seeded.channels.linkedin,
        igChannel: seeded.channels.instagram,
      });
      assert.ok(cases.length >= 18, "corpus should be substantial");

      const report = await runEvalSuite("marketing", service.engine.verifiers, cases);
      assert.equal(report.falsePositives.length, 0, formatReport(report));
      assert.equal(report.falseNegatives.length, 0, formatReport(report));
      assert.equal(report.correct, report.total, formatReport(report));
    } finally {
      service.close();
      dir.cleanup();
    }
  });
});

describe("date handling in numeric provenance", () => {
  test("a date in the reply is not read as a numeric claim", async () => {
    const dir = tempDir();
    const service = createTradingService({
      harness: inert,
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    try {
      for (const reply of [
        "As of 2026-08-15 the book has 1 break.",
        "As of 15/08/2026 the book has 1 break.",
        "Run at 09:45 the book has 1 break.",
      ]) {
        const report = await runEvalSuite("t", service.engine.verifiers, [
          {
            id: reply,
            label: "should_pass",
            prompt: "reconcile",
            reply,
            toolCalls: [{ tool: "reconcile", output: { break_count: 1 } }],
          },
        ]);
        assert.equal(report.falsePositives.length, 0, `blocked: ${reply}`);
      }
    } finally {
      service.close();
      dir.cleanup();
    }
  });
});
