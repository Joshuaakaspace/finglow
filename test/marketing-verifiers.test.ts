import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../kernel/db.ts";
import { createMarketingDomain, type MarketingDomain } from "../services/marketing/domain.ts";
import { MARKETING_SCHEMA } from "../services/marketing/schema.ts";
import {
  brandVoiceVerifier,
  claimSubstantiationVerifier,
  disclosureVerifier,
  duplicateContentVerifier,
  jaccard,
  platformConstraintVerifier,
  readingGrade,
  utmVerifier,
} from "../services/marketing/verifiers.ts";
import { effectiveLength, extractHashtags, extractLinks, platformSpec } from "../services/marketing/platforms.ts";
import { codes, toolCall, verificationInput } from "./support/helpers.ts";

function freshDomain(): MarketingDomain {
  return createMarketingDomain(openDatabase(":memory:", MARKETING_SCHEMA));
}

interface DraftOptions {
  platform?: string;
  channelId?: string;
  brandId?: string;
  hasMedia?: boolean;
  sponsored?: boolean;
}

function draft(body: string, options: DraftOptions = {}) {
  return toolCall(
    "draft_post",
    { channel_id: options.channelId ?? "chan_1" },
    {
      channel_id: options.channelId ?? "chan_1",
      brand_id: options.brandId ?? "brand_1",
      platform: options.platform ?? "x",
      body,
      has_media: options.hasMedia ?? false,
      sponsored: options.sponsored ?? false,
    },
  );
}

describe("platform helpers", () => {
  test("counts an X link as a flat 23 characters", () => {
    const spec = platformSpec("x")!;
    const link = "https://example.com/a/very/long/path/that/keeps/going/and/going";
    assert.equal(effectiveLength(`hi ${link}`, spec), 3 + 23);
  });

  test("extracts hashtags and links without swallowing anchors or hex colours", () => {
    assert.deepEqual(extractHashtags("a #One and #two_3 but not colour#ffffff"), ["#One", "#two_3"]);
    assert.deepEqual(extractLinks("see https://a.test/x?y=1 now"), ["https://a.test/x?y=1"]);
  });
});

describe("platform-constraints", () => {
  const verifier = platformConstraintVerifier();

  test("passes a well-formed post", () => {
    assert.deepEqual(verifier.run(verificationInput({ toolCalls: [draft("A short, clean post. #ship")] })), []);
  });

  test("blocks an over-length post", () => {
    const findings = verifier.run(verificationInput({ toolCalls: [draft("x".repeat(300))] }));
    assert.deepEqual(codes(findings), ["too_long"]);
    assert.match(findings[0].message, /over by 20/);
  });

  test("blocks too many hashtags", () => {
    const findings = verifier.run(verificationInput({ toolCalls: [draft("post #a #b #c #d")] }));
    assert.deepEqual(codes(findings), ["too_many_hashtags"]);
  });

  test("blocks a bare URL in an Instagram caption", () => {
    const findings = verifier.run(
      verificationInput({
        toolCalls: [draft("Look at this https://a.test/x", { platform: "instagram", hasMedia: true })],
      }),
    );
    assert.deepEqual(codes(findings), ["too_many_links"]);
    assert.match(findings[0].message, /not clickable/);
  });

  test("blocks a media-required platform with no media", () => {
    const findings = verifier.run(verificationInput({ toolCalls: [draft("caption", { platform: "tiktok" })] }));
    assert.deepEqual(codes(findings), ["media_required"]);
  });

  test("blocks an unknown platform", () => {
    const findings = verifier.run(verificationInput({ toolCalls: [draft("post", { platform: "myspace" })] }));
    assert.deepEqual(codes(findings), ["unknown_platform"]);
  });
});

describe("brand-voice", () => {
  let domain: MarketingDomain;
  let brandId: string;

  beforeEach(() => {
    domain = freshDomain();
    brandId = domain.createBrand("prj", "Northwind").id;
    domain.setVoiceProfile({
      brandId,
      tone: "plain",
      readingGradeMax: 9,
      bannedPhrases: ["game-changer", "synergy"],
      requiredPhrases: [],
      emojiAllowed: false,
      samplePosts: [],
    });
  });

  test("passes an on-voice post", () => {
    const findings = brandVoiceVerifier(domain).run(
      verificationInput({ toolCalls: [draft("We cut signup to two steps. Here is what we removed.", { brandId })] }),
    );
    assert.deepEqual(findings, []);
  });

  test("blocks a banned phrase", () => {
    const findings = brandVoiceVerifier(domain).run(
      verificationInput({ toolCalls: [draft("This is a real game-changer.", { brandId })] }),
    );
    assert.deepEqual(codes(findings), ["banned_phrase"]);
    assert.equal(findings[0].severity, "block");
  });

  test("blocks emoji when the profile forbids them", () => {
    const findings = brandVoiceVerifier(domain).run(
      verificationInput({ toolCalls: [draft("Shipped it 🚀", { brandId })] }),
    );
    assert.deepEqual(codes(findings), ["emoji_not_allowed"]);
  });

  test("blocks a missing required phrase", () => {
    domain.setVoiceProfile({
      brandId,
      tone: "plain",
      readingGradeMax: 20,
      bannedPhrases: [],
      requiredPhrases: ["Northwind"],
      emojiAllowed: true,
      samplePosts: [],
    });
    const findings = brandVoiceVerifier(domain).run(
      verificationInput({ toolCalls: [draft("A post with no brand name.", { brandId })] }),
    );
    assert.deepEqual(codes(findings), ["missing_required_phrase"]);
  });

  test("warns above the reading-level ceiling", () => {
    const dense =
      "Notwithstanding the aforementioned considerations, the organisational transformation initiative " +
      "necessitates comprehensive reconceptualisation of interdepartmental communication methodologies.";
    const findings = brandVoiceVerifier(domain).run(verificationInput({ toolCalls: [draft(dense, { brandId })] }));
    assert.deepEqual(codes(findings), ["reading_level"]);
    assert.equal(findings[0].severity, "warn");
  });

  test("does not let a URL inflate the reading grade", () => {
    const plain = "We cut signup to two steps. Here is what we removed.";
    const withLink = `${plain} https://northwind.example/blog/signup-teardown?utm_source=x`;
    assert.ok(Math.abs(readingGrade(plain) - readingGrade(withLink)) < 0.001);
  });
});

describe("disclosure", () => {
  const verifier = disclosureVerifier();

  test("ignores organic posts", () => {
    assert.deepEqual(verifier.run(verificationInput({ toolCalls: [draft("Just a post.")] })), []);
  });

  test("blocks sponsored content with no disclosure", () => {
    const findings = verifier.run(verificationInput({ toolCalls: [draft("Try this product.", { sponsored: true })] }));
    assert.deepEqual(codes(findings), ["missing_disclosure"]);
    assert.equal(findings[0].severity, "block");
  });

  test("accepts a clear disclosure near the start", () => {
    const findings = verifier.run(
      verificationInput({ toolCalls: [draft("#ad We partnered with Acme on this.", { sponsored: true })] }),
    );
    assert.deepEqual(findings, []);
  });

  test("warns when the disclosure is buried at the end", () => {
    const body = `${"We really like this product and here is a long explanation of exactly why. ".repeat(3)}#ad`;
    const findings = verifier.run(verificationInput({ toolCalls: [draft(body, { sponsored: true })] }));
    assert.deepEqual(codes(findings), ["buried_disclosure"]);
    assert.equal(findings[0].severity, "warn");
  });
});

describe("utm-hygiene", () => {
  const verifier = utmVerifier();

  test("passes a fully tagged lowercase link", () => {
    const findings = verifier.run(
      verificationInput({
        toolCalls: [draft("Read it https://a.test/p?utm_source=x&utm_medium=social&utm_campaign=launch")],
      }),
    );
    assert.deepEqual(findings, []);
  });

  test("blocks missing UTM parameters", () => {
    const findings = verifier.run(verificationInput({ toolCalls: [draft("Read it https://a.test/p")] }));
    assert.deepEqual(codes(findings), ["missing_utm"]);
    assert.match(findings[0].message, /utm_source, utm_medium, utm_campaign/);
  });

  test("blocks uppercase parameter values", () => {
    const findings = verifier.run(
      verificationInput({
        toolCalls: [draft("Read it https://a.test/p?utm_source=X&utm_medium=social&utm_campaign=Launch")],
      }),
    );
    assert.deepEqual(codes(findings), ["uppercase_utm", "uppercase_utm"]);
  });

  test("blocks a duplicated parameter", () => {
    const findings = verifier.run(
      verificationInput({
        toolCalls: [draft("https://a.test/p?utm_source=x&utm_source=y&utm_medium=social&utm_campaign=launch")],
      }),
    );
    assert.ok(findings.some((f) => f.code === "duplicate_utm"));
  });
});

describe("claim-substantiation", () => {
  const verifier = claimSubstantiationVerifier();

  test("blocks an unqualified guarantee", () => {
    const findings = verifier.run(verificationInput({ toolCalls: [draft("Guaranteed results in 30 days.")] }));
    assert.deepEqual(codes(findings), ["absolute_guarantee"]);
    assert.equal(findings[0].severity, "block");
  });

  test("blocks a health claim even when a source is cited", () => {
    const findings = verifier.run(
      verificationInput({ reply: "According to the study we cited.", toolCalls: [draft("It cures insomnia.")] }),
    );
    assert.deepEqual(codes(findings), ["health_claim"]);
  });

  test("warns on an uncited superlative and clears it once cited", () => {
    assert.deepEqual(codes(verifier.run(verificationInput({ toolCalls: [draft("The best tool on the market.")] }))), [
      "superlative",
    ]);
    assert.deepEqual(
      verifier.run(
        verificationInput({
          reply: "Ranking is per the 2026 G2 report.",
          toolCalls: [draft("The best tool on the market.")],
        }),
      ),
      [],
    );
  });

  test("leaves ordinary copy alone", () => {
    assert.deepEqual(verifier.run(verificationInput({ toolCalls: [draft("We shipped a faster importer.")] })), []);
  });
});

describe("duplicate-content", () => {
  let domain: MarketingDomain;
  let channelId: string;

  beforeEach(() => {
    domain = freshDomain();
    const brand = domain.createBrand("prj", "Northwind");
    channelId = domain.createChannel(brand.id, "x", "@northwind").id;
    domain.createPost({
      channelId,
      body: "We cut onboarding from six steps to two. Here is what we removed and why.",
      publishedAt: Date.now() - 1000,
      status: "published",
    });
  });

  test("blocks a near-duplicate of an existing post", () => {
    const findings = duplicateContentVerifier(domain).run(
      verificationInput({
        toolCalls: [draft("We cut onboarding from six steps to two — here is what we removed and why!", { channelId })],
      }),
    );
    assert.deepEqual(codes(findings), ["near_duplicate"]);
    assert.equal(findings[0].severity, "block");
  });

  test("allows genuinely new copy", () => {
    const findings = duplicateContentVerifier(domain).run(
      verificationInput({ toolCalls: [draft("Billing errors are a writing problem first.", { channelId })] }),
    );
    assert.deepEqual(findings, []);
  });

  test("jaccard similarity behaves at the edges", () => {
    assert.equal(jaccard(new Set(), new Set(["a"])), 0);
    assert.equal(jaccard(new Set(["aaa", "bbb"]), new Set(["aaa", "bbb"])), 1);
  });
});
