import { createScriptedHarness, type ScriptedProgram } from "../../kernel/harness/scripted.ts";
import type { Harness } from "../../kernel/harness/harness.ts";
import type { Store } from "../../kernel/store.ts";
import type { TradingDomain } from "./domain.ts";

const DAY_MS = 86_400_000;

export interface SeedResult {
  projectId: string;
  bookId: string;
  symbols: string[];
}

/** Deterministic demo data: two clean positions, one break, one delisted name. */
export function seedTradingDemo(store: Store, domain: TradingDomain, owner = "demo@firm.test"): SeedResult {
  const project = store.createProject({ service: "trading", name: "Demo book", owner });
  const book = domain.createBook(project.id, "Core");
  store.updateProjectSettings(project.id, { bookId: book.id });

  const universe = [
    { symbol: "AAA", name: "Alpha Industries", active: true, delistedAt: null },
    { symbol: "BBB", name: "Beta Holdings", active: true, delistedAt: null },
    { symbol: "CCC", name: "Gamma Corp", active: true, delistedAt: null },
    { symbol: "ZZZ", name: "Zeta Systems (delisted)", active: false, delistedAt: Date.UTC(2025, 5, 30) },
  ];
  for (const instrument of universe) domain.upsertInstrument(instrument);

  const start = Date.UTC(2026, 0, 5);
  for (const [index, instrument] of universe.entries()) {
    const base = 20 + index * 35;
    const bars = Array.from({ length: 60 }, (_, day) => {
      const drift = Math.sin((day + index * 7) / 6) * (base * 0.03);
      const close = Number((base + drift + day * 0.08).toFixed(2));
      return {
        symbol: instrument.symbol,
        ts: start + day * DAY_MS,
        open: Number((close * 0.995).toFixed(2)),
        high: Number((close * 1.012).toFixed(2)),
        low: Number((close * 0.988).toFixed(2)),
        close,
        volume: 100_000 + day * 250,
      };
    });
    domain.insertBars(bars);
  }

  domain.setPosition({ bookId: book.id, symbol: "AAA", quantity: 1_000, avgPrice: 19.5 });
  domain.setPosition({ bookId: book.id, symbol: "BBB", quantity: 400, avgPrice: 54.2 });
  domain.setPosition({ bookId: book.id, symbol: "CCC", quantity: 250, avgPrice: 88.1 });

  const asOf = start + 59 * DAY_MS;
  domain.setCustodianPosition({ bookId: book.id, symbol: "AAA", quantity: 1_000, asOf });
  domain.setCustodianPosition({ bookId: book.id, symbol: "BBB", quantity: 250, asOf });
  domain.setCustodianPosition({ bookId: book.id, symbol: "CCC", quantity: 250, asOf });

  domain.setRiskLimits({ bookId: book.id, maxGrossExposure: 200_000, maxPositionPct: 0.6, maxSymbols: 8 });

  return { projectId: project.id, bookId: book.id, symbols: universe.map((u) => u.symbol) };
}

interface ReconcileOutput {
  break_count?: number;
  breaks?: Array<{ symbol: string; internal: number; custodian: number; difference: number }>;
}

/**
 * Scripted programs that exercise the real tool, policy and verification paths
 * without an API key. `bookId` is bound at construction so the demo is runnable
 * straight after seeding.
 */
export function tradingDemoHarness(resolveBookId: () => string): Harness {
  const programs: ScriptedProgram[] = [
    {
      match: /reconcil/i,
      steps: [
        { tool: "reconcile", input: () => ({ book_id: resolveBookId() }) },
        {
          tool: "write_file",
          input: (prev) => {
            const result = prev[0] as ReconcileOutput;
            const rows = (result.breaks ?? [])
              .map((b) => `| ${b.symbol} | ${b.internal} | ${b.custodian} | ${b.difference} |`)
              .join("\n");
            return {
              path: "reconciliation/core-latest.md",
              content: `# Reconciliation\n\nBreaks: ${result.break_count}\n\n| Symbol | Internal | Custodian | Diff |\n| --- | --- | --- | --- |\n${rows}\n`,
              kind: "report",
            };
          },
        },
      ],
      reply: (results) => {
        const result = results[0] as ReconcileOutput;
        const breaks = result.breaks ?? [];
        if (breaks.length === 0) return "The book ties out to the custodian with no breaks.";
        const detail = breaks
          .map((b) => `${b.symbol} (internal ${b.internal} vs custodian ${b.custodian}, difference ${b.difference})`)
          .join("; ");
        return `The book has ${breaks.length} break against the custodian: ${detail}. Report written to reconciliation/core-latest.md.`;
      },
    },
    {
      match: /exposure|risk|limit/i,
      steps: [{ tool: "risk_limits", input: () => ({ book_id: resolveBookId() }) }],
      reply: (results) => {
        const r = results[0] as { gross_exposure?: number; limits?: { max_gross_exposure?: number } | null };
        return `Current gross exposure is ${r.gross_exposure}. Limits are attached to the book; nothing is breached.`;
      },
    },
    {
      match: /brief|position|book/i,
      steps: [{ tool: "positions", input: () => ({ book_id: resolveBookId() }) }],
      reply: (results) => {
        const r = results[0] as { positions?: Array<{ symbol: string; quantity: number }> };
        const lines = (r.positions ?? []).map((p) => `${p.symbol} ${p.quantity}`).join(", ");
        return `The book holds: ${lines}.`;
      },
    },
  ];

  return createScriptedHarness({
    programs,
    fallbackReply: "I can reconcile the book, review risk limits, or brief you on positions.",
  });
}
