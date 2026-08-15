---
name: competitor-content-audit
description: Audit what competitors are posting and what is actually working for them, then say what to do about it.
triggers: competitor, competitive, audit, benchmark, what are they posting, market scan
---

# Competitor content audit

An audit that lists what competitors posted is a scrape. An audit that says what to change is the deliverable.

1. `competitor_scan` for the brand, then `analytics` for each of the brand's own channels so the comparison is against
   real numbers rather than impressions of a feed.
2. Write a script with `write_file` and run it with `execute` to compute, per competitor: post count in the window,
   median engagement, top quartile by engagement, and the format mix. Print the table — every figure you report has to
   come from this run.
3. Look for the difference that explains the gap, not the surface features:
   - **Cadence** — are they posting more often, or at different times?
   - **Format** — carousel versus single image, video length, text-only.
   - **Angle** — what claim or emotion do their top-quartile posts share that yours do not?
   - **Hook shape** — how do the first eight words of their best posts open?
4. Write the audit to `audits/<competitor-set>-<date>.md`: the table first, then three specific, testable changes.

Each recommendation must name the format, the cadence, and the metric it should move. "Post more video" is not a
recommendation; "two 15-second product clips per week, measured on completion rate" is.
