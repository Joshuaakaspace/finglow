export type Decision = "allow" | "deny" | "require_approval";

export interface Rule {
  pattern: RegExp;
  decision: Decision;
  reason: string;
}

export interface PolicyVerdict {
  decision: Decision;
  reason: string;
  matched?: string;
}

/**
 * Hard denials that apply in every service and can never be approved away.
 * Ordered most-destructive first; the first match wins.
 */
export const BASE_DENY_RULES: Rule[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+\/(\s|$)/, reason: "recursive delete of /", decision: "deny" },
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]/, reason: "recursive delete", decision: "require_approval" },
  { pattern: /\b(mkfs|fdisk|dd)\b/, reason: "raw disk operation", decision: "deny" },
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: "destructive SQL", decision: "deny" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: "destructive SQL", decision: "deny" },
  { pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, reason: "unbounded DELETE", decision: "deny" },
  { pattern: /\bUPDATE\b(?!.*\bWHERE\b).*\bSET\b/i, reason: "unbounded UPDATE", decision: "deny" },
  { pattern: /\bcurl\b[^|]*\|\s*(ba)?sh\b/, reason: "pipe-to-shell from network", decision: "deny" },
  { pattern: /\b(shutdown|reboot|halt|systemctl)\b/, reason: "host control", decision: "deny" },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, reason: "world-writable permissions", decision: "deny" },
  { pattern: /\b(git\s+push\s+.*--force|git\s+push\s+.*-f\b)/, reason: "force push", decision: "require_approval" },
  { pattern: /\bgit\s+(push|remote\s+add)\b/, reason: "writes to a remote", decision: "require_approval" },
  { pattern: /(^|\s)(>|>>)\s*\/(etc|usr|bin|sbin|boot)\//, reason: "write outside the workspace", decision: "deny" },
];

export interface CommandPolicy {
  mode: "denylist" | "allowlist";
  rules: Rule[];
}

export function createPolicy(extra: Rule[] = [], mode: CommandPolicy["mode"] = "denylist"): CommandPolicy {
  return { mode, rules: [...BASE_DENY_RULES, ...extra] };
}

export function evaluateCommand(policy: CommandPolicy, command: string): PolicyVerdict {
  for (const rule of policy.rules) {
    const match = command.match(rule.pattern);
    if (match) return { decision: rule.decision, reason: rule.reason, matched: match[0] };
  }
  if (policy.mode === "allowlist") {
    return { decision: "require_approval", reason: "not on the allowlist" };
  }
  return { decision: "allow", reason: "no rule matched" };
}

/** Tools that mutate something outside the sandbox and always need a human. */
export function toolNeedsApproval(gatedTools: Set<string>, tool: string): boolean {
  return gatedTools.has(tool);
}
