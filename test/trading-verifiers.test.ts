import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../kernel/db.ts";
import { createTradingDomain, type TradingDomain } from "../services/trading/domain.ts";
import { TRADING_SCHEMA } from "../services/trading/schema.ts";
import {
  lookaheadBiasVerifier,
  noExecutionClaimVerifier,
  numericProvenanceVerifier,
  reconciliationVerifier,
  riskLimitVerifier,
} from "../services/trading/verifiers.ts";
import { codes, toolCall, verificationInput } from "./support/helpers.ts";

function freshDomain(): TradingDomain {
  return createTradingDomain(openDatabase(":memory:", TRADING_SCHEMA));
}

describe("numeric-provenance", () => {
  const verifier = numericProvenanceVerifier();

  test("passes when every figure came out of a tool result", () => {
    const findings = verifier.run(
      verificationInput({
        reply: "Gross exposure is 128450.75 across 3 positions.",
        toolCalls: [toolCall("risk_limits", {}, { gross_exposure: 128450.75, positions: 3 })],
      }),
    );
    assert.deepEqual(findings, []);
  });

  test("blocks a figure no tool produced", () => {
    const findings = verifier.run(
      verificationInput({
        reply: "Gross exposure is 128450.75 and the Sharpe ratio is 1.84.",
        toolCalls: [toolCall("risk_limits", {}, { gross_exposure: 128450.75 })],
      }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "block");
    assert.equal(findings[0].code, "unsourced_number");
    assert.match(findings[0].message, /1\.84/);
  });

  test("accepts numbers printed to stdout by a script", () => {
    const findings = verifier.run(
      verificationInput({
        reply: "The strategy returned 14.2% with a maximum drawdown of 8.7%.",
        toolCalls: [
          toolCall("execute", { command: "python3 bt.py" }, { stdout: "return=14.2\nmax_drawdown=8.7\n", exit_code: 0 }),
        ],
      }),
    );
    assert.deepEqual(findings, []);
  });

  test("accepts presentation rounding and ratio/percent restatement", () => {
    const findings = verifier.run(
      verificationInput({
        reply: "Engagement was 4.5% against a book value of 1234.57.",
        toolCalls: [toolCall("execute", {}, { stdout: "rate=0.045\nvalue=1234.5678\n" })],
      }),
    );
    assert.deepEqual(findings, []);
  });

  test("does not flag small counts, years, or numbers echoed from the prompt", () => {
    const findings = verifier.run(
      verificationInput({
        prompt: "Reconcile book 8891 for 2026.",
        reply: "I checked 4 positions for 2026 in book 8891 and found 2 breaks.",
        toolCalls: [toolCall("reconcile", {}, { break_count: 2 })],
      }),
    );
    assert.deepEqual(findings, []);
  });
});

describe("lookahead-bias", () => {
  const verifier = lookaheadBiasVerifier();

  const check = (source: string) =>
    verifier.run(verificationInput({ artifacts: [{ path: "bt.py", kind: "code", content: source }] }));

  test("passes correctly lagged code", () => {
    assert.deepEqual(
      check("signal = df['close'].rolling(20).mean().shift(1)\ndf = df.ffill()"),
      [],
    );
  });

  test("blocks a negative shift", () => {
    const findings = check("df['target'] = df['close'].shift(-1)");
    assert.deepEqual(codes(findings), ["negative_shift"]);
    assert.equal(findings[0].severity, "block");
  });

  test("blocks backward fill", () => {
    assert.deepEqual(codes(check("df = df.bfill()")), ["backward_fill"]);
    assert.deepEqual(codes(check("df.fillna(method='backfill')")), ["backward_fill"]);
  });

  test("blocks a shuffled split on a time series", () => {
    assert.deepEqual(codes(check("X_tr, X_te = train_test_split(X, y, shuffle=True)")), ["shuffled_split"]);
  });

  test("blocks forward indexing", () => {
    assert.deepEqual(codes(check("pnl = close[i + 1] - close[i]")), ["forward_index"]);
  });

  test("warns on a whole-sample threshold but allows a rolling one", () => {
    const findings = check("threshold = df['close'].mean()");
    assert.deepEqual(codes(findings), ["full_series_statistic"]);
    assert.equal(findings[0].severity, "warn");
    assert.deepEqual(check("threshold = df['close'].rolling(50).mean()"), []);
  });

  test("also inspects commands run through execute", () => {
    const findings = verifier.run(
      verificationInput({
        toolCalls: [toolCall("execute", { command: "python3 -c \"df['x'].shift(-2)\"" }, { exit_code: 0 })],
      }),
    );
    assert.deepEqual(codes(findings), ["negative_shift"]);
  });
});

describe("reconciliation-tie-out", () => {
  let domain: TradingDomain;
  let bookId: string;

  beforeEach(() => {
    domain = freshDomain();
    bookId = domain.createBook("prj", "Core").id;
    domain.setPosition({ bookId, symbol: "AAA", quantity: 100, avgPrice: 10 });
    domain.setPosition({ bookId, symbol: "BBB", quantity: 50, avgPrice: 20 });
    domain.setCustodianPosition({ bookId, symbol: "AAA", quantity: 100, asOf: 0 });
    domain.setCustodianPosition({ bookId, symbol: "BBB", quantity: 40, asOf: 0 });
  });

  test("blocks a clean-book claim that the data contradicts", () => {
    const findings = reconciliationVerifier(domain).run(
      verificationInput({ reply: "The book ties out with no breaks.", settings: { bookId } }),
    );
    assert.ok(findings.some((f) => f.code === "false_clean_claim" && f.severity === "block"));
  });

  test("blocks a wrong break count", () => {
    const findings = reconciliationVerifier(domain).run(
      verificationInput({ reply: "Found 3 breaks against the custodian, including BBB.", settings: { bookId } }),
    );
    assert.ok(findings.some((f) => f.code === "break_count_mismatch" && f.severity === "block"));
  });

  test("passes an accurate report", () => {
    const findings = reconciliationVerifier(domain).run(
      verificationInput({ reply: "There is 1 break: BBB is out by 10 shares.", settings: { bookId } }),
    );
    assert.deepEqual(findings, []);
  });

  test("warns when a real break goes unmentioned", () => {
    const findings = reconciliationVerifier(domain).run(
      verificationInput({ reply: "Checked the book; 1 break needs review.", settings: { bookId } }),
    );
    assert.deepEqual(codes(findings), ["unreported_break"]);
    assert.equal(findings[0].severity, "warn");
  });

  test("accepts a genuinely clean book", () => {
    domain.setCustodianPosition({ bookId, symbol: "BBB", quantity: 50, asOf: 0 });
    const findings = reconciliationVerifier(domain).run(
      verificationInput({ reply: "The book ties out with no breaks.", settings: { bookId } }),
    );
    assert.deepEqual(findings, []);
  });
});

describe("risk-limits", () => {
  let domain: TradingDomain;
  let bookId: string;

  beforeEach(() => {
    domain = freshDomain();
    bookId = domain.createBook("prj", "Core").id;
    domain.setPosition({ bookId, symbol: "AAA", quantity: 100, avgPrice: 10 });
    domain.setRiskLimits({ bookId, maxGrossExposure: 10_000, maxPositionPct: 0.5, maxSymbols: 3 });
  });

  const proposal = (symbol: string, quantity: number, price: number) =>
    toolCall("propose_trade", { book_id: bookId }, { book_id: bookId, symbol, quantity, price });

  test("passes a trade inside every limit", () => {
    const findings = riskLimitVerifier(domain).run(verificationInput({ toolCalls: [proposal("BBB", 50, 20)] }));
    assert.deepEqual(findings, []);
  });

  test("blocks a gross-exposure breach", () => {
    const findings = riskLimitVerifier(domain).run(verificationInput({ toolCalls: [proposal("BBB", 1000, 50)] }));
    assert.ok(findings.some((f) => f.code === "gross_exposure_breach" && f.severity === "block"));
  });

  test("blocks a concentration breach", () => {
    const findings = riskLimitVerifier(domain).run(verificationInput({ toolCalls: [proposal("BBB", 100, 40)] }));
    assert.ok(findings.some((f) => f.code === "concentration_breach"));
  });

  test("blocks exceeding the symbol count", () => {
    const findings = riskLimitVerifier(domain).run(
      verificationInput({
        toolCalls: [proposal("BBB", 10, 5), proposal("CCC", 10, 5), proposal("DDD", 10, 5)],
      }),
    );
    assert.ok(findings.some((f) => f.code === "symbol_count_breach"));
  });

  test("refuses to propose against a book with no configured limits", () => {
    const other = domain.createBook("prj", "Unlimited").id;
    const findings = riskLimitVerifier(domain).run(
      verificationInput({
        toolCalls: [toolCall("propose_trade", { book_id: other }, { book_id: other, symbol: "AAA", quantity: 1, price: 1 })],
      }),
    );
    assert.deepEqual(codes(findings), ["limits_missing"]);
  });

  test("stays silent when no trade was proposed", () => {
    assert.deepEqual(riskLimitVerifier(domain).run(verificationInput({ settings: { bookId } })), []);
  });
});

describe("no-execution-claim", () => {
  const verifier = noExecutionClaimVerifier();

  test("blocks a claim that an order was placed", () => {
    for (const reply of [
      "I placed the order for 100 AAA.",
      "Order submitted to the broker.",
      "The trade executed at 10.15.",
    ]) {
      const findings = verifier.run(verificationInput({ reply }));
      assert.equal(findings.length, 1, reply);
      assert.equal(findings[0].severity, "block");
    }
  });

  test("allows correctly framed proposals", () => {
    const findings = verifier.run(
      verificationInput({ reply: "I have proposed buying 100 AAA; it is pending your approval." }),
    );
    assert.deepEqual(findings, []);
  });
});
