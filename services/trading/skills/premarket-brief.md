---
name: premarket-brief
description: Produce a pre-market brief on the firm's actual book rather than the market in general.
triggers: brief, premarket, pre-market, morning, daily, overnight, summary of the book
---

# Pre-market brief

A brief is about *this book*, not the market. Anything that is not tied to a held position belongs at the end, if at all.

1. `positions` for the book — this is the subject of the brief.
2. `risk_limits` for the book — note current gross exposure against the cap and how much room is left.
3. `market_data` for each held symbol over the last 30 sessions.
4. Write a script that computes, per position: last close, overnight and 5-day move, position value, and share of
   gross. Print a table. Print the totals separately.
5. Rank the positions by absolute move, not alphabetically. Lead with the largest mover.

The reply should open with one sentence: what moved and what it did to the book. Then the table. Then anything that is
approaching a risk limit. Do not pad it with commentary on positions that did nothing.
