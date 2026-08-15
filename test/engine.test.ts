import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTradingService, type TradingService } from "../services/trading/service.ts";
import { seedTradingDemo } from "../services/trading/demo.ts";
import type { Harness, HarnessTurnInput } from "../kernel/harness/harness.ts";
import { tempDir } from "./support/helpers.ts";

type TurnFn = (input: HarnessTurnInput) => Promise<string>;

/** A harness whose behaviour the test controls turn by turn. */
function programmable(turn: TurnFn): Harness {
  return {
    id: "programmable",
    async runTurn(input) {
      return { reply: await turn(input), toolCallCount: 0 };
    },
  };
}

describe("engine", () => {
  let dir: { path: string; cleanup: () => void };
  let service: TradingService;
  let bookId: string;
  let sessionId: string;

  const build = (turn: TurnFn, maxRepairAttempts = 1): void => {
    service = createTradingService({
      harness: programmable(turn),
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
      maxRepairAttempts,
    });
    const seeded = seedTradingDemo(service.store, service.domain);
    bookId = seeded.bookId;
    sessionId = service.store.createSession(seeded.projectId, "test").id;
  };

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    service?.close();
    dir.cleanup();
  });

  test("a clean turn records the reply, the tool calls and a passing verification", async () => {
    build(async (input) => {
      const result = await input.callTool("reconcile", { book_id: bookId });
      const output = result.output as { break_count: number };
      return `The book has ${output.break_count} break against the custodian, on BBB.`;
    });

    const outcome = await service.engine.submit(sessionId, "reconcile the book");
    assert.equal(outcome.status, "ok");
    assert.match(outcome.reply!, /1 break/);

    const detail = service.store.listToolCalls(outcome.run.id);
    assert.equal(detail.length, 1);
    assert.equal(detail[0].tool, "reconcile");

    const verifications = service.store.listVerifications(outcome.run.id);
    assert.equal(verifications.at(-1)!.status, "pass");
  });

  test("a blocked output is retried with the findings and released once fixed", async () => {
    let attempts = 0;
    build(async (input) => {
      attempts++;
      await input.callTool("reconcile", { book_id: bookId });
      if (input.repairFindings && input.repairFindings.length > 0) {
        return "There is 1 break on BBB against the custodian.";
      }
      return "There is 1 break on BBB, worth about 8123.45 dollars.";
    });

    const outcome = await service.engine.submit(sessionId, "reconcile the book");
    assert.equal(attempts, 2, "the harness should have been asked to repair once");
    assert.equal(outcome.status, "ok");

    const verifications = service.store.listVerifications(outcome.run.id);
    assert.equal(verifications[0].status, "blocked");
    assert.equal(verifications[0].findings[0].code, "unsourced_number");
    assert.equal(verifications.at(-1)!.status, "pass");
    assert.equal(service.store.getRun(outcome.run.id)!.repairAttempts, 1);
  });

  test("an output that stays blocked after the repair budget ends as blocked", async () => {
    build(async (input) => {
      await input.callTool("reconcile", { book_id: bookId });
      return "The book ties out with no breaks.";
    });

    const outcome = await service.engine.submit(sessionId, "reconcile the book");
    assert.equal(outcome.status, "blocked");
    assert.ok(outcome.findings.some((f) => f.code === "false_clean_claim"));
    assert.equal(service.store.listVerifications(outcome.run.id).length, 2);
  });

  test("a gated tool suspends the run and resumes after approval", async () => {
    build(async (input) => {
      const result = await input.callTool("propose_trade", {
        book_id: bookId,
        symbol: "AAA",
        quantity: "10",
        price: "20",
      });
      const output = result.output as { notional: number };
      return `Proposed a trade with notional ${output.notional}, pending your approval.`;
    });

    const suspended = await service.engine.submit(sessionId, "propose a small add to AAA");
    assert.equal(suspended.status, "awaiting_approval");
    assert.equal(suspended.reply, null);

    const pending = service.store.listApprovals(suspended.run.id).filter((a) => a.status === "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tool, "propose_trade");

    service.store.decideApproval(pending[0].id, "approved", "risk@firm.test");
    const resumed = await service.engine.resume(suspended.run.id);
    assert.equal(resumed.status, "ok");
    assert.match(resumed.reply!, /pending your approval/);
  });

  test("a denied approval fails the run rather than proceeding", async () => {
    build(async (input) => {
      await input.callTool("propose_trade", { book_id: bookId, symbol: "AAA", quantity: "10", price: "20" });
      return "done";
    });

    const suspended = await service.engine.submit(sessionId, "propose a trade");
    const pending = service.store.listApprovals(suspended.run.id).filter((a) => a.status === "pending");
    service.store.decideApproval(pending[0].id, "denied", "risk@firm.test");

    const resumed = await service.engine.resume(suspended.run.id);
    assert.equal(resumed.status, "failed");
    assert.match(service.store.getRun(suspended.run.id)!.error!, /denied/);
  });

  test("a policy-denied command comes back as a tool error the agent can react to", async () => {
    let denialSeen: unknown = null;
    build(async (input) => {
      const result = await input.callTool("execute", { command: "rm -rf /" });
      denialSeen = result.output;
      const ok = await input.callTool("execute", { command: "echo 42" });
      const stdout = (ok.output as { stdout: string }).stdout.trim();
      return `The destructive command was refused. A safe one printed ${stdout}.`;
    });

    const outcome = await service.engine.submit(sessionId, "try something dangerous");
    assert.equal(outcome.status, "ok");
    assert.match(String((denialSeen as { denied_by?: string }).denied_by), /command_policy/);

    const calls = service.store.listToolCalls(outcome.run.id);
    assert.equal(calls[0].ok, false);
    assert.equal(calls[1].ok, true);
  });

  test("artifacts written during a run are recorded and readable", async () => {
    build(async (input) => {
      await input.callTool("write_file", { path: "reports/x.md", content: "# Report", kind: "report" });
      return "Report written.";
    });

    const outcome = await service.engine.submit(sessionId, "write a report");
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.artifacts.length, 1);
    assert.equal(outcome.artifacts[0].path, "reports/x.md");
    assert.equal(await service.sandbox.readFile(outcome.run.projectId, "reports/x.md"), "# Report");
  });

  test("a harness failure marks the run failed without losing the ledger", async () => {
    build(async (input) => {
      await input.callTool("reconcile", { book_id: bookId });
      throw new Error("model unavailable");
    });

    const outcome = await service.engine.submit(sessionId, "reconcile");
    assert.equal(outcome.status, "failed");
    assert.match(service.store.getRun(outcome.run.id)!.error!, /model unavailable/);
    assert.equal(service.store.listToolCalls(outcome.run.id).length, 1);
  });

  test("a lookahead-biased backtest is blocked before it can be reported", async () => {
    build(async (input) => {
      await input.callTool("write_file", {
        path: "bt.py",
        content: "df['target'] = df['close'].shift(-1)\nprint('sharpe', 2.1)",
        kind: "code",
      });
      return "The backtest is complete.";
    });

    const outcome = await service.engine.submit(sessionId, "run a backtest");
    assert.equal(outcome.status, "blocked");
    assert.ok(outcome.findings.some((f) => f.verifier === "lookahead-bias" && f.code === "negative_shift"));
  });
});
