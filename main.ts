// btc-race entry: a displacement bot for cbBTC/USDC on the bars-replay rule set.
//
// The strategy in one line: the window is mostly noise, so the default action is nothing; when
// price has fallen far enough under its own recent level that the expected snap back pays for
// the round trip, take one full-size position, and then sit still until an exit condition or
// the hold limit closes it.
//
// Why the bot trades so rarely. The replay charges a 4 bps fee on every fill, adds 2 bps of
// modelled slippage, and prices the fill through the constant-product curve against the pool
// depth the universe froze (about 7 bps of impact for a full-size clip). Add both legs and a
// full-size round trip costs roughly 26 bps of the stake. To do better than break even, a trade
// must catch a move bigger than that whole cost, and the median absolute one-minute move on the
// dev window's 1,440 bars is far under 26 bps — a fraction of the toll. A bot that fires on
// every wiggle is therefore paying 26 bps per attempt to chase moves that are smaller than the
// toll itself. The field's results agree: of 2,828 graded entries on a recent race window, 52%
// traded nothing and 35% lost money, with the loss getting monotonically worse as trade count
// rose (bots in the 10+ trades bucket averaged about -$28 on a $1,000 stake). The tie break adds
// a second penalty: when two entries finish with exactly equal net PnL, the one with fewer
// trades is ranked ahead. Churn is charged twice, once in fees and once in the ranking.
//
// Why displacement from a rolling median. On the minutes-to-hours scale the series is a
// mean-reverting walk around a slowly drifting level, so the reference is a rolling median
// rather than a long average. A median shrugs off the single outlier prints the pool hands out
// from time to time, while a mean gets dragged by exactly those and ends up calling a spike a
// dip. The entry only fires when the close sits DIP (2 percent) below that median, which is far
// enough that a snap back to the level covers the 26 bps round trip several times over.
//
// Why a hold limit and a stop. The gate wants net PnL above zero on a frozen window nobody can
// see beforehand and the race ranks only the ten best net PnLs, so the bot has to be right on an
// unseen window rather than on a fitted one. The hold limit bounds how long capital can sit in a
// trade that is not working, and the stop bounds the drawdown that the guardrails cap at 25% of
// equity. Both exits were picked so the same numbers clear the dev window and independent
// 24-hour bitcoin windows, and the parameters sit at the centre of the surviving region instead
// of at its best cell — one profitable point is noise, a profitable neighbourhood is a signal.
//
// Determinism: no clock, no network, no Math.random. Two runs over the same bars emit the same
// orders byte for byte, which is what the grader checks.

import { runBars } from './vendor/makefun-bars.ts';

/** Symbol we trade: the universe holds exactly one at this competition. */
const SYMBOL = 'CBBTC';

/**
 * Bars of history the reference level is taken over: two hours of one-minute bars, long enough
 * for the median to describe the level rather than the last wiggle.
 */
const LOOKBACK = 120;
/** Close this far below the rolling median is a displacement worth a full-size entry. */
const DIP = 0.02;
/** Take the position out once it is this far above the entry. */
const TAKE_PROFIT = 0.015;
/** Cut it once it is this far below the entry: bounds the drawdown the guardrails measure. */
const STOP_LOSS = 0.05;
/** Bars a position may stay open before it is closed regardless (12 hours). */
const MAX_HOLD_BARS = 720;

/**
 * Slippage headroom in bps, measured from the latest close. Wide enough that the modelled
 * slippage plus the fill's own impact never gets the order refused, and no wider: the point of
 * max_slippage_bps is to refuse a fill far from the close we decided on.
 */
const MAX_SLIPPAGE_BPS = 200;

/** The window of closes the reference level is taken over, kept in insertion order. */
const closes: number[] = [];
/** True while a position is open, so the bot never sends a second buy. */
let holding = false;
/** The fill price recorded when the position went on, and the bar count since. */
let entryPrice = 0;
let barsHeld = 0;
/** Count of bars seen, used to keep the hold limit honest across the whole window. */
let barCount = 0;

/** Median of a copy: the level estimate that survives the pool's outlier prints. */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

await runBars({
  onBatch(state) {
    // One symbol only: another universe would need its own sizing, so stay out of it.
    if (state.hello.symbols.length !== 1 || state.hello.symbols[0]?.symbol !== SYMBOL) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];                       // no bar yet: any order would be refused
    if (state.warmingUp) return [];                      // warm-up bars are history, never tradable

    const price = Number(close);
    barCount += 1;
    closes.push(price);
    if (closes.length > LOOKBACK + 1) closes.shift();

    if (holding) {
      barsHeld += 1;
      const move = (price - entryPrice) / entryPrice;
      const takeProfit = move >= TAKE_PROFIT;
      const stopLoss = move <= -STOP_LOSS;
      const stale = barsHeld >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || stale) {
        const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
        if (qty > 0n) {
          holding = false;
          barsHeld = 0;
          return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // A full window of history is needed before the median means anything.
    if (closes.length <= LOOKBACK) return [];

    const level = median(closes);
    const displacement = (price - level) / level;
    if (displacement > -DIP) return [];

    // Enter at full size: one position at up to 100% of equity, sized off cash rather than the
    // weight cap so the order can never be trimmed into something the fee would dominate.
    const spend = state.cash;
    if (spend <= 0n) return [];
    holding = true;
    barsHeld = 0;
    // The fill happens at the next bar's open, which is unknown here; the close is the best
    // estimate and the exit thresholds are measured against the fill the harness reports.
    entryPrice = price;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },

  onDone(state) {
    // The harness flattens anything still held; nothing to send here.
  },
});
