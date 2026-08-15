import type { Sandbox } from "../../kernel/sandbox.ts";
import type { ToolDefinition } from "../../kernel/types.ts";
import type { TradingDomain } from "./domain.ts";

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${key}" is required`);
  return value;
};

const optNum = (input: Record<string, unknown>, key: string, fallback: number): number => {
  const value = input[key];
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
  return n;
};

const num = (input: Record<string, unknown>, key: string): number => {
  const value = input[key];
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
  return n;
};

export const TRADING_GATED_TOOLS = new Set(["propose_trade"]);

export function tradingTools(deps: { domain: TradingDomain; sandbox: Sandbox }): ToolDefinition[] {
  const { domain } = deps;

  return [
    {
      name: "execute",
      description:
        "Run a shell command in this project's durable workspace. Use it to write and run Python that computes " +
        "figures. Every number you report must come out of a run like this. python3 with the standard library " +
        "is available. The command policy denies destructive operations outright.",
      parameters: {
        command: "The shell command to run.",
        timeout_seconds: "Optional wall-clock limit, default 30.",
      },
      async handler(input, ctx) {
        const command = str(input, "command");
        const timeoutMs = optNum(input, "timeout_seconds", 30) * 1000;
        const result = await ctx.exec(command, { timeoutMs });
        return {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          timed_out: result.timedOut,
        };
      },
    },
    {
      name: "write_file",
      description:
        "Write a file into the project workspace and register it as an artifact. Use this for scripts, " +
        "reconciliation reports, and any deliverable a human will read.",
      parameters: { path: "Workspace-relative path.", content: "Full file contents.", kind: "Optional artifact kind." },
      async handler(input, ctx) {
        const path = str(input, "path");
        const content = str(input, "content");
        const kind = typeof input.kind === "string" && input.kind ? input.kind : path.endsWith(".py") ? "code" : "file";
        const artifact = await ctx.writeArtifact(path, content, kind);
        return { artifact_id: artifact.id, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 };
      },
    },
    {
      name: "read_file",
      description: "Read a file back out of the project workspace.",
      parameters: { path: "Workspace-relative path." },
      async handler(input, ctx) {
        const path = str(input, "path");
        const content = await ctx.readArtifact(path);
        return content === null ? { path, found: false } : { path, found: true, content };
      },
    },
    {
      name: "list_instruments",
      description:
        "List the instrument universe. Delisted names are included by default — excluding them is survivorship bias.",
      parameters: { include_delisted: "Pass \"false\" to exclude delisted instruments (rarely correct)." },
      handler(input) {
        const include = String(input.include_delisted ?? "true") !== "false";
        const instruments = domain.listInstruments(include);
        return { count: instruments.length, include_delisted: include, instruments };
      },
    },
    {
      name: "market_data",
      description: "Fetch daily OHLCV bars for a symbol between two ISO dates (inclusive).",
      parameters: { symbol: "Instrument symbol.", start: "ISO start date.", end: "ISO end date." },
      handler(input) {
        const symbol = str(input, "symbol");
        const start = Date.parse(str(input, "start"));
        const end = Date.parse(str(input, "end"));
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("start and end must be ISO dates");
        const bars = domain.bars(symbol, start, end);
        return { symbol, start, end, count: bars.length, bars };
      },
    },
    {
      name: "positions",
      description: "The firm's internal position book.",
      parameters: { book_id: "Book identifier." },
      handler(input) {
        const bookId = str(input, "book_id");
        return { book_id: bookId, positions: domain.positions(bookId) };
      },
    },
    {
      name: "custodian_positions",
      description: "Positions as reported by the custodian, for reconciliation against the internal book.",
      parameters: { book_id: "Book identifier." },
      handler(input) {
        const bookId = str(input, "book_id");
        return { book_id: bookId, positions: domain.custodianPositions(bookId) };
      },
    },
    {
      name: "reconcile",
      description:
        "Compute the authoritative break list between the internal book and the custodian statement. " +
        "Your reply must agree with this result exactly.",
      parameters: { book_id: "Book identifier." },
      handler(input) {
        const bookId = str(input, "book_id");
        const result = domain.reconcile(bookId);
        return { book_id: bookId, break_count: result.breaks.length, ...result };
      },
    },
    {
      name: "risk_limits",
      description: "The configured risk limits and current gross exposure for a book.",
      parameters: { book_id: "Book identifier." },
      handler(input) {
        const bookId = str(input, "book_id");
        const limits = domain.riskLimits(bookId);
        const exposure = domain.grossExposure(bookId);
        return { book_id: bookId, limits, gross_exposure: exposure.gross, by_symbol: exposure.bySymbol };
      },
    },
    {
      name: "propose_trade",
      description:
        "Record a proposed trade. This never reaches a broker: it produces a proposal that a human must approve. " +
        "Post-trade exposure is re-checked against the book's risk limits before your reply is released.",
      parameters: {
        book_id: "Book identifier.",
        symbol: "Instrument symbol.",
        quantity: "Signed quantity; negative to sell.",
        price: "Reference price for the proposal.",
        rationale: "Why this trade.",
      },
      handler(input) {
        const bookId = str(input, "book_id");
        const symbol = str(input, "symbol");
        const quantity = num(input, "quantity");
        const price = optNum(input, "price", domain.latestClose(symbol) ?? 0);
        return {
          book_id: bookId,
          symbol,
          quantity,
          price,
          notional: quantity * price,
          rationale: typeof input.rationale === "string" ? input.rationale : "",
          status: "proposed_pending_human_approval",
        };
      },
    },
  ];
}
