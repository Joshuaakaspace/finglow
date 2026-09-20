import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Principal {
  keyId: string;
  owner: string;
  admin: boolean;
  name: string;
}

const KEY_PREFIX = "extpo_";

export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
}

/** Keys are stored only as a hash, so a leaked database does not hand over access. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX) && value.length > KEY_PREFIX.length + 16;
}

/** Constant-time compare so a caller cannot probe a hash byte by byte. */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Pull the presented key out of an Authorization or X-API-Key header. */
export function presentedKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  if (typeof authValue === "string") {
    const match = authValue.match(/^Bearer\s+(\S+)$/i);
    if (match) return match[1];
  }
  const direct = headers["x-api-key"];
  const directValue = Array.isArray(direct) ? direct[0] : direct;
  return typeof directValue === "string" && directValue.trim() !== "" ? directValue.trim() : null;
}
