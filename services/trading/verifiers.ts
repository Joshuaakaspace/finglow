import type { Finding, SyncVerifier, ToolCallRecord, VerificationInput, Verifier } from "../../kernel/types.ts";
import { finding } from "../../kernel/verify.ts";
import type { TradingDomain } from "./domain.ts";

const NUMBER_TOKEN = /-?\d[\d,]*(?:\.\d+)?/g;

function normalizeNumber(token: string): number {
  return Number(token.replace(/,/g, ""));
}

/** Numbers a reply may state without a computation behind them. */
function isExemptClaim(value: number, raw: string, prompt: string): boolean {
  if (!Number.isFinite(value)) return true;
  if (prompt.includes(raw)) return true;
  if (Number.isInteger(value) && Math.abs(value) <= 12) return true;
  if (Number.isInteger(value) && value >= 1900 && value <= 2100) return true;
  return false;
}

function collectNumbers(value: unknown, into: Set<number>, depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) into.add(value);
    return;
  }
  if (typeof value === "string") {
    for (const token of value.match(NUMBER_TOKEN) ?? []) {
      const n = normalizeNumber(token);
      if (Number.isFinite(n)) into.add(n);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, into, depth + 1);
  }
}

function sourcedNumbers(toolCalls: ToolCallRecord[]): Set<number> {
  const numbers = new Set<number>();
  for (const call of toolCalls) collectNumbers(call.output, numbers);
  return numbers;
}

function matchesSource(claim: number, sources: Set<number>): boolean {
  if (sources.has(claim)) return true;
  const tolerance = Math.max(Math.abs(claim) * 0.005, 1e-9);
  for (const source of sources) {
    if (Math.abs(source - claim) <= tolerance) return true;
    // A percentage stated against a ratio, or vice versa.
    if (Math.abs(source * 100 - claim) <= Math.max(Math.abs(claim) * 0.005, 1e-9)) return true;
    if (Math.abs(source / 100 - claim) <= Math.max(Math.abs(claim) * 0.005, 1e-9)) return true;
    // A figure rounded for presentation.
    if (Math.abs(Math.round(source * 100) / 100 - claim) <= 1e-9) return true;
    if (Math.abs(Math.round(source) - claim) <= 1e-9) return true;
  }
  return false;
}

/**
 * The rule the whole service is built around: the agent never produces a
 * number, it produces code that produces the number. Every figure in a reply
 * must be traceable to a recorded tool result.
 */
export function numericProvenanceVerifier(): SyncVerifier {
  return {
    name: "numeric-provenance",
    description: "Every number in the reply must trace to a recorded tool result.",
    run(input: VerificationInput): Finding[] {
      const sources = sourcedNumbers(input.toolCalls);
      const seen = new Set<string>();
      const unsourced: string[] = [];

      for (const token of input.reply.match(NUMBER_TOKEN) ?? []) {
        if (seen.has(token)) continue;
        seen.add(token);
        const value = normalizeNumber(token);
        if (isExemptClaim(value, token, input.prompt)) continue;
        if (!matchesSource(value, sources)) unsourced.push(token);
      }

      if (unsourced.length === 0) return [];
      return [
        finding(
          "numeric-provenance",
          "block",
          "unsourced_number",
          `The reply states ${unsourced.length} number(s) that no tool result produced: ${unsourced.join(", ")}. ` +
            "Compute every figure with a tool and quote the computed value, or remove the claim.",
          { unsourced, sourceCount: sources.size },
        ),
      ];
    },
  };
}

interface LookaheadRule {
  pattern: RegExp;
  code: string;
  severity: Finding["severity"];
  message: string;
}

const LOOKAHEAD_RULES: LookaheadRule[] = [
  {
    pattern: /\.shift\(\s*-\s*\d+/,
    code: "negative_shift",
    severity: "block",
    message: "`.shift(-n)` pulls future rows into the current row.",
  },
  {
    pattern: /\.(bfill|backfill)\s*\(|method\s*=\s*['"](bfill|backfill)['"]/,
    code: "backward_fill",
    severity: "block",
    message: "Backward filling propagates future values into earlier bars.",
  },
  {
    pattern: /train_test_split\s*\([^)]*shuffle\s*=\s*True/s,
    code: "shuffled_split",
    severity: "block",
    message: "A shuffled split on a time series leaks future observations into training.",
  },
  {
    pattern: /\[\s*i\s*\+\s*[1-9]\d*\s*\]|\.iloc\[\s*[a-z_]+\s*\+\s*[1-9]\d*\s*\]/,
    code: "forward_index",
    severity: "block",
    message: "Indexing forward from the current bar reads data that did not exist yet.",
  },
  {
    pattern: /^(?![^\n]*rolling)(?![^\n]*expanding)[^\n]*\b(signal|threshold|entry|zscore|z_score)\b[^\n]*=[^\n]*\.(max|min|mean|std|quantile)\s*\(\s*\)/m,
    code: "full_series_statistic",
    severity: "warn",
    message: "A whole-series statistic used as a signal threshold sees the entire sample, including the future.",
  },
  {
    pattern: /\.sort_values\s*\([^)]*\b(future|forward|next)_?\w*\breturn/s,
    code: "future_return_sort",
    severity: "block",
    message: "Ranking on a forward return selects on information from the future.",
  },
];

function isCode(path: string, kind: string): boolean {
  return kind === "code" || /\.(py|ipynb|sql|r|js|ts)$/i.test(path);
}

/** Static checks on backtest code for the errors that make a backtest lie. */
export function lookaheadBiasVerifier(): SyncVerifier {
  return {
    name: "lookahead-bias",
    description: "Reject backtest code that reads data unavailable at the simulated decision time.",
    run(input: VerificationInput): Finding[] {
      const findings: Finding[] = [];
      const bodies: Array<{ label: string; source: string }> = [];

      for (const artifact of input.artifacts) {
        if (isCode(artifact.path, artifact.kind)) bodies.push({ label: artifact.path, source: artifact.content });
      }
      for (const call of input.toolCalls) {
        const command = (call.input as { command?: unknown } | null)?.command;
        if (call.tool === "execute" && typeof command === "string") {
          bodies.push({ label: `execute#${call.seq}`, source: command });
        }
      }

      for (const body of bodies) {
        for (const rule of LOOKAHEAD_RULES) {
          const match = body.source.match(rule.pattern);
          if (!match) continue;
          findings.push(
            finding("lookahead-bias", rule.severity, rule.code, `${body.label}: ${rule.message}`, {
              excerpt: match[0].slice(0, 200),
            }),
          );
        }
      }
      return findings;
    },
  };
}

const RECONCILED_CLAIM =
  /\b(no breaks|zero breaks|fully reconcil\w+|reconcil\w+ cleanly|ties? out|balanced|matches the custodian|in agreement)\b/i;

/**
 * Recompute the tie-out from the database and compare it against what the
 * agent said. A claim of "reconciled" that the data contradicts is blocked.
 */
export function reconciliationVerifier(domain: TradingDomain): SyncVerifier {
  return {
    name: "reconciliation-tie-out",
    description: "Independently recompute position breaks and check the reply against them.",
    run(input: VerificationInput): Finding[] {
      const bookId = resolveBookId(input);
      if (!bookId) return [];

      const actual = domain.reconcile(bookId);
      const findings: Finding[] = [];

      if (RECONCILED_CLAIM.test(input.reply) && actual.breaks.length > 0) {
        findings.push(
          finding(
            "reconciliation-tie-out",
            "block",
            "false_clean_claim",
            `The reply reports a clean reconciliation but the book has ${actual.breaks.length} break(s): ` +
              `${actual.breaks.map((b) => `${b.symbol} ${b.difference > 0 ? "+" : ""}${b.difference}`).join(", ")}.`,
            { breaks: actual.breaks },
          ),
        );
      }

      const claimedCount = input.reply.match(/\b(\d+)\s+break/i);
      if (claimedCount && Number(claimedCount[1]) !== actual.breaks.length) {
        findings.push(
          finding(
            "reconciliation-tie-out",
            "block",
            "break_count_mismatch",
            `The reply states ${claimedCount[1]} break(s); the book has ${actual.breaks.length}.`,
            { claimed: Number(claimedCount[1]), actual: actual.breaks.length },
          ),
        );
      }

      for (const b of actual.breaks) {
        if (!input.reply.includes(b.symbol)) {
          findings.push(
            finding(
              "reconciliation-tie-out",
              "warn",
              "unreported_break",
              `${b.symbol} breaks by ${b.difference} but is not named in the reply.`,
              b,
            ),
          );
        }
      }
      return findings;
    },
  };
}

function resolveBookId(input: VerificationInput): string | null {
  for (const call of input.toolCalls) {
    const bookId = (call.input as { book_id?: unknown } | null)?.book_id;
    if (typeof bookId === "string" && bookId) return bookId;
  }
  const fromSettings = input.settings.bookId;
  return typeof fromSettings === "string" && fromSettings ? fromSettings : null;
}

interface Proposal {
  symbol: string;
  quantity: number;
  price: number;
}

function proposalsFrom(toolCalls: ToolCallRecord[]): { bookId: string | null; proposals: Proposal[] } {
  let bookId: string | null = null;
  const proposals: Proposal[] = [];
  for (const call of toolCalls) {
    if (call.tool !== "propose_trade" || !call.ok) continue;
    const output = call.output as { book_id?: string; symbol?: string; quantity?: number; price?: number } | null;
    if (!output?.symbol) continue;
    bookId = output.book_id ?? bookId;
    proposals.push({
      symbol: output.symbol,
      quantity: Number(output.quantity ?? 0),
      price: Number(output.price ?? 0),
    });
  }
  return { bookId, proposals };
}

/** Recompute post-trade exposure and block anything that breaches the book's limits. */
export function riskLimitVerifier(domain: TradingDomain): SyncVerifier {
  return {
    name: "risk-limits",
    description: "Recompute post-trade exposure and concentration against the book's configured limits.",
    run(input: VerificationInput): Finding[] {
      const { bookId, proposals } = proposalsFrom(input.toolCalls);
      const resolved = bookId ?? resolveBookId(input);
      if (!resolved || proposals.length === 0) return [];

      const limits = domain.riskLimits(resolved);
      if (!limits) {
        return [
          finding(
            "risk-limits",
            "block",
            "limits_missing",
            `Book ${resolved} has no configured risk limits; trades cannot be proposed against it.`,
          ),
        ];
      }

      const exposure = new Map<string, number>();
      for (const p of domain.positions(resolved)) {
        const price = domain.latestClose(p.symbol) ?? p.avgPrice;
        exposure.set(p.symbol, p.quantity * price);
      }
      for (const p of proposals) {
        const price = p.price || domain.latestClose(p.symbol) || 0;
        exposure.set(p.symbol, (exposure.get(p.symbol) ?? 0) + p.quantity * price);
      }

      const gross = [...exposure.values()].reduce((sum, v) => sum + Math.abs(v), 0);
      const findings: Finding[] = [];

      if (gross > limits.maxGrossExposure) {
        findings.push(
          finding(
            "risk-limits",
            "block",
            "gross_exposure_breach",
            `Post-trade gross exposure ${gross.toFixed(2)} exceeds the limit ${limits.maxGrossExposure.toFixed(2)}.`,
            { gross, limit: limits.maxGrossExposure },
          ),
        );
      }

      const held = [...exposure.entries()].filter(([, v]) => Math.abs(v) > 1e-9);
      if (held.length > limits.maxSymbols) {
        findings.push(
          finding(
            "risk-limits",
            "block",
            "symbol_count_breach",
            `Post-trade book holds ${held.length} symbols, above the limit of ${limits.maxSymbols}.`,
            { held: held.length, limit: limits.maxSymbols },
          ),
        );
      }

      if (gross > 0) {
        for (const [symbol, value] of held) {
          const pct = Math.abs(value) / gross;
          if (pct > limits.maxPositionPct) {
            findings.push(
              finding(
                "risk-limits",
                "block",
                "concentration_breach",
                `${symbol} would be ${(pct * 100).toFixed(1)}% of gross, above the ${(limits.maxPositionPct * 100).toFixed(1)}% cap.`,
                { symbol, pct, limit: limits.maxPositionPct },
              ),
            );
          }
        }
      }
      return findings;
    },
  };
}

const EXECUTION_CLAIM =
  /\b(order (placed|submitted|filled|executed)|i (placed|submitted|executed|bought|sold)|trade (executed|filled)|position (opened|closed) (for you|on your behalf))\b/i;

/**
 * This service never touches an order gateway. A reply that claims otherwise is
 * a compliance incident, so it is blocked before it can reach a human.
 */
export function noExecutionClaimVerifier(): SyncVerifier {
  return {
    name: "no-execution-claim",
    description: "Block replies that claim an order was placed; this system only proposes.",
    run(input: VerificationInput): Finding[] {
      const match = input.reply.match(EXECUTION_CLAIM);
      if (!match) return [];
      return [
        finding(
          "no-execution-claim",
          "block",
          "claimed_execution",
          `The reply claims an order was executed ("${match[0]}"). This service proposes trades only — ` +
            "restate the output as a proposal awaiting human approval.",
          { excerpt: match[0] },
        ),
      ];
    },
  };
}

export function tradingVerifiers(domain: TradingDomain): Verifier[] {
  return [
    numericProvenanceVerifier(),
    lookaheadBiasVerifier(),
    reconciliationVerifier(domain),
    riskLimitVerifier(domain),
    noExecutionClaimVerifier(),
  ];
}
