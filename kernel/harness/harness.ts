import type { Entry, Finding, Skill, ToolDefinition } from "../types.ts";

export class ApprovalRequired extends Error {
  readonly approvalId: string;
  readonly tool: string;
  readonly approvalReason: string;

  constructor(approvalId: string, tool: string, approvalReason: string) {
    super(`approval required for ${tool}: ${approvalReason}`);
    this.name = "ApprovalRequired";
    this.approvalId = approvalId;
    this.tool = tool;
    this.approvalReason = approvalReason;
  }
}

/**
 * The command policy refused. The agent sees this as a failed tool call and may
 * adapt; it does not end the run.
 */
export class ToolDenied extends Error {
  readonly tool: string;
  readonly denyReason: string;

  constructor(tool: string, denyReason: string) {
    super(`tool ${tool} denied: ${denyReason}`);
    this.name = "ToolDenied";
    this.tool = tool;
    this.denyReason = denyReason;
  }
}

/** A human reviewed the gated call and said no. The run stops. */
export class ApprovalDenied extends Error {
  readonly tool: string;

  constructor(tool: string) {
    super(`a reviewer denied ${tool}`);
    this.name = "ApprovalDenied";
    this.tool = tool;
  }
}

export interface HarnessTurnInput {
  systemPrompt: string;
  prompt: string;
  history: Entry[];
  tools: ToolDefinition[];
  skills: Skill[];
  repairFindings?: Finding[];
  callTool(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; output: unknown }>;
  signal?: AbortSignal;
}

export interface HarnessTurnResult {
  reply: string;
  toolCallCount: number;
}

export interface Harness {
  readonly id: string;
  runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult>;
}

export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `### ${s.name}\n${s.description}\n\n${s.body.trim()}`);
  return `\n\n## Available procedures\n\n${lines.join("\n\n")}`;
}

export function renderRepairFeedback(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((f) => `- [${f.severity}] ${f.verifier}/${f.code}: ${f.message}`);
  return [
    "\n\n## Verification failed on your previous attempt",
    "The following checks blocked your output. Fix every one of them, then produce the deliverable again.",
    lines.join("\n"),
  ].join("\n");
}
