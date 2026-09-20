import type { Engine } from "./engine.ts";

export interface WorkerOptions {
  engine: Engine;
  tickCrons(now?: number): Promise<number>;
  intervalMs?: number;
  onError?(error: unknown, phase: "cron" | "drain"): void;
}

export interface WorkerCycle {
  fired: number;
  drained: number;
}

/**
 * Fires due crons and drains queued runs on an interval. Cycles never overlap:
 * a long run delays the next tick rather than racing it, which keeps a single
 * process from claiming the same work twice.
 */
export function createWorker(options: WorkerOptions) {
  const intervalMs = options.intervalMs ?? 15_000;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<WorkerCycle> | null = null;
  let stopped = false;

  async function runOnce(): Promise<WorkerCycle> {
    if (inFlight) return await inFlight;

    inFlight = (async () => {
      let fired = 0;
      let drained = 0;
      try {
        fired = await options.tickCrons();
      } catch (error) {
        options.onError?.(error, "cron");
      }
      try {
        drained = await options.engine.drainOnce();
      } catch (error) {
        options.onError?.(error, "drain");
      }
      return { fired, drained };
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    runOnce,

    start(): void {
      if (timer || stopped) return;
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref?.();
      void runOnce();
    },

    /** Stops scheduling and waits for the cycle in flight to finish. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => undefined);
    },
  };
}

export type Worker = ReturnType<typeof createWorker>;
