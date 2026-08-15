import { randomUUID, createHash } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function now(): number {
  return Date.now();
}
