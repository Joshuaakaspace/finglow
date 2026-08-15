import Anthropic from "@anthropic-ai/sdk";
import type { Harness, HarnessTurnInput, HarnessTurnResult } from "./harness.ts";
import { renderRepairFeedback, renderSkills } from "./harness.ts";
import type { Entry } from "../types.ts";

export interface AnthropicHarnessOptions {
  model?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxIterations?: number;
  client?: Anthropic;
}

const DEFAULT_MODEL = "claude-opus-5";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

type Block = Anthropic.Beta.BetaContentBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;

function historyToMessages(history: Entry[]): MessageParam[] {
  const messages: MessageParam[] = [];
  for (const entry of history) {
    if (entry.type === "user" && typeof entry.payload === "string") {
      messages.push({ role: "user", content: entry.payload });
    } else if (entry.type === "assistant" && typeof entry.payload === "string") {
      messages.push({ role: "assistant", content: entry.payload });
    }
  }
  return messages;
}

/**
 * The engine owns the tool ledger, the command policy and durable approvals: a
 * gated tool suspends the whole run to a database row and resumes it in a later
 * process. That lifecycle sits outside what the SDK tool runner's per-turn hooks
 * model, so this adapter drives the loop directly.
 */
export function createAnthropicHarness(options: AnthropicHarnessOptions = {}): Harness {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 16000;
  const effort = options.effort ?? "high";
  const maxIterations = options.maxIterations ?? 24;
  const client = options.client ?? new Anthropic();

  return {
    id: "anthropic",
    async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
      const system = [input.systemPrompt, renderSkills(input.skills), renderRepairFeedback(input.repairFindings ?? [])]
        .filter(Boolean)
        .join("");

      const tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: "object" as const,
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([key, description]) => [key, { type: "string", description }]),
          ),
        },
      }));

      const messages: MessageParam[] = [...historyToMessages(input.history), { role: "user", content: input.prompt }];

      let toolCallCount = 0;
      let reply = "";

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        input.signal?.throwIfAborted();

        const response = await client.beta.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages,
          tools,
          thinking: { type: "adaptive" },
          output_config: { effort },
          betas: [SERVER_SIDE_FALLBACK_BETA],
          fallbacks: "default",
        });

        if (response.stop_reason === "refusal") {
          const category = response.stop_details?.type === "refusal" ? response.stop_details.category : null;
          throw new Error(`model declined the request${category ? ` (${category})` : ""}`);
        }

        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "pause_turn") continue;

        const text = response.content
          .filter((b: Block): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) reply = text;

        const toolUses = response.content.filter(
          (b: Block): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
        );
        if (toolUses.length === 0) return { reply, toolCallCount };

        const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          toolCallCount++;
          const result = await input.callTool(use.name, (use.input ?? {}) as Record<string, unknown>);
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify(result.output),
            is_error: !result.ok,
          });
        }
        messages.push({ role: "user", content: toolResults });
      }

      return { reply: reply || "Stopped: reached the tool-call iteration limit.", toolCallCount };
    },
  };
}
