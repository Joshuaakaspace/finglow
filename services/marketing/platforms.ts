export interface PlatformSpec {
  platform: string;
  maxCharacters: number;
  maxHashtags: number;
  maxLinks: number;
  requiresMedia: boolean;
  /** Links are stripped from the visible body and do not count toward the limit. */
  linksCountTowardLimit: boolean;
  notes: string;
}

export const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  x: {
    platform: "x",
    maxCharacters: 280,
    maxHashtags: 3,
    maxLinks: 1,
    requiresMedia: false,
    linksCountTowardLimit: true,
    notes: "Links consume 23 characters regardless of length. More than two hashtags measurably depresses reach.",
  },
  linkedin: {
    platform: "linkedin",
    maxCharacters: 3000,
    maxHashtags: 5,
    maxLinks: 1,
    requiresMedia: false,
    linksCountTowardLimit: true,
    notes: "Only the first ~140 characters show before the fold; put the hook there. External links reduce reach.",
  },
  instagram: {
    platform: "instagram",
    maxCharacters: 2200,
    maxHashtags: 30,
    maxLinks: 0,
    requiresMedia: true,
    linksCountTowardLimit: true,
    notes: "Captions are not clickable — never put a bare URL in the caption. Media is mandatory.",
  },
  tiktok: {
    platform: "tiktok",
    maxCharacters: 2200,
    maxHashtags: 5,
    maxLinks: 0,
    requiresMedia: true,
    linksCountTowardLimit: true,
    notes: "Caption is secondary to the video hook. Media is mandatory.",
  },
  facebook: {
    platform: "facebook",
    maxCharacters: 63_206,
    maxHashtags: 5,
    maxLinks: 3,
    requiresMedia: false,
    linksCountTowardLimit: true,
    notes: "Text over ~400 characters is truncated behind 'See more'.",
  },
  threads: {
    platform: "threads",
    maxCharacters: 500,
    maxHashtags: 1,
    maxLinks: 1,
    requiresMedia: false,
    linksCountTowardLimit: true,
    notes: "One topic tag per post is the platform maximum.",
  },
};

export function platformSpec(platform: string): PlatformSpec | null {
  return PLATFORM_SPECS[platform.trim().toLowerCase()] ?? null;
}

export function knownPlatforms(): string[] {
  return Object.keys(PLATFORM_SPECS);
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/g;
const HASHTAG_PATTERN = /(^|[\s(])#([A-Za-z][A-Za-z0-9_]*)/g;

export function extractLinks(body: string): string[] {
  return body.match(URL_PATTERN) ?? [];
}

export function extractHashtags(body: string): string[] {
  const tags: string[] = [];
  for (const match of body.matchAll(HASHTAG_PATTERN)) tags.push(`#${match[2]}`);
  return tags;
}

/** Characters as the platform counts them: on X every link costs a flat 23. */
export function effectiveLength(body: string, spec: PlatformSpec): number {
  if (spec.platform !== "x") return body.length;
  let length = body.length;
  for (const link of extractLinks(body)) length += 23 - link.length;
  return length;
}
