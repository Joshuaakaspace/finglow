---
name: point-in-time-backtest
description: Run a strategy backtest that only ever uses information available at the simulated decision time.
triggers: backtest, strategy, simulate, historical, sharpe, drawdown, signal
---

# Point-in-time backtest

## Build the universe first

Call `list_instruments` with delisted names **included**. A universe of today's survivors tests a strategy on companies
selected for having survived, which inflates every return statistic. If you deliberately restrict the universe, say so
in the reply and give the reason.

## Write the simulation as a script

Use `write_file` to create `backtests/<name>.py`, then run it with `execute`. Print every figure you intend to report —
the numbers in your reply must come from this script's stdout.

Rules the code must follow:

- A signal computed on bar `t` may only read bars `<= t`. Use `.shift(1)` to lag, never `.shift(-n)`.
- Fill forward only. `bfill` copies future prices backwards.
- Split a time series chronologically. Never `shuffle=True`.
- Thresholds must be rolling or expanding. A `.mean()` or `.quantile()` over the whole sample has seen the future.
- Apply costs. State the assumed spread and commission explicitly rather than leaving them at zero.

## Report

Give the period, the universe size, the number of trades, the return, the volatility, the Sharpe, and the maximum
drawdown — each printed by the script. State the cost assumptions alongside the results, because a strategy that only
works at zero cost is not a result.
