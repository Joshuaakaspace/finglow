import { badRequest, notFound, requireString, type Router } from "../../kernel/http.ts";
import type { Store } from "../../kernel/store.ts";
import type { MarketingDomain } from "./domain.ts";
import { PLATFORM_SPECS, platformSpec } from "./platforms.ts";

function stringArray(body: unknown, field: string): string[] {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw badRequest(`"${field}" must be an array of strings`);
  }
  return value as string[];
}

export function registerMarketingRoutes(deps: { router: Router; store: Store; domain: MarketingDomain }): void {
  const { router, store, domain } = deps;

  router.get("/platforms", () => ({ platforms: PLATFORM_SPECS }));

  router.get("/platforms/:platform", (ctx) => {
    const spec = platformSpec(ctx.params.platform);
    if (!spec) throw notFound(`platform ${ctx.params.platform}`);
    return spec;
  });

  router.post("/projects/:id/brands", (ctx) => {
    const project = store.getProject(ctx.params.id);
    if (!project) throw notFound(`project ${ctx.params.id}`);
    const brand = domain.createBrand(project.id, requireString(ctx.body, "name"));
    store.updateProjectSettings(project.id, { ...project.settings, brandId: brand.id });
    store.audit(project.owner, "brand.create", brand.id, { projectId: project.id });
    return brand;
  });

  router.get("/projects/:id/brands", (ctx) => ({ brands: domain.listBrands(ctx.params.id) }));

  router.post("/brands/:id/voice", (ctx) => {
    if (!domain.getBrand(ctx.params.id)) throw notFound(`brand ${ctx.params.id}`);
    const body = ctx.body as Record<string, unknown>;
    domain.setVoiceProfile({
      brandId: ctx.params.id,
      tone: requireString(ctx.body, "tone"),
      readingGradeMax: Number(body.readingGradeMax ?? 12),
      bannedPhrases: stringArray(ctx.body, "bannedPhrases"),
      requiredPhrases: stringArray(ctx.body, "requiredPhrases"),
      emojiAllowed: body.emojiAllowed !== false,
      samplePosts: stringArray(ctx.body, "samplePosts"),
    });
    return domain.voiceProfile(ctx.params.id);
  });

  router.get("/brands/:id/voice", (ctx) => {
    const profile = domain.voiceProfile(ctx.params.id);
    if (!profile) throw notFound(`voice profile for brand ${ctx.params.id}`);
    return profile;
  });

  router.post("/brands/:id/channels", (ctx) => {
    if (!domain.getBrand(ctx.params.id)) throw notFound(`brand ${ctx.params.id}`);
    const platform = requireString(ctx.body, "platform");
    if (!platformSpec(platform)) throw badRequest(`unknown platform: ${platform}`);
    return domain.createChannel(
      ctx.params.id,
      platform,
      requireString(ctx.body, "handle"),
      Number((ctx.body as Record<string, unknown>).followers ?? 0),
    );
  });

  router.get("/brands/:id/channels", (ctx) => ({ channels: domain.listChannels(ctx.params.id) }));

  router.get("/brands/:id/competitors", (ctx) => ({
    posts: domain.competitorPosts(ctx.params.id, Number(ctx.query.get("limit") ?? 50)),
  }));

  router.post("/brands/:id/competitors", (ctx) => {
    if (!domain.getBrand(ctx.params.id)) throw notFound(`brand ${ctx.params.id}`);
    const body = ctx.body as Record<string, unknown>;
    return domain.addCompetitorPost({
      brandId: ctx.params.id,
      competitor: requireString(ctx.body, "competitor"),
      platform: requireString(ctx.body, "platform"),
      body: requireString(ctx.body, "body"),
      observedAt: Number(body.observedAt ?? Date.now()),
      engagements: Number(body.engagements ?? 0),
    });
  });

  router.post("/channels/:id/posts", (ctx) => {
    if (!domain.getChannel(ctx.params.id)) throw notFound(`channel ${ctx.params.id}`);
    const body = ctx.body as Record<string, unknown>;
    const post = domain.createPost({
      channelId: ctx.params.id,
      body: requireString(ctx.body, "body"),
      publishedAt: body.publishedAt === undefined ? Date.now() : Number(body.publishedAt),
      status: typeof body.status === "string" ? body.status : "published",
      sponsored: body.sponsored === true,
    });
    if (body.metrics && typeof body.metrics === "object") {
      const m = body.metrics as Record<string, unknown>;
      domain.setMetrics({
        postId: post.id,
        impressions: Number(m.impressions ?? 0),
        engagements: Number(m.engagements ?? 0),
        clicks: Number(m.clicks ?? 0),
      });
    }
    return post;
  });

  router.get("/channels/:id/posts", (ctx) => ({ posts: domain.publishedPosts(ctx.params.id) }));

  router.get("/channels/:id/metrics", (ctx) => {
    if (!domain.getChannel(ctx.params.id)) throw notFound(`channel ${ctx.params.id}`);
    return { channel_id: ctx.params.id, ...domain.channelMetrics(ctx.params.id) };
  });
}
