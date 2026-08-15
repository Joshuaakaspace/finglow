---
name: repurpose-long-form
description: Turn one long-form asset into a set of platform-native posts that do not read like the same post reformatted.
triggers: repurpose, atomize, turn this into, cross-post, blog into, thread, carousel
---

# Repurpose a long-form asset into platform-native posts

The failure mode is posting the same paragraph five times with different hashtags. Each platform gets a post shaped for
how people actually read on it.

1. Pull the source. Identify the three or four claims in it that stand on their own — a claim that needs the article's
   setup to make sense is not a candidate.
2. Read `brand_voice` and, for every destination, `platform_spec`.
3. Shape per platform:
   - **x** — one claim, one sentence of support. Under 280 including the 23 characters a link costs. At most two
     hashtags; three is the cap but reach drops.
   - **linkedin** — the hook must land inside the first ~140 characters, because everything after that is behind
     "see more". Then three or four short paragraphs. One link at most.
   - **instagram** — the caption cannot be clicked, so no URL. Write the first line as the hook and put the call to
     action at the end. Media is required.
   - **tiktok** — the caption supports the video; it does not carry the message. Keep it to one line and a hook.
   - **threads** — conversational, one tag maximum.
4. Register each with `draft_post`, then fix whatever the checks return.

Vary the opening line across platforms. If two drafts share their first eight words, rewrite one.
