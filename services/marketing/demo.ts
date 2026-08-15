import { createScriptedHarness, type ScriptedProgram } from "../../kernel/harness/scripted.ts";
import type { Harness } from "../../kernel/harness/harness.ts";
import type { Store } from "../../kernel/store.ts";
import type { MarketingDomain } from "./domain.ts";

const DAY_MS = 86_400_000;

export interface MarketingSeed {
  projectId: string;
  brandId: string;
  channels: Record<string, string>;
}

/** Deterministic demo brand with a real voice profile, history and competitor set. */
export function seedMarketingDemo(store: Store, domain: MarketingDomain, owner = "demo@brand.test"): MarketingSeed {
  const project = store.createProject({ service: "marketing", name: "Demo brand", owner });
  const brand = domain.createBrand(project.id, "Northwind");
  store.updateProjectSettings(project.id, { brandId: brand.id });

  domain.setVoiceProfile({
    brandId: brand.id,
    tone: "plain, concrete, no hype; short sentences; addresses the reader directly",
    readingGradeMax: 9,
    bannedPhrases: ["game-changer", "revolutionary", "synergy", "unlock the power", "leverage"],
    requiredPhrases: [],
    emojiAllowed: false,
    samplePosts: [
      "We cut onboarding from six steps to two. Here is what we removed and why.",
      "Support tickets about billing dropped 40% after we rewrote one error message.",
    ],
  });

  const channels: Record<string, string> = {};
  for (const [platform, handle, followers] of [
    ["x", "@northwind", 18_400],
    ["linkedin", "northwind-co", 32_100],
    ["instagram", "@northwind.co", 9_800],
  ] as const) {
    channels[platform] = domain.createChannel(brand.id, platform, handle, followers).id;
  }

  const now = Date.UTC(2026, 7, 1);
  const history = [
    ["x", "We cut onboarding from six steps to two. Here is what we removed and why.", 12_000, 480, 210],
    ["x", "Billing errors are a writing problem before they are an engineering problem.", 8_600, 305, 96],
    ["linkedin", "Support tickets about billing dropped 40% after we rewrote one error message.", 21_500, 1_310, 402],
  ] as const;

  for (const [index, [platform, body, impressions, engagements, clicks]] of history.entries()) {
    const post = domain.createPost({
      channelId: channels[platform],
      body,
      publishedAt: now - (index + 1) * DAY_MS,
      status: "published",
    });
    domain.setMetrics({ postId: post.id, impressions, engagements, clicks });
  }

  const competitors = [
    ["Eastgate", "x", "Our new dashboard is a total game-changer for ops teams.", 140],
    ["Eastgate", "linkedin", "Three lessons from migrating 400 customers in a weekend.", 890],
    ["Southbay", "x", "Shipping beats planning. Here is our release cadence.", 610],
  ] as const;

  for (const [index, [competitor, platform, body, engagements]] of competitors.entries()) {
    domain.addCompetitorPost({
      brandId: brand.id,
      competitor,
      platform,
      body,
      observedAt: now - index * DAY_MS,
      engagements,
    });
  }

  return { projectId: project.id, brandId: brand.id, channels };
}

/** Scripted programs exercising the real drafting and verification paths without an API key. */
export function marketingDemoHarness(resolve: () => { brandId: string; channels: Record<string, string> }): Harness {
  const programs: ScriptedProgram[] = [
    {
      match: /draft|post|repurpose|write/i,
      steps: [
        { tool: "brand_voice", input: () => ({ brand_id: resolve().brandId }) },
        { tool: "platform_spec", input: { platform: "x" } },
        {
          tool: "draft_post",
          input: () => ({
            channel_id: resolve().channels.x,
            body:
              "We cut a six-step signup to two. The three steps we deleted were all asking for data we never used. " +
              "https://northwind.example/blog/signup?utm_source=x&utm_medium=social&utm_campaign=signup-teardown",
            has_media: "false",
            sponsored: "false",
          }),
        },
      ],
      reply: () =>
        "Drafted one post for X on the signup teardown, inside the character limit with tracked link and no banned phrases.",
    },
    {
      match: /competitor|audit|benchmark/i,
      steps: [{ tool: "competitor_scan", input: () => ({ brand_id: resolve().brandId, limit: "10" }) }],
      reply: (results) => {
        const r = results[0] as { count?: number };
        return `Scanned ${r.count} recent competitor posts. The engagement leaders are long-form lessons rather than product announcements.`;
      },
    },
    {
      match: /performance|analytics|report|how did we do/i,
      steps: [{ tool: "analytics", input: () => ({ channel_id: resolve().channels.linkedin }) }],
      reply: (results) => {
        const r = results[0] as { impressions?: number; engagements?: number; posts?: number };
        return `LinkedIn: ${r.posts} published posts, ${r.impressions} impressions and ${r.engagements} engagements in the window.`;
      },
    },
  ];

  return createScriptedHarness({
    programs,
    fallbackReply: "I can draft posts, audit competitors, or report channel performance.",
  });
}
