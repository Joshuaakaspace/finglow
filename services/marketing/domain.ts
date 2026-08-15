import type { Db } from "../../kernel/db.ts";
import { fromJson, toJson } from "../../kernel/db.ts";
import { newId, now } from "../../kernel/ids.ts";

export interface Brand {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
}

export interface VoiceProfile {
  brandId: string;
  tone: string;
  readingGradeMax: number;
  bannedPhrases: string[];
  requiredPhrases: string[];
  emojiAllowed: boolean;
  samplePosts: string[];
}

export interface Channel {
  id: string;
  brandId: string;
  platform: string;
  handle: string;
  followers: number;
}

export interface Post {
  id: string;
  channelId: string;
  body: string;
  publishedAt: number | null;
  status: string;
  sponsored: boolean;
}

export interface PostMetrics {
  postId: string;
  impressions: number;
  engagements: number;
  clicks: number;
}

export interface CompetitorPost {
  id: string;
  brandId: string;
  competitor: string;
  platform: string;
  body: string;
  observedAt: number;
  engagements: number;
}

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v ?? "");
const n = (v: unknown): number => Number(v ?? 0);

export function createMarketingDomain(db: Db) {
  const voiceRow = (r: Row): VoiceProfile => ({
    brandId: s(r.brand_id),
    tone: s(r.tone),
    readingGradeMax: n(r.reading_grade_max),
    bannedPhrases: fromJson<string[]>(r.banned_phrases_json, []),
    requiredPhrases: fromJson<string[]>(r.required_phrases_json, []),
    emojiAllowed: n(r.emoji_allowed) === 1,
    samplePosts: fromJson<string[]>(r.sample_posts_json, []),
  });

  const postRow = (r: Row): Post => ({
    id: s(r.id),
    channelId: s(r.channel_id),
    body: s(r.body),
    publishedAt: r.published_at === null || r.published_at === undefined ? null : n(r.published_at),
    status: s(r.status),
    sponsored: n(r.sponsored) === 1,
  });

  return {
    createBrand(projectId: string, name: string): Brand {
      const brand: Brand = { id: newId("brand"), projectId, name, createdAt: now() };
      db.prepare("INSERT INTO brands (id, project_id, name, created_at) VALUES (?, ?, ?, ?)").run(
        brand.id,
        brand.projectId,
        brand.name,
        brand.createdAt,
      );
      return brand;
    },

    getBrand(brandId: string): Brand | null {
      const r = db.prepare("SELECT * FROM brands WHERE id = ?").get(brandId) as Row | undefined;
      return r ? { id: s(r.id), projectId: s(r.project_id), name: s(r.name), createdAt: n(r.created_at) } : null;
    },

    listBrands(projectId: string): Brand[] {
      const rows = db.prepare("SELECT * FROM brands WHERE project_id = ? ORDER BY name").all(projectId) as Row[];
      return rows.map((r) => ({ id: s(r.id), projectId: s(r.project_id), name: s(r.name), createdAt: n(r.created_at) }));
    },

    setVoiceProfile(profile: VoiceProfile): void {
      db.prepare(
        "INSERT INTO voice_profiles (brand_id, tone, reading_grade_max, banned_phrases_json, required_phrases_json, emoji_allowed, sample_posts_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(brand_id) DO UPDATE SET tone = excluded.tone, " +
          "reading_grade_max = excluded.reading_grade_max, banned_phrases_json = excluded.banned_phrases_json, " +
          "required_phrases_json = excluded.required_phrases_json, emoji_allowed = excluded.emoji_allowed, " +
          "sample_posts_json = excluded.sample_posts_json",
      ).run(
        profile.brandId,
        profile.tone,
        profile.readingGradeMax,
        toJson(profile.bannedPhrases),
        toJson(profile.requiredPhrases),
        profile.emojiAllowed ? 1 : 0,
        toJson(profile.samplePosts),
      );
    },

    voiceProfile(brandId: string): VoiceProfile | null {
      const r = db.prepare("SELECT * FROM voice_profiles WHERE brand_id = ?").get(brandId) as Row | undefined;
      return r ? voiceRow(r) : null;
    },

    createChannel(brandId: string, platform: string, handle: string, followers = 0): Channel {
      const channel: Channel = { id: newId("chan"), brandId, platform: platform.toLowerCase(), handle, followers };
      db.prepare("INSERT INTO channels (id, brand_id, platform, handle, followers) VALUES (?, ?, ?, ?, ?)").run(
        channel.id,
        channel.brandId,
        channel.platform,
        channel.handle,
        channel.followers,
      );
      return channel;
    },

    getChannel(channelId: string): Channel | null {
      const r = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as Row | undefined;
      return r
        ? {
            id: s(r.id),
            brandId: s(r.brand_id),
            platform: s(r.platform),
            handle: s(r.handle),
            followers: n(r.followers),
          }
        : null;
    },

    listChannels(brandId: string): Channel[] {
      const rows = db.prepare("SELECT * FROM channels WHERE brand_id = ? ORDER BY platform").all(brandId) as Row[];
      return rows.map((r) => ({
        id: s(r.id),
        brandId: s(r.brand_id),
        platform: s(r.platform),
        handle: s(r.handle),
        followers: n(r.followers),
      }));
    },

    createPost(input: { channelId: string; body: string; publishedAt?: number | null; status?: string; sponsored?: boolean }): Post {
      const post: Post = {
        id: newId("post"),
        channelId: input.channelId,
        body: input.body,
        publishedAt: input.publishedAt ?? null,
        status: input.status ?? "draft",
        sponsored: input.sponsored ?? false,
      };
      db.prepare(
        "INSERT INTO posts (id, channel_id, body, published_at, status, sponsored) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(post.id, post.channelId, post.body, post.publishedAt, post.status, post.sponsored ? 1 : 0);
      return post;
    },

    publishedPosts(channelId: string, limit = 200): Post[] {
      const rows = db
        .prepare("SELECT * FROM posts WHERE channel_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT ?")
        .all(channelId, limit) as Row[];
      return rows.map(postRow);
    },

    postsForBrand(brandId: string, limit = 500): Post[] {
      const rows = db
        .prepare(
          "SELECT posts.* FROM posts JOIN channels ON channels.id = posts.channel_id WHERE channels.brand_id = ? " +
            "ORDER BY posts.published_at DESC LIMIT ?",
        )
        .all(brandId, limit) as Row[];
      return rows.map(postRow);
    },

    setMetrics(metrics: PostMetrics): void {
      db.prepare(
        "INSERT INTO post_metrics (post_id, impressions, engagements, clicks) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(post_id) DO UPDATE SET impressions = excluded.impressions, " +
          "engagements = excluded.engagements, clicks = excluded.clicks",
      ).run(metrics.postId, metrics.impressions, metrics.engagements, metrics.clicks);
    },

    channelMetrics(channelId: string): {
      posts: number;
      impressions: number;
      engagements: number;
      clicks: number;
      engagementRate: number;
    } {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS posts, COALESCE(SUM(m.impressions), 0) AS impressions, " +
            "COALESCE(SUM(m.engagements), 0) AS engagements, COALESCE(SUM(m.clicks), 0) AS clicks " +
            "FROM posts p LEFT JOIN post_metrics m ON m.post_id = p.id WHERE p.channel_id = ?",
        )
        .get(channelId) as Row | undefined;

      const impressions = n(row?.impressions);
      const engagements = n(row?.engagements);
      return {
        posts: n(row?.posts),
        impressions,
        engagements,
        clicks: n(row?.clicks),
        engagementRate: impressions > 0 ? engagements / impressions : 0,
      };
    },

    addCompetitorPost(post: Omit<CompetitorPost, "id">): CompetitorPost {
      const record: CompetitorPost = { ...post, id: newId("cpost") };
      db.prepare(
        "INSERT INTO competitor_posts (id, brand_id, competitor, platform, body, observed_at, engagements) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        record.id,
        record.brandId,
        record.competitor,
        record.platform,
        record.body,
        record.observedAt,
        record.engagements,
      );
      return record;
    },

    competitorPosts(brandId: string, limit = 50): CompetitorPost[] {
      const rows = db
        .prepare("SELECT * FROM competitor_posts WHERE brand_id = ? ORDER BY observed_at DESC LIMIT ?")
        .all(brandId, limit) as Row[];
      return rows.map((r) => ({
        id: s(r.id),
        brandId: s(r.brand_id),
        competitor: s(r.competitor),
        platform: s(r.platform),
        body: s(r.body),
        observedAt: n(r.observed_at),
        engagements: n(r.engagements),
      }));
    },
  };
}

export type MarketingDomain = ReturnType<typeof createMarketingDomain>;
