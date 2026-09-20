import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { presentedKey, type Principal } from "./auth.ts";

export interface RequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingMessage["headers"];
  /** Null only on routes the service marks public. */
  principal: Principal | null;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

export const badRequest = (m: string, d?: unknown): HttpError => new HttpError(400, m, d);
export const notFound = (m: string): HttpError => new HttpError(404, m);
export const conflict = (m: string): HttpError => new HttpError(409, m);
export const unauthorized = (m: string): HttpError => new HttpError(401, m);
export const forbidden = (m: string): HttpError => new HttpError(403, m);

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export function createRouter() {
  const routes: Route[] = [];

  const add = (method: string, pattern: string, handler: Handler): void => {
    routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
  };

  const match = (method: string, path: string): { handler: Handler; params: Record<string, string> } | null => {
    const parts = path.split("/").filter(Boolean);
    for (const route of routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  };

  return {
    get: (p: string, h: Handler) => add("GET", p, h),
    post: (p: string, h: Handler) => add("POST", p, h),
    patch: (p: string, h: Handler) => add("PATCH", p, h),
    delete: (p: string, h: Handler) => add("DELETE", p, h),
    match,
    routes: () => routes.map((r) => `${r.method} /${r.segments.join("/")}`),
  };
}

export type Router = ReturnType<typeof createRouter>;

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > maxBytes) throw badRequest(`request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("request body is not valid JSON");
  }
}

export interface ServeOptions {
  router: Router;
  maxBodyBytes?: number;
  onError?: (error: unknown, ctx: { method: string; path: string }) => void;
  /** Resolve a presented key to a principal. Omit to leave the API unauthenticated. */
  authenticate?: (key: string) => Principal | null;
  /** Routes reachable without a key, as `METHOD /path`. */
  publicRoutes?: Set<string>;
}

export function createHttpServer(options: ServeOptions) {
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;

  const send = (res: ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload ?? null);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      try {
        const matched = options.router.match(method, url.pathname);
        if (!matched) throw notFound(`no route for ${method} ${url.pathname}`);

        let principal: Principal | null = null;
        if (options.authenticate && !options.publicRoutes?.has(`${method} ${url.pathname}`)) {
          const key = presentedKey(req.headers);
          if (!key) throw unauthorized("an API key is required: send Authorization: Bearer <key>");
          principal = options.authenticate(key);
          if (!principal) throw unauthorized("unknown or revoked API key");
        }

        const body = method === "GET" || method === "DELETE" ? undefined : await readBody(req, maxBodyBytes);
        const result = await matched.handler({
          method,
          path: url.pathname,
          params: matched.params,
          query: url.searchParams,
          body,
          headers: req.headers,
          principal,
        });

        if (result === undefined) send(res, 204, null);
        else send(res, method === "POST" ? 201 : 200, result);
      } catch (error) {
        options.onError?.(error, { method, path: url.pathname });
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.message, detail: error.detail ?? null });
        } else {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
  });
}

/** Read a required string field from a JSON body. */
export function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`"${field}" is required`);
  return value;
}

export function optionalString(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function optionalObject(body: unknown, field: string): Record<string, unknown> | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
