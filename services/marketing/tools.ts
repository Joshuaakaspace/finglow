import type { Sandbox } from "../../kernel/sandbox.ts";
import type { ToolDefinition } from "../../kernel/types.ts";
import type { MarketingDomain } from "./domain.ts";
import { effectiveLength, extractHashtags, extractLinks, knownPlatforms, platformSpec } from "./platforms.ts";

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${key}" is required`);
  return value;
};

const bool = (input: Record<string, unknown>, key: string): boolean => {
  const value = input[key];
  return value === true || value === "true";
};

const optNum = (input: Record<string, unknown>, key: string, fallback: number): number => {
  const value = input[key];
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const MARKETING_GATED_TOOLS = new Set(["schedule_post"]);

export function marketingTools(deps: { domain: MarketingDomain; sandbox: Sandbox }): ToolDefinition[] {
  const { domain } = deps;

  return [
    {
      name: "execute",
      description:
        "Run a shell command in this project's durable workspace. Use it to compute analytics figures with Python " +
        "rather than estimating them. python3 with the standard library is available.",
      parameters: { command: "The shell command to run.", timeout_seconds: "Optional wall-clock limit, default 30." },
      async handler(input, ctx) {
        const result = await ctx.exec(str(input, "command"), { timeoutMs: optNum(input, "timeout_seconds", 30) * 1000 });
        return {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          timed_out: result.timedOut,
        };
      },
    },
    {
      name: "write_file",
      description: "Write a file into the project workspace and register it as an artifact.",
      parameters: { path: "Workspace-relative path.", content: "Full file contents.", kind: "Optional artifact kind." },
      async handler(input, ctx) {
        const artifact = await ctx.writeArtifact(
          str(input, "path"),
          str(input, "content"),
          typeof input.kind === "string" && input.kind ? input.kind : "file",
        );
        return { artifact_id: artifact.id, path: artifact.path, bytes: artifact.bytes };
      },
    },
    {
      name: "read_file",
      description: "Read a file back out of the project workspace.",
      parameters: { path: "Workspace-relative path." },
      async handler(input, ctx) {
        const path = str(input, "path");
        const content = await ctx.readArtifact(path);
        return content === null ? { path, found: false } : { path, found: true, content };
      },
    },
    {
      name: "brand_voice",
      description:
        "The brand's stored voice profile: tone, banned and required phrases, emoji policy, reading-level ceiling, " +
        "and sample posts written by the brand. Read this before drafting anything.",
      parameters: { brand_id: "Brand identifier." },
      handler(input) {
        const brandId = str(input, "brand_id");
        const profile = domain.voiceProfile(brandId);
        if (!profile) return { brand_id: brandId, found: false };
        return { brand_id: brandId, found: true, ...profile };
      },
    },
    {
      name: "platform_spec",
      description: "The hard publishing rules for a platform: character limit, hashtag cap, link rules, media needs.",
      parameters: { platform: `One of: ${knownPlatforms().join(", ")}.` },
      handler(input) {
        const platform = str(input, "platform");
        const spec = platformSpec(platform);
        if (!spec) return { platform, found: false, known: knownPlatforms() };
        return { found: true, ...spec };
      },
    },
    {
      name: "channels",
      description: "The brand's connected channels with follower counts.",
      parameters: { brand_id: "Brand identifier." },
      handler(input) {
        const brandId = str(input, "brand_id");
        return { brand_id: brandId, channels: domain.listChannels(brandId) };
      },
    },
    {
      name: "analytics",
      description:
        "Aggregate performance for a channel: post count, impressions, engagements, clicks and engagement rate. " +
        "Quote these figures rather than estimating them.",
      parameters: { channel_id: "Channel identifier." },
      handler(input) {
        const channelId = str(input, "channel_id");
        return { channel_id: channelId, ...domain.channelMetrics(channelId) };
      },
    },
    {
      name: "competitor_scan",
      description: "Recently observed competitor posts for this brand, with engagement counts.",
      parameters: { brand_id: "Brand identifier.", limit: "How many posts to return, default 20." },
      handler(input) {
        const brandId = str(input, "brand_id");
        const posts = domain.competitorPosts(brandId, optNum(input, "limit", 20));
        return { brand_id: brandId, count: posts.length, posts };
      },
    },
    {
      name: "draft_post",
      description:
        "Register a draft for a channel. Every draft is checked against the platform's hard rules, the brand's voice " +
        "profile, disclosure requirements, UTM hygiene, claim substantiation and duplicate history before your reply " +
        "is released. Drafting is free; publishing is not — this does not schedule anything.",
      parameters: {
        channel_id: "Channel this draft is for.",
        body: "The full post body exactly as it would publish, including hashtags and links.",
        has_media: 'Pass "true" if an image or video accompanies the post.',
        sponsored: 'Pass "true" if this is paid or sponsored content.',
      },
      handler(input) {
        const channelId = str(input, "channel_id");
        const body = str(input, "body");
        const channel = domain.getChannel(channelId);
        if (!channel) throw new Error(`unknown channel: ${channelId}`);

        const spec = platformSpec(channel.platform);
        return {
          channel_id: channelId,
          brand_id: channel.brandId,
          platform: channel.platform,
          body,
          has_media: bool(input, "has_media"),
          sponsored: bool(input, "sponsored"),
          character_count: spec ? effectiveLength(body, spec) : body.length,
          hashtags: extractHashtags(body),
          links: extractLinks(body),
          status: "drafted_pending_verification",
        };
      },
    },
    {
      name: "schedule_post",
      description:
        "Schedule an approved draft to publish. This reaches the outside world, so it always pauses for a human.",
      parameters: {
        channel_id: "Channel identifier.",
        body: "The exact body to publish.",
        publish_at: "Epoch milliseconds to publish at.",
      },
      handler(input) {
        const channelId = str(input, "channel_id");
        const body = str(input, "body");
        const publishAt = optNum(input, "publish_at", Date.now());
        const post = domain.createPost({ channelId, body, status: "scheduled", publishedAt: null });
        return { post_id: post.id, channel_id: channelId, publish_at: publishAt, status: "scheduled" };
      },
    },
  ];
}
