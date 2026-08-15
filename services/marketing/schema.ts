export const MARKETING_SCHEMA = `
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS brands_project ON brands(project_id);

CREATE TABLE IF NOT EXISTS voice_profiles (
  brand_id TEXT PRIMARY KEY,
  tone TEXT NOT NULL,
  reading_grade_max REAL NOT NULL DEFAULT 12,
  banned_phrases_json TEXT NOT NULL DEFAULT '[]',
  required_phrases_json TEXT NOT NULL DEFAULT '[]',
  emoji_allowed INTEGER NOT NULL DEFAULT 1,
  sample_posts_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  followers INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS channels_brand ON channels(brand_id);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  sponsored INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posts_channel ON posts(channel_id, published_at DESC);

CREATE TABLE IF NOT EXISTS post_metrics (
  post_id TEXT PRIMARY KEY,
  impressions INTEGER NOT NULL DEFAULT 0,
  engagements INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS competitor_posts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  competitor TEXT NOT NULL,
  platform TEXT NOT NULL,
  body TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  engagements INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS competitor_brand ON competitor_posts(brand_id, observed_at DESC);
`;
