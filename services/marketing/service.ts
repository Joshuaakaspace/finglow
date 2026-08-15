import { join } from "node:path";
import { createService, type Service } from "../../kernel/service.ts";
import { createPolicy, type Rule } from "../../kernel/policy.ts";
import { createMarketingDomain, type MarketingDomain } from "./domain.ts";
import { MARKETING_SCHEMA } from "./schema.ts";
import { MARKETING_SYSTEM_PROMPT } from "./prompt.ts";
import { MARKETING_GATED_TOOLS, marketingTools } from "./tools.ts";
import { marketingVerifiers } from "./verifiers.ts";
import { registerMarketingRoutes } from "./routes.ts";
import type { Harness } from "../../kernel/harness/harness.ts";

const HERE = new URL(".", import.meta.url).pathname;

/** Marketing-specific rules: nothing may reach a publishing API from the sandbox. */
const MARKETING_RULES: Rule[] = [
  {
    pattern: /\bcurl\b[^\n]*\b(graph\.facebook|api\.twitter|api\.x\.com|api\.linkedin|open-?api\.tiktok|instagram)\b/i,
    decision: "deny",
    reason: "direct publishing API call — publishing goes through schedule_post",
  },
  { pattern: /\bpip\s+install\b/, decision: "require_approval", reason: "installs a package into the workspace" },
];

export interface MarketingServiceOptions {
  harness: Harness;
  databasePath?: string;
  workspaceDir?: string;
  maxRepairAttempts?: number;
}

export interface MarketingService extends Service {
  domain: MarketingDomain;
}

export function createMarketingService(options: MarketingServiceOptions): MarketingService {
  let domain: MarketingDomain | null = null;

  const service = createService({
    id: "marketing",
    databasePath: options.databasePath ?? join(process.cwd(), "var", "marketing.sqlite"),
    workspaceDir: options.workspaceDir ?? join(process.cwd(), "var", "marketing-workspaces"),
    skillsDir: join(HERE, "skills"),
    systemPrompt: MARKETING_SYSTEM_PROMPT,
    domainSchema: MARKETING_SCHEMA,
    policy: createPolicy(MARKETING_RULES),
    gatedTools: MARKETING_GATED_TOOLS,
    harness: options.harness,
    maxRepairAttempts: options.maxRepairAttempts ?? 1,

    buildTools({ store, sandbox }) {
      domain = createMarketingDomain(store.db);
      return marketingTools({ domain, sandbox });
    },

    buildVerifiers({ store }) {
      domain ??= createMarketingDomain(store.db);
      return marketingVerifiers(domain);
    },

    buildRoutes({ store, router }) {
      domain ??= createMarketingDomain(store.db);
      registerMarketingRoutes({ router, store, domain });
    },
  });

  return Object.assign(service, { domain: domain ?? createMarketingDomain(service.store.db) });
}
