import type { Db } from "./db.ts";
import { fromJson } from "./db.ts";
import type { Finding, RunStatus } from "./types.ts";

export interface VerifierMetrics {
  /** Verification passes in which this verifier raised a blocking finding. */
  blocks: number;
  warns: number;
  /** Finding codes this verifier raised, most frequent first. */
  codes: Array<{ code: string; count: number }>;
}

export interface Metrics {
  window: { since: number | null; runs: number };
  runs: Record<RunStatus, number>;
  /** Runs that reached a reply the caller could use. */
  completionRate: number;
  repair: {
    /** Runs whose first attempt was blocked and were retried. */
    attempted: number;
    /** …of those, the ones that then passed. */
    succeeded: number;
    rate: number;
  };
  /** Runs that stayed blocked after the repair budget. This is the number to watch. */
  blockedAfterBudget: number;
  latencyMs: { p50: number; p95: number; max: number };
  verifiers: Record<string, VerifierMetrics>;
  topCodes: Array<{ code: string; count: number }>;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: unknown): string => String(v ?? "");

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

const EMPTY_RUNS: Record<RunStatus, number> = {
  queued: 0,
  running: 0,
  blocked: 0,
  ok: 0,
  failed: 0,
  awaiting_approval: 0,
};

/**
 * Aggregates what the system already records into the numbers that say whether
 * it is working: how often the gate blocks, how often a repair rescues the run,
 * and how often output stays blocked after the budget.
 */
export function computeMetrics(db: Db, options: { since?: number } = {}): Metrics {
  const since = options.since ?? null;
  const runFilter = since === null ? "" : " WHERE created_at >= ?";
  const runArgs = since === null ? [] : [since];

  const runs = { ...EMPTY_RUNS };
  for (const row of db.prepare(`SELECT status, COUNT(*) AS n FROM runs${runFilter} GROUP BY status`).all(
    ...runArgs,
  ) as Row[]) {
    const status = str(row.status) as RunStatus;
    if (status in runs) runs[status] = num(row.n);
  }
  const totalRuns = Object.values(runs).reduce((a, b) => a + b, 0);

  const repairRow = db
    .prepare(
      "SELECT COUNT(*) AS attempted, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS succeeded " +
        `FROM runs WHERE repair_attempts > 0${since === null ? "" : " AND created_at >= ?"}`,
    )
    .get(...runArgs) as Row | undefined;
  const attempted = num(repairRow?.attempted);
  const succeeded = num(repairRow?.succeeded);

  const durations = (
    db
      .prepare(
        "SELECT (finished_at - started_at) AS ms FROM runs WHERE finished_at IS NOT NULL AND started_at IS NOT NULL" +
          `${since === null ? "" : " AND created_at >= ?"}`,
      )
      .all(...runArgs) as Row[]
  )
    .map((r) => num(r.ms))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);

  const verifications = db
    .prepare(
      "SELECT v.findings_json AS findings FROM verifications v JOIN runs r ON r.id = v.run_id" +
        `${since === null ? "" : " WHERE r.created_at >= ?"}`,
    )
    .all(...runArgs) as Row[];

  const verifiers: Record<string, VerifierMetrics> = {};
  const codeCounts = new Map<string, number>();

  for (const row of verifications) {
    for (const found of fromJson<Finding[]>(row.findings, [])) {
      const entry = (verifiers[found.verifier] ??= { blocks: 0, warns: 0, codes: [] });
      if (found.severity === "block") entry.blocks++;
      else if (found.severity === "warn") entry.warns++;

      const key = `${found.verifier}/${found.code}`;
      codeCounts.set(key, (codeCounts.get(key) ?? 0) + 1);
    }
  }

  for (const [key, count] of codeCounts) {
    const [verifier, code] = key.split("/", 2);
    verifiers[verifier]?.codes.push({ code, count });
  }
  for (const entry of Object.values(verifiers)) entry.codes.sort((a, b) => b.count - a.count);

  return {
    window: { since, runs: totalRuns },
    runs,
    completionRate: totalRuns === 0 ? 0 : runs.ok / totalRuns,
    repair: { attempted, succeeded, rate: attempted === 0 ? 0 : succeeded / attempted },
    blockedAfterBudget: runs.blocked,
    latencyMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.at(-1) ?? 0,
    },
    verifiers,
    topCodes: [...codeCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}
