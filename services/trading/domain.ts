import type { Db } from "../../kernel/db.ts";
import { newId } from "../../kernel/ids.ts";

export interface Instrument {
  symbol: string;
  name: string;
  active: boolean;
  delistedAt: number | null;
}

export interface Bar {
  symbol: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Book {
  id: string;
  projectId: string;
  name: string;
  baseCurrency: string;
}

export interface Position {
  bookId: string;
  symbol: string;
  quantity: number;
  avgPrice: number;
}

export interface CustodianPosition {
  bookId: string;
  symbol: string;
  quantity: number;
  asOf: number;
}

export interface RiskLimits {
  bookId: string;
  maxGrossExposure: number;
  maxPositionPct: number;
  maxSymbols: number;
}

export interface Break {
  symbol: string;
  internal: number;
  custodian: number;
  difference: number;
}

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v ?? "");
const n = (v: unknown): number => Number(v ?? 0);

export function createTradingDomain(db: Db) {
  return {
    upsertInstrument(instrument: Instrument): void {
      db.prepare(
        "INSERT INTO instruments (symbol, name, active, delisted_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, active = excluded.active, delisted_at = excluded.delisted_at",
      ).run(instrument.symbol, instrument.name, instrument.active ? 1 : 0, instrument.delistedAt);
    },

    listInstruments(includeDelisted = true): Instrument[] {
      const rows = (
        includeDelisted
          ? db.prepare("SELECT * FROM instruments ORDER BY symbol").all()
          : db.prepare("SELECT * FROM instruments WHERE active = 1 ORDER BY symbol").all()
      ) as Row[];
      return rows.map((r) => ({
        symbol: s(r.symbol),
        name: s(r.name),
        active: n(r.active) === 1,
        delistedAt: r.delisted_at === null || r.delisted_at === undefined ? null : n(r.delisted_at),
      }));
    },

    insertBars(bars: Bar[]): void {
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO price_bars (symbol, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const b of bars) stmt.run(b.symbol, b.ts, b.open, b.high, b.low, b.close, b.volume);
    },

    bars(symbol: string, startTs: number, endTs: number): Bar[] {
      const rows = db
        .prepare("SELECT * FROM price_bars WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC")
        .all(symbol, startTs, endTs) as Row[];
      return rows.map((r) => ({
        symbol: s(r.symbol),
        ts: n(r.ts),
        open: n(r.open),
        high: n(r.high),
        low: n(r.low),
        close: n(r.close),
        volume: n(r.volume),
      }));
    },

    latestClose(symbol: string): number | null {
      const row = db.prepare("SELECT close FROM price_bars WHERE symbol = ? ORDER BY ts DESC LIMIT 1").get(symbol) as
        | Row
        | undefined;
      return row ? n(row.close) : null;
    },

    createBook(projectId: string, name: string, baseCurrency = "USD"): Book {
      const book: Book = { id: newId("book"), projectId, name, baseCurrency };
      db.prepare("INSERT INTO books (id, project_id, name, base_currency) VALUES (?, ?, ?, ?)").run(
        book.id,
        book.projectId,
        book.name,
        book.baseCurrency,
      );
      return book;
    },

    getBook(bookId: string): Book | null {
      const r = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as Row | undefined;
      return r
        ? { id: s(r.id), projectId: s(r.project_id), name: s(r.name), baseCurrency: s(r.base_currency) }
        : null;
    },

    listBooks(projectId: string): Book[] {
      const rows = db.prepare("SELECT * FROM books WHERE project_id = ? ORDER BY name").all(projectId) as Row[];
      return rows.map((r) => ({
        id: s(r.id),
        projectId: s(r.project_id),
        name: s(r.name),
        baseCurrency: s(r.base_currency),
      }));
    },

    setPosition(position: Position): void {
      db.prepare(
        "INSERT INTO positions (book_id, symbol, quantity, avg_price) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(book_id, symbol) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price",
      ).run(position.bookId, position.symbol, position.quantity, position.avgPrice);
    },

    positions(bookId: string): Position[] {
      const rows = db.prepare("SELECT * FROM positions WHERE book_id = ? ORDER BY symbol").all(bookId) as Row[];
      return rows.map((r) => ({
        bookId: s(r.book_id),
        symbol: s(r.symbol),
        quantity: n(r.quantity),
        avgPrice: n(r.avg_price),
      }));
    },

    setCustodianPosition(position: CustodianPosition): void {
      db.prepare(
        "INSERT INTO custodian_positions (book_id, symbol, quantity, as_of) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(book_id, symbol) DO UPDATE SET quantity = excluded.quantity, as_of = excluded.as_of",
      ).run(position.bookId, position.symbol, position.quantity, position.asOf);
    },

    custodianPositions(bookId: string): CustodianPosition[] {
      const rows = db
        .prepare("SELECT * FROM custodian_positions WHERE book_id = ? ORDER BY symbol")
        .all(bookId) as Row[];
      return rows.map((r) => ({
        bookId: s(r.book_id),
        symbol: s(r.symbol),
        quantity: n(r.quantity),
        asOf: n(r.as_of),
      }));
    },

    setRiskLimits(limits: RiskLimits): void {
      db.prepare(
        "INSERT INTO risk_limits (book_id, max_gross_exposure, max_position_pct, max_symbols) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(book_id) DO UPDATE SET max_gross_exposure = excluded.max_gross_exposure, " +
          "max_position_pct = excluded.max_position_pct, max_symbols = excluded.max_symbols",
      ).run(limits.bookId, limits.maxGrossExposure, limits.maxPositionPct, limits.maxSymbols);
    },

    riskLimits(bookId: string): RiskLimits | null {
      const r = db.prepare("SELECT * FROM risk_limits WHERE book_id = ?").get(bookId) as Row | undefined;
      return r
        ? {
            bookId: s(r.book_id),
            maxGrossExposure: n(r.max_gross_exposure),
            maxPositionPct: n(r.max_position_pct),
            maxSymbols: n(r.max_symbols),
          }
        : null;
    },

    /**
     * The authoritative reconciliation. The verifier recomputes this
     * independently of whatever the agent reported.
     */
    reconcile(bookId: string): { breaks: Break[]; internalCount: number; custodianCount: number } {
      const internal = new Map(this.positions(bookId).map((p) => [p.symbol, p.quantity]));
      const custodian = new Map(this.custodianPositions(bookId).map((p) => [p.symbol, p.quantity]));
      const symbols = [...new Set([...internal.keys(), ...custodian.keys()])].sort();

      const breaks: Break[] = [];
      for (const symbol of symbols) {
        const a = internal.get(symbol) ?? 0;
        const b = custodian.get(symbol) ?? 0;
        if (Math.abs(a - b) > 1e-6) breaks.push({ symbol, internal: a, custodian: b, difference: a - b });
      }
      return { breaks, internalCount: internal.size, custodianCount: custodian.size };
    },

    grossExposure(bookId: string): { gross: number; bySymbol: Record<string, number> } {
      const bySymbol: Record<string, number> = {};
      let gross = 0;
      for (const p of this.positions(bookId)) {
        const price = this.latestClose(p.symbol) ?? p.avgPrice;
        const value = Math.abs(p.quantity * price);
        bySymbol[p.symbol] = value;
        gross += value;
      }
      return { gross, bySymbol };
    },
  };
}

export type TradingDomain = ReturnType<typeof createTradingDomain>;
