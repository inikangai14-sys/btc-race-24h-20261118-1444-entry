// Sweet-Spot Momentum — a BTC 24h race bot (agent-fun/bars-replay/v1).
//
// Idea: on 1-minute bars BTC is mostly noise (about 7 bp of standard deviation
// per minute) while a full round trip costs about 26 bp, so the bot only trades
// when a real, sustained rally is running — and it never chases a parabolic one.
// It enters long only while the trend is up (fast EMA above slow EMA) AND the
// 60-bar return sits in a sweet spot (strong, 50-100 bp, but not overextended)
// AND the 30-bar return confirms the move is still fresh (>= 40 bp). Buying a
// dip loses on this market (sharp drops keep dropping), so there is no
// mean-reversion entry at all.
//
// Once in, it banks half the position as soon as it is up 60 bp, and lets the
// rest run under a volatility-scaled trailing stop. It exits the rest on the
// trailing stop, on the trend breaking, on a hard stop, or after a maximum hold.
// There is no cooldown after an exit: if the sweet-spot signal is still true,
// the rally is still on and the bot re-enters at once.
//
// Everything here is deterministic: plain float64 arithmetic on the bars, no
// clock, no environment, no randomness. The same bars always give the same orders.
//
// Strategy (the universe holds one symbol, CBBTC):
//   entry (flat): fast EMA above slow EMA, 60-bar return in [RET60_LO, RET60_HI]
//     bp, 30-bar return >= RET30_MIN bp.
//   partial (holding, once): position value >= cost x (1 + PARTIAL_BPS) -> sell half.
//   exit (holding): close below the highest close since entry minus
//     max(TRAIL_ATR_MULT x ATR(14), TRAIL_MIN_BPS), or fast EMA below slow EMA,
//     or the position worth STOP_BPS under its cost, or MAX_HOLD_BARS bars held.
//   sizing: the whole cash balance, up to the weight cap. One position at most.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 24;
const SLOW_SPAN = 120;
const RET30_MIN_BPS = 40;
const RET60_LO_BPS = 50;
const RET60_HI_BPS = 100;
const ATR_SPAN = 14;
const TRAIL_ATR_MULT = 2;
const TRAIL_MIN_BPS = 30;
const PARTIAL_BPS = 60;
const STOP_BPS = 150;
const MAX_HOLD_BARS = 480;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

/** Wilder's ATR: the true ranges it has seen until it starts, then its value. */
interface Atr {
  span: number;
  warm: number[];
  value: number | null;
  prevClose: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  atr: Atr;
  /** Latest closes, oldest first (capped). */
  closes: number[];
  /** Bar seq the current position was first seen on, null while flat. */
  entrySeq: number | null;
  /** Highest close since the current position was first seen. */
  peak: number;
  /** Whether the half-position profit take has already fired for this position. */
  partialDone: boolean;
}

const series = new Map<string, Series>();

function emaStep(e: Ema, x: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (x - e.value);
    return;
  }
  e.warm.push(x);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, b) => a + b, 0) / e.span;
}

function atrStep(a: Atr, h: number, l: number, c: number): void {
  let tr: number;
  if (a.prevClose === null) tr = h - l;
  else tr = Math.max(h - l, Math.abs(h - a.prevClose), Math.abs(l - a.prevClose));
  a.prevClose = c;
  if (a.value !== null) {
    a.value = (a.value * (a.span - 1) + tr) / a.span;
    return;
  }
  a.warm.push(tr);
  if (a.warm.length === a.span) a.value = a.warm.reduce((x, y) => x + y, 0) / a.span;
}

/** Fold a bar into its symbol's indicators. */
function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      atr: { span: ATR_SPAN, warm: [], value: null, prevClose: null },
      closes: [],
      entrySeq: null,
      peak: 0,
      partialDone: false,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  emaStep(s.fast, c);
  emaStep(s.slow, c);
  atrStep(s.atr, Number(bar.h), Number(bar.l), c);
  s.closes.push(c);
  if (s.closes.length > 512) s.closes.shift();
  return s;
}

/** Return over the last n bars, in basis points, or null while too few closes. */
function retBps(s: Series, n: number): number | null {
  if (s.closes.length <= n) return null;
  const now = s.closes[s.closes.length - 1]!;
  const then = s.closes[s.closes.length - 1 - n]!;
  return ((now - then) * 10_000) / then;
}

/** Whether a flat symbol may enter on this close: uptrend, strong but not parabolic. */
function entrySignal(s: Series): boolean {
  if (s.fast.value === null || s.slow.value === null) return false;
  if (!(s.fast.value > s.slow.value)) return false;
  const r30 = retBps(s, 30);
  const r60 = retBps(s, 60);
  if (r30 === null || r60 === null) return false;
  return r30 >= RET30_MIN_BPS && r60 >= RET60_LO_BPS && r60 <= RET60_HI_BPS;
}

/** Whether a held position exits in full on this close. */
function exitSignal(state: BarsState, symbol: string, s: Series, held: { qty: bigint; cost: bigint }): boolean {
  const c = s.closes[s.closes.length - 1]!;
  // Trend broken: the fast average fell back under the slow one.
  if (s.fast.value !== null && s.slow.value !== null && s.fast.value < s.slow.value) return true;
  // Trailing stop: the close fell off the peak by the larger of a volatility multiple and a floor.
  if (s.atr.value !== null) {
    const floor = (c * TRAIL_MIN_BPS) / 10_000;
    const dist = TRAIL_ATR_MULT * s.atr.value > floor ? TRAIL_ATR_MULT * s.atr.value : floor;
    if (c <= s.peak - dist) return true;
  }
  // Hard stop: the position is worth STOP_BPS under its cost.
  const value = state.value(symbol, held.qty);
  if (value * 10_000n <= held.cost * BigInt(10_000 - STOP_BPS)) return true;
  // Maximum hold: the position has been open too long.
  if (s.entrySeq !== null && state.seq - s.entrySeq >= MAX_HOLD_BARS) return true;
  return false;
}

/** Whether the half-position profit take fires on this close. */
function partialSignal(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }): boolean {
  const value = state.value(symbol, held.qty);
  return value * 10_000n >= held.cost * BigInt(10_000 + PARTIAL_BPS);
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const c = s.closes[s.closes.length - 1]!;
        if (s.entrySeq === null) {
          s.entrySeq = state.seq;
          s.peak = c;
          s.partialDone = false;
        } else if (c > s.peak) {
          s.peak = c;
        }
        // Full exit first; otherwise bank half once the position is up PARTIAL_BPS.
        // Note the position tracking (entrySeq / peak / partialDone) is NOT reset
        // here: the exit only takes effect when the sell fills, and the flat branch
        // below resets the tracking once the position is actually gone. Resetting
        // at decision time would restart the hold timer and the trailing-stop peak
        // if the sell were ever rejected at the fill.
        if (exitSignal(state, symbol, s, held)) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        } else if (!s.partialDone && partialSignal(state, symbol, held)) {
          orders.push({ side: 'sell', symbol, qty: held.qty / 2n, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.partialDone = true;
        }
      } else {
        if (s.entrySeq !== null) {
          // The position is gone: the exit just filled.
          s.entrySeq = null;
          s.peak = 0;
          s.partialDone = false;
        }
        if (!entrySignal(s)) continue;
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        let slice = state.cash < byWeight ? state.cash : byWeight;
        if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
        if (orders.length >= caps.max_orders_per_bar) break;
        orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
