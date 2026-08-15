---
name: position-reconciliation
description: Tie the internal position book to the custodian statement and produce a break report.
triggers: reconcile, reconciliation, break, custodian, tie out, position report
---

# Position reconciliation

1. Call `reconcile` with the book id. Its output is authoritative — your reply must agree with it exactly, including
   the break count and the symbol list.
2. For each break, pull context before explaining it:
   - `positions` and `custodian_positions` for the raw quantities on both sides.
   - `market_data` for the symbol over the period, to value the difference.
3. Classify each break. The usual causes, in the order they are worth checking:
   - **Timing** — a trade booked internally on T that the custodian settles on T+1 or T+2.
   - **Corporate action** — a split, dividend in stock, or symbol change applied on one side only.
   - **Fee or accrual** — the custodian nets a fee into the quantity or the cash leg.
   - **Booking error** — a fat-fingered quantity, or a trade booked to the wrong book.
4. Write the report with `write_file` as `reconciliation/<book>-<date>.md`, containing: the break count, a table of
   breaks with internal quantity, custodian quantity, difference and valued difference, and a proposed cause per break.
5. In your reply, state the break count first, then name every breaking symbol.

Never write that a book is clean, ties out, or has no breaks unless `reconcile` returned zero breaks.
