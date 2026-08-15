import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallRecord, VerificationInput } from "../../kernel/types.ts";

export function tempDir(prefix = "extpo-test-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

let seq = 0;

export function toolCall(tool: string, input: unknown, output: unknown, ok = true): ToolCallRecord {
  seq += 1;
  return {
    id: `tc_${seq}`,
    runId: "run_test",
    seq,
    tool,
    input,
    output,
    ok,
    durationMs: 1,
    createdAt: Date.now(),
  };
}

export function verificationInput(overrides: Partial<VerificationInput> = {}): VerificationInput {
  return {
    projectId: "prj_test",
    runId: "run_test",
    prompt: "",
    reply: "",
    toolCalls: [],
    artifacts: [],
    settings: {},
    ...overrides,
  };
}

export function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((f) => f.code).sort();
}
