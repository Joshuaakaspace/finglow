import { join } from "node:path";
import { createService, type Service } from "../../kernel/service.ts";
import { createPolicy, type Rule } from "../../kernel/policy.ts";
import { createTradingDomain, type TradingDomain } from "./domain.ts";
import { TRADING_SCHEMA } from "./schema.ts";
import { TRADING_SYSTEM_PROMPT } from "./prompt.ts";
import { TRADING_GATED_TOOLS, tradingTools } from "./tools.ts";
import { tradingVerifiers } from "./verifiers.ts";
import { registerTradingRoutes } from "./routes.ts";
import type { Harness } from "../../kernel/harness/harness.ts";

const HERE = new URL(".", import.meta.url).pathname;

/** Trading-specific command rules, layered on top of the kernel's base denials. */
const TRADING_RULES: Rule[] = [
  { pattern: /\b(fix|order|oms|broker|execution)[-_.]?(gateway|api|client)\b/i, decision: "deny", reason: "order gateway access" },
  { pattern: /\bcurl\b[^\n]*\b(alpaca|ibkr|interactivebrokers|tradier|schwab)\b/i, decision: "deny", reason: "broker API call" },
  { pattern: /\bpip\s+install\b/, decision: "require_approval", reason: "installs a package into the workspace" },
];

export interface TradingServiceOptions {
  harness: Harness;
  databasePath?: string;
  workspaceDir?: string;
  maxRepairAttempts?: number;
  requireAuth?: boolean;
}

export interface TradingService extends Service {
  domain: TradingDomain;
}

export function createTradingService(options: TradingServiceOptions): TradingService {
  let domain: TradingDomain | null = null;

  const service = createService({
    id: "trading",
    databasePath: options.databasePath ?? join(process.cwd(), "var", "trading.sqlite"),
    workspaceDir: options.workspaceDir ?? join(process.cwd(), "var", "trading-workspaces"),
    skillsDir: join(HERE, "skills"),
    systemPrompt: TRADING_SYSTEM_PROMPT,
    domainSchema: TRADING_SCHEMA,
    policy: createPolicy(TRADING_RULES),
    gatedTools: TRADING_GATED_TOOLS,
    harness: options.harness,
    maxRepairAttempts: options.maxRepairAttempts ?? 1,
    requireAuth: options.requireAuth,

    buildTools({ store, sandbox }) {
      domain = createTradingDomain(store.db);
      return tradingTools({ domain, sandbox });
    },

    buildVerifiers({ store }) {
      domain ??= createTradingDomain(store.db);
      return tradingVerifiers(domain);
    },

    buildRoutes({ store, router }) {
      domain ??= createTradingDomain(store.db);
      registerTradingRoutes({ router, store, domain });
    },
  });

  return Object.assign(service, { domain: domain ?? createTradingDomain(service.store.db) });
}
