import { badRequest, notFound, requireString, type Router } from "../../kernel/http.ts";
import type { Store } from "../../kernel/store.ts";
import type { TradingDomain } from "./domain.ts";

function numberField(body: unknown, field: string): number {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`"${field}" must be a number`);
  return n;
}

export function registerTradingRoutes(deps: { router: Router; store: Store; domain: TradingDomain }): void {
  const { router, store, domain } = deps;

  router.post("/projects/:id/books", (ctx) => {
    const project = store.getProject(ctx.params.id);
    if (!project) throw notFound(`project ${ctx.params.id}`);
    const book = domain.createBook(project.id, requireString(ctx.body, "name"));
    store.updateProjectSettings(project.id, { ...project.settings, bookId: book.id });
    store.audit(project.owner, "book.create", book.id, { projectId: project.id });
    return book;
  });

  router.get("/projects/:id/books", (ctx) => ({ books: domain.listBooks(ctx.params.id) }));

  router.get("/books/:id/positions", (ctx) => ({
    internal: domain.positions(ctx.params.id),
    custodian: domain.custodianPositions(ctx.params.id),
  }));

  router.post("/books/:id/positions", (ctx) => {
    if (!domain.getBook(ctx.params.id)) throw notFound(`book ${ctx.params.id}`);
    domain.setPosition({
      bookId: ctx.params.id,
      symbol: requireString(ctx.body, "symbol"),
      quantity: numberField(ctx.body, "quantity"),
      avgPrice: numberField(ctx.body, "avgPrice"),
    });
    return { positions: domain.positions(ctx.params.id) };
  });

  router.post("/books/:id/custodian-positions", (ctx) => {
    if (!domain.getBook(ctx.params.id)) throw notFound(`book ${ctx.params.id}`);
    domain.setCustodianPosition({
      bookId: ctx.params.id,
      symbol: requireString(ctx.body, "symbol"),
      quantity: numberField(ctx.body, "quantity"),
      asOf: Number((ctx.body as Record<string, unknown>).asOf ?? Date.now()),
    });
    return { custodian: domain.custodianPositions(ctx.params.id) };
  });

  router.post("/books/:id/risk-limits", (ctx) => {
    if (!domain.getBook(ctx.params.id)) throw notFound(`book ${ctx.params.id}`);
    domain.setRiskLimits({
      bookId: ctx.params.id,
      maxGrossExposure: numberField(ctx.body, "maxGrossExposure"),
      maxPositionPct: numberField(ctx.body, "maxPositionPct"),
      maxSymbols: numberField(ctx.body, "maxSymbols"),
    });
    return domain.riskLimits(ctx.params.id);
  });

  router.get("/books/:id/reconcile", (ctx) => domain.reconcile(ctx.params.id));

  router.get("/books/:id/exposure", (ctx) => domain.grossExposure(ctx.params.id));

  router.post("/instruments", (ctx) => {
    const symbol = requireString(ctx.body, "symbol");
    const body = ctx.body as Record<string, unknown>;
    domain.upsertInstrument({
      symbol,
      name: requireString(ctx.body, "name"),
      active: body.active !== false,
      delistedAt: body.delistedAt === undefined || body.delistedAt === null ? null : Number(body.delistedAt),
    });
    return { instrument: symbol };
  });

  router.get("/instruments", (ctx) => ({
    instruments: domain.listInstruments(ctx.query.get("includeDelisted") !== "false"),
  }));

  router.post("/bars", (ctx) => {
    const bars = (ctx.body as { bars?: unknown } | undefined)?.bars;
    if (!Array.isArray(bars)) throw badRequest('"bars" array is required');
    domain.insertBars(
      bars.map((b) => {
        const bar = b as Record<string, unknown>;
        return {
          symbol: String(bar.symbol),
          ts: Number(bar.ts),
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: Number(bar.volume ?? 0),
        };
      }),
    );
    return { inserted: bars.length };
  });

  router.get("/bars", (ctx) => {
    const symbol = ctx.query.get("symbol");
    if (!symbol) throw badRequest('"symbol" query parameter is required');
    const start = Number(ctx.query.get("start") ?? 0);
    const end = Number(ctx.query.get("end") ?? Date.now());
    return { symbol, bars: domain.bars(symbol, start, end) };
  });
}
