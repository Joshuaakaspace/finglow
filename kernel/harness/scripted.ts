import type { Harness, HarnessTurnInput, HarnessTurnResult } from "./harness.ts";

export interface ScriptStep {
  tool: string;
  input: Record<string, unknown> | ((prev: unknown[]) => Record<string, unknown>);
}

export interface ScriptedProgram {
  match: RegExp;
  steps: ScriptStep[];
  reply: string | ((results: unknown[], input: HarnessTurnInput) => string);
}

export interface ScriptedHarnessOptions {
  programs: ScriptedProgram[];
  fallbackReply?: string;
}

/**
 * Deterministic harness. Drives the same engine, tool, policy and verification
 * paths as a live model without needing an API key, so the whole backend is
 * testable end to end.
 */
export function createScriptedHarness(options: ScriptedHarnessOptions): Harness {
  return {
    id: "scripted",
    async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
      const program = options.programs.find((p) => p.match.test(input.prompt));
      if (!program) {
        return { reply: options.fallbackReply ?? `No scripted program matched: ${input.prompt}`, toolCallCount: 0 };
      }

      const results: unknown[] = [];
      for (const step of program.steps) {
        input.signal?.throwIfAborted();
        const stepInput = typeof step.input === "function" ? step.input(results) : step.input;
        const result = await input.callTool(step.tool, stepInput);
        results.push(result.output);
      }

      const reply = typeof program.reply === "function" ? program.reply(results, input) : program.reply;
      return { reply, toolCallCount: program.steps.length };
    },
  };
}
