import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ExecResult } from "./types.ts";

export interface Sandbox {
  readonly kind: string;
  root(projectId: string): string;
  exec(projectId: string, command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  writeFile(projectId: string, path: string, content: string): Promise<void>;
  readFile(projectId: string, path: string): Promise<string | null>;
  remove(projectId: string): Promise<void>;
}

export class PathEscapeError extends Error {
  constructor(path: string) {
    super(`path escapes the project workspace: ${path}`);
    this.name = "PathEscapeError";
  }
}

/** Resolve a caller-supplied path against a root, refusing anything that escapes it. */
export function safeJoin(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, path);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) throw new PathEscapeError(path);
  return target;
}

export interface LocalSandboxOptions {
  baseDir: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export function createLocalSandbox(options: LocalSandboxOptions): Sandbox {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;

  const root = (projectId: string): string => join(resolve(options.baseDir), projectId);

  const ensureRoot = async (projectId: string): Promise<string> => {
    const dir = root(projectId);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  const clamp = (chunks: Buffer[]): string => {
    const joined = Buffer.concat(chunks);
    if (joined.byteLength <= maxOutputBytes) return joined.toString("utf8");
    return `${joined.subarray(0, maxOutputBytes).toString("utf8")}\n…[truncated ${joined.byteLength - maxOutputBytes} bytes]`;
  };

  return {
    kind: "local",
    root,

    async exec(projectId, command, opts = {}) {
      const cwd = await ensureRoot(projectId);
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const startedAt = Date.now();

      return await new Promise<ExecResult>((resolvePromise) => {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...options.env },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout.on("data", (c: Buffer) => stdout.push(c));
        child.stderr.on("data", (c: Buffer) => stderr.push(c));

        const finish = (exitCode: number): void => {
          clearTimeout(timer);
          resolvePromise({
            exitCode,
            stdout: clamp(stdout),
            stderr: clamp(stderr),
            durationMs: Date.now() - startedAt,
            timedOut,
          });
        };

        child.on("error", (err) => {
          stderr.push(Buffer.from(String(err)));
          finish(127);
        });
        child.on("close", (code) => finish(timedOut ? 124 : (code ?? 0)));
      });
    },

    async writeFile(projectId, path, content) {
      const dir = await ensureRoot(projectId);
      const target = safeJoin(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },

    async readFile(projectId, path) {
      const dir = await ensureRoot(projectId);
      const target = safeJoin(dir, path);
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },

    async remove(projectId) {
      await rm(root(projectId), { recursive: true, force: true });
    },
  };
}
