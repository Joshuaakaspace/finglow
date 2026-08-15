import type { Finding, SyncVerifier, ToolCallRecord, VerificationInput, Verifier } from "../../kernel/types.ts";
import { finding } from "../../kernel/verify.ts";
import type { MarketingDomain } from "./domain.ts";
import { effectiveLength, extractHashtags, extractLinks, platformSpec } from "./platforms.ts";

export interface Draft {
  seq: number;
  platform: string;
  channelId: string | null;
  brandId: string | null;
  body: string;
  hasMedia: boolean;
  sponsored: boolean;
}

export function draftsFrom(toolCalls: ToolCallRecord[]): Draft[] {
  const drafts: Draft[] = [];
  for (const call of toolCalls) {
    if (call.tool !== "draft_post" || !call.ok) continue;
    const output = call.output as Record<string, unknown> | null;
    if (!output || typeof output.body !== "string") continue;
    drafts.push({
      seq: call.seq,
      platform: String(output.platform ?? "").toLowerCase(),
      channelId: typeof output.channel_id === "string" ? output.channel_id : null,
      brandId: typeof output.brand_id === "string" ? output.brand_id : null,
      body: output.body,
      hasMedia: output.has_media === true,
      sponsored: output.sponsored === true,
    });
  }
  return drafts;
}

/** Hard platform rules. A post that violates one cannot be published at all. */
export function platformConstraintVerifier(): SyncVerifier {
  return {
    name: "platform-constraints",
    description: "Enforce each platform's length, hashtag, link and media rules on every draft.",
    run(input: VerificationInput): Finding[] {
      const findings: Finding[] = [];

      for (const draft of draftsFrom(input.toolCalls)) {
        const label = `draft#${draft.seq} (${draft.platform || "unknown"})`;
        const spec = platformSpec(draft.platform);
        if (!spec) {
          findings.push(
            finding("platform-constraints", "block", "unknown_platform", `${label}: unknown platform "${draft.platform}".`),
          );
          continue;
        }

        const length = effectiveLength(draft.body, spec);
        if (length > spec.maxCharacters) {
          findings.push(
            finding(
              "platform-constraints",
              "block",
              "too_long",
              `${label}: ${length} characters, ${spec.maxCharacters} allowed (over by ${length - spec.maxCharacters}).`,
              { length, limit: spec.maxCharacters },
            ),
          );
        }

        const hashtags = extractHashtags(draft.body);
        if (hashtags.length > spec.maxHashtags) {
          findings.push(
            finding(
              "platform-constraints",
              "block",
              "too_many_hashtags",
              `${label}: ${hashtags.length} hashtags, ${spec.maxHashtags} allowed (${hashtags.join(" ")}).`,
              { hashtags, limit: spec.maxHashtags },
            ),
          );
        }

        const links = extractLinks(draft.body);
        if (links.length > spec.maxLinks) {
          const reason =
            spec.maxLinks === 0
              ? `${label}: ${spec.platform} captions are not clickable, so a bare URL is dead text. Move the link to the bio or profile.`
              : `${label}: ${links.length} links, ${spec.maxLinks} allowed.`;
          findings.push(finding("platform-constraints", "block", "too_many_links", reason, { links, limit: spec.maxLinks }));
        }

        if (spec.requiresMedia && !draft.hasMedia) {
          findings.push(
            finding("platform-constraints", "block", "media_required", `${label}: ${spec.platform} requires media.`),
          );
        }
      }
      return findings;
    },
  };
}

function countSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length === 0) return 0;
  if (cleaned.length <= 3) return 1;
  const groups = cleaned
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "")
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/**
 * Flesch–Kincaid grade level over the prose only. URLs, hashtags and mentions
 * are not read as words and would otherwise dominate the syllable count.
 */
export function readingGrade(text: string): number {
  const prose = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)[#@][A-Za-z0-9_]+/g, " ")
    .trim();
  const sentences = Math.max(1, (prose.match(/[.!?]+(\s|$)/g) ?? []).length);
  const words = prose.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length === 0) return 0;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/** Conformance to the brand's stored voice profile — the thing a generic model cannot know. */
export function brandVoiceVerifier(domain: MarketingDomain): SyncVerifier {
  return {
    name: "brand-voice",
    description: "Check drafts against the brand's stored voice profile: banned phrases, emoji policy, reading level.",
    run(input: VerificationInput): Finding[] {
      const findings: Finding[] = [];

      for (const draft of draftsFrom(input.toolCalls)) {
        const brandId = draft.brandId ?? (typeof input.settings.brandId === "string" ? input.settings.brandId : null);
        if (!brandId) continue;
        const profile = domain.voiceProfile(brandId);
        if (!profile) continue;

        const label = `draft#${draft.seq}`;
        const lowerBody = draft.body.toLowerCase();

        for (const phrase of profile.bannedPhrases) {
          if (phrase && lowerBody.includes(phrase.toLowerCase())) {
            findings.push(
              finding(
                "brand-voice",
                "block",
                "banned_phrase",
                `${label}: contains the banned phrase "${phrase}".`,
                { phrase },
              ),
            );
          }
        }

        for (const phrase of profile.requiredPhrases) {
          if (phrase && !lowerBody.includes(phrase.toLowerCase())) {
            findings.push(
              finding("brand-voice", "block", "missing_required_phrase", `${label}: must include "${phrase}".`, {
                phrase,
              }),
            );
          }
        }

        if (!profile.emojiAllowed && EMOJI_PATTERN.test(draft.body)) {
          findings.push(
            finding("brand-voice", "block", "emoji_not_allowed", `${label}: this brand's voice profile forbids emoji.`),
          );
        }

        const grade = readingGrade(draft.body);
        if (grade > profile.readingGradeMax) {
          findings.push(
            finding(
              "brand-voice",
              "warn",
              "reading_level",
              `${label}: reading grade ${grade.toFixed(1)} is above the brand's ceiling of ${profile.readingGradeMax}.`,
              { grade, max: profile.readingGradeMax },
            ),
          );
        }
      }
      return findings;
    },
  };
}

const DISCLOSURE_PATTERN = /(^|\s)#(ad|sponsored|paidpartnership)\b|\bpaid partnership\b|\bsponsored by\b/i;

/** FTC disclosure: a sponsored post must say so, clearly and in the body. */
export function disclosureVerifier(): SyncVerifier {
  return {
    name: "disclosure",
    description: "Sponsored drafts must carry a clear, unambiguous disclosure in the post body.",
    run(input: VerificationInput): Finding[] {
      const findings: Finding[] = [];

      for (const draft of draftsFrom(input.toolCalls)) {
        if (!draft.sponsored) continue;
        if (DISCLOSURE_PATTERN.test(draft.body)) {
          const index = draft.body.search(DISCLOSURE_PATTERN);
          if (index > 0 && index > draft.body.length * 0.75) {
            findings.push(
              finding(
                "disclosure",
                "warn",
                "buried_disclosure",
                `draft#${draft.seq}: the disclosure sits in the last quarter of the post, where it may be hidden behind "see more".`,
                { index, length: draft.body.length },
              ),
            );
          }
          continue;
        }
        findings.push(
          finding(
            "disclosure",
            "block",
            "missing_disclosure",
            `draft#${draft.seq}: sponsored content with no disclosure. Add #ad or #sponsored near the start of the post.`,
          ),
        );
      }
      return findings;
    },
  };
}

const REQUIRED_UTM = ["utm_source", "utm_medium", "utm_campaign"];

/** Untracked or malformed links make the analytics loop worthless. */
export function utmVerifier(): SyncVerifier {
  return {
    name: "utm-hygiene",
    description: "Every outbound link must carry well-formed, lowercase UTM parameters.",
    run(input: VerificationInput): Finding[] {
      const findings: Finding[] = [];

      for (const draft of draftsFrom(input.toolCalls)) {
        for (const raw of extractLinks(draft.body)) {
          const label = `draft#${draft.seq} ${raw}`;
          let url: URL;
          try {
            url = new URL(raw);
          } catch {
            findings.push(finding("utm-hygiene", "block", "malformed_url", `${label}: not a valid URL.`));
            continue;
          }

          const missing = REQUIRED_UTM.filter((p) => !url.searchParams.has(p));
          if (missing.length > 0) {
            findings.push(
              finding("utm-hygiene", "block", "missing_utm", `${label}: missing ${missing.join(", ")}.`, { missing }),
            );
          }

          for (const param of REQUIRED_UTM) {
            const values = url.searchParams.getAll(param);
            if (values.length > 1) {
              findings.push(
                finding("utm-hygiene", "block", "duplicate_utm", `${label}: ${param} appears ${values.length} times.`),
              );
            }
            const value = values[0];
            if (value && value !== value.toLowerCase()) {
              findings.push(
                finding(
                  "utm-hygiene",
                  "block",
                  "uppercase_utm",
                  `${label}: ${param}="${value}" must be lowercase — analytics treats casing variants as separate sources.`,
                ),
              );
            }
            if (value && /\s/.test(value)) {
              findings.push(
                finding("utm-hygiene", "block", "whitespace_utm", `${label}: ${param}="${value}" contains whitespace.`),
              );
            }
          }
        }
      }
      return findings;
    },
  };
}

interface ClaimRule {
  pattern: RegExp;
  code: string;
  severity: Finding["severity"];
  message: string;
}

const CLAIM_RULES: ClaimRule[] = [
  {
    pattern: /\b(guaranteed|guarantee[sd]? results|risk[- ]free|100% (safe|effective|guaranteed))\b/i,
    code: "absolute_guarantee",
    severity: "block",
    message: "an unqualified guarantee",
  },
  {
    pattern: /\b(cures?|heals?|treats?|prevents?)\s+\w+/i,
    code: "health_claim",
    severity: "block",
    message: "a health or medical claim",
  },
  {
    pattern: /\b(#1|number one|the best|world['’]s best|market[- ]leading|unbeatable)\b/i,
    code: "superlative",
    severity: "warn",
    message: "a superlative ranking claim",
  },
  {
    pattern: /\b\d+(\.\d+)?%\s+(more|less|faster|cheaper|better|higher|lower)\b/i,
    code: "comparative_statistic",
    severity: "warn",
    message: "a comparative statistic",
  },
];

const CITATION_PATTERN = /\b(source|per|according to|based on|study|survey|report|data from)\b/i;

/** Advertising claims that would need substantiation before they can run. */
export function claimSubstantiationVerifier(): SyncVerifier {
  return {
    name: "claim-substantiation",
    description: "Flag advertising claims that need evidence before they can be published.",
    run(input: VerificationInput): Finding[] {
      const findings: Finding[] = [];
      const cited = CITATION_PATTERN.test(input.reply);

      for (const draft of draftsFrom(input.toolCalls)) {
        for (const rule of CLAIM_RULES) {
          const match = draft.body.match(rule.pattern);
          if (!match) continue;
          const substantiated = cited || CITATION_PATTERN.test(draft.body);
          if (rule.severity === "warn" && substantiated) continue;
          findings.push(
            finding(
              "claim-substantiation",
              rule.severity,
              rule.code,
              `draft#${draft.seq}: "${match[0]}" is ${rule.message} and needs substantiation on file before it runs.`,
              { excerpt: match[0] },
            ),
          );
        }
      }
      return findings;
    },
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Re-posting something the channel already published burns reach and looks careless. */
export function duplicateContentVerifier(domain: MarketingDomain, threshold = 0.8): SyncVerifier {
  return {
    name: "duplicate-content",
    description: "Reject drafts that closely repeat something the channel already published.",
    run(input: VerificationInput): Finding[] {
      const findings: Finding[] = [];

      for (const draft of draftsFrom(input.toolCalls)) {
        if (!draft.channelId) continue;
        const draftTokens = tokenize(draft.body);
        for (const post of domain.publishedPosts(draft.channelId)) {
          const similarity = jaccard(draftTokens, tokenize(post.body));
          if (similarity < threshold) continue;
          findings.push(
            finding(
              "duplicate-content",
              "block",
              "near_duplicate",
              `draft#${draft.seq}: ${(similarity * 100).toFixed(0)}% overlap with an already-published post on this channel.`,
              { similarity, postId: post.id, existing: post.body.slice(0, 160) },
            ),
          );
          break;
        }
      }
      return findings;
    },
  };
}

export function marketingVerifiers(domain: MarketingDomain): Verifier[] {
  return [
    platformConstraintVerifier(),
    brandVoiceVerifier(domain),
    disclosureVerifier(),
    utmVerifier(),
    claimSubstantiationVerifier(),
    duplicateContentVerifier(domain),
  ];
}
