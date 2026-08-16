import { readFileSync } from "node:fs";
import type { Finding, ProposedArtifact, ToolCallRecord, VerificationInput, Verifier } from "./types.ts";
import { runVerification } from "./verify.ts";

/**
 * A labelled example of agent output. `should_pass` cases are correct replies
 * that must survive the gate; `should_block` cases are the failure modes the
 * gate exists to catch. Together they measure precision and recall of the
 * verification layer itself — the part a better model does not replace.
 */
export interface EvalCase {
  id: string;
  label: "should_pass" | "should_block";
  prompt: string;
  reply: string;
  toolCalls?: Array<{ tool: string; input?: unknown; output: unknown; ok?: boolean }>;
  artifacts?: ProposedArtifact[];
  settings?: Record<string, unknown>;
  /** Finding codes this case must produce. Only meaningful for should_block. */
  expectCodes?: string[];
  note?: string;
}

export interface CaseResult {
  id: string;
  label: EvalCase["label"];
  blocked: boolean;
  correct: boolean;
  findings: Finding[];
  missingCodes: string[];
  note?: string;
}

export interface VerifierStats {
  blocks: number;
  warns: number;
  /** Blocks raised against a case that should have passed. */
  falseBlocks: number;
}

export interface EvalReport {
  suite: string;
  total: number;
  correct: number;
  falsePositives: CaseResult[];
  falseNegatives: CaseResult[];
  missedCodes: CaseResult[];
  /** Of the cases that should block, the share that did. */
  recall: number;
  /** Of the cases that were blocked, the share that should have been. */
  precision: number;
  /** Of correct replies, the share the gate wrongly rejected. */
  falsePositiveRate: number;
  byVerifier: Record<string, VerifierStats>;
  cases: CaseResult[];
  durationMs: number;
}

/** Replace `{{key}}` placeholders anywhere in a case with runtime identifiers. */
export function substitute<T>(value: T, context: Record<string, string>): T {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => context[key] ?? whole) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, context)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, context)]),
    ) as unknown as T;
  }
  return value;
}

export function loadCases(path: string, context: Record<string, string> = {}): EvalCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const cases: EvalCase[] = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases)) throw new Error(`${path} does not contain a case array`);

  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) throw new Error(`${path}: duplicate case id "${testCase.id}"`);
    seen.add(testCase.id);
  }
  return cases.map((testCase) => substitute(testCase, context));
}

function toRecords(testCase: EvalCase): ToolCallRecord[] {
  return (testCase.toolCalls ?? []).map((call, index) => ({
    id: `${testCase.id}-tc${index + 1}`,
    runId: testCase.id,
    seq: index + 1,
    tool: call.tool,
    input: call.input ?? {},
    output: call.output,
    ok: call.ok ?? true,
    durationMs: 0,
    createdAt: 0,
  }));
}

export async function runEvalSuite(suite: string, verifiers: Verifier[], cases: EvalCase[]): Promise<EvalReport> {
  const startedAt = Date.now();
  const results: CaseResult[] = [];
  const byVerifier: Record<string, VerifierStats> = {};

  for (const verifier of verifiers) byVerifier[verifier.name] = { blocks: 0, warns: 0, falseBlocks: 0 };

  for (const testCase of cases) {
    const input: VerificationInput = {
      projectId: "eval",
      runId: testCase.id,
      prompt: testCase.prompt,
      reply: testCase.reply,
      toolCalls: toRecords(testCase),
      artifacts: testCase.artifacts ?? [],
      settings: testCase.settings ?? {},
    };

    const outcome = await runVerification(verifiers, input);
    const blocked = outcome.status === "blocked";
    const shouldBlock = testCase.label === "should_block";

    const raisedCodes = new Set(outcome.findings.map((f) => f.code));
    const missingCodes = (testCase.expectCodes ?? []).filter((code) => !raisedCodes.has(code));

    for (const found of outcome.findings) {
      const stats = (byVerifier[found.verifier] ??= { blocks: 0, warns: 0, falseBlocks: 0 });
      if (found.severity === "block") {
        stats.blocks++;
        if (!shouldBlock) stats.falseBlocks++;
      } else if (found.severity === "warn") {
        stats.warns++;
      }
    }

    results.push({
      id: testCase.id,
      label: testCase.label,
      blocked,
      correct: blocked === shouldBlock && missingCodes.length === 0,
      findings: outcome.findings,
      missingCodes,
      note: testCase.note,
    });
  }

  const shouldBlockCases = results.filter((r) => r.label === "should_block");
  const shouldPassCases = results.filter((r) => r.label === "should_pass");
  const blockedCount = results.filter((r) => r.blocked).length;
  const trueBlocks = shouldBlockCases.filter((r) => r.blocked).length;
  const falsePositives = shouldPassCases.filter((r) => r.blocked);
  const falseNegatives = shouldBlockCases.filter((r) => !r.blocked);

  return {
    suite,
    total: results.length,
    correct: results.filter((r) => r.correct).length,
    falsePositives,
    falseNegatives,
    missedCodes: results.filter((r) => r.blocked === (r.label === "should_block") && r.missingCodes.length > 0),
    recall: shouldBlockCases.length === 0 ? 1 : trueBlocks / shouldBlockCases.length,
    precision: blockedCount === 0 ? 1 : trueBlocks / blockedCount,
    falsePositiveRate: shouldPassCases.length === 0 ? 0 : falsePositives.length / shouldPassCases.length,
    byVerifier,
    cases: results,
    durationMs: Date.now() - startedAt,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`\n${report.suite}  —  ${report.correct}/${report.total} correct  (${report.durationMs}ms)`);
  lines.push(
    `  recall ${pct(report.recall)}   precision ${pct(report.precision)}   false-positive rate ${pct(report.falsePositiveRate)}`,
  );

  const names = Object.keys(report.byVerifier).sort();
  const width = Math.max(...names.map((n) => n.length), 8);
  lines.push(`  ${"verifier".padEnd(width)}  blocks  warns  false-blocks`);
  for (const name of names) {
    const s = report.byVerifier[name];
    lines.push(
      `  ${name.padEnd(width)}  ${String(s.blocks).padStart(6)}  ${String(s.warns).padStart(5)}  ${String(s.falseBlocks).padStart(12)}`,
    );
  }

  const problems: Array<[string, CaseResult[]]> = [
    ["FALSE POSITIVE (correct output was blocked)", report.falsePositives],
    ["FALSE NEGATIVE (bad output got through)", report.falseNegatives],
    ["WRONG REASON (blocked, but not for the expected finding)", report.missedCodes],
  ];

  for (const [heading, group] of problems) {
    if (group.length === 0) continue;
    lines.push(`\n  ${heading}:`);
    for (const result of group) {
      lines.push(`    ${result.id}${result.note ? ` — ${result.note}` : ""}`);
      for (const f of result.findings.filter((x) => x.severity === "block")) {
        lines.push(`        raised ${f.verifier}/${f.code}: ${f.message.slice(0, 110)}`);
      }
      for (const code of result.missingCodes) lines.push(`        expected but missing: ${code}`);
    }
  }

  return lines.join("\n");
}
