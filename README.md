# Ridge Runner — BTC 24h race bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/inikangai14-sys/btc-race-24h-20261118-1444-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/inikangai14-sys/btc-race-24h-20261118-1444-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A trend bot for make.fun's [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444)
(`btc-race-24h-20261118-1444`). It trades Coinbase Wrapped BTC (cbBTC) against
USDC on 1-minute bars, long only, starting from 1,000 USDC of paper money.

## Strategy

On 1-minute bars BTC is mostly noise (about 7 bp of standard deviation per
minute) while a full round trip costs about 26 bp, so the bot only trades when
a real trend is running:

- **Entry (flat):** fast EMA(16) above slow EMA(64), close above the fast EMA,
  and the close up at least 20 bp over the last 12 bars.
- **Exit (holding):** close below the highest close since entry minus the
  larger of 2× ATR(14) and 40 bp; or the fast EMA falls back under the slow
  EMA; or the position is worth 150 bp under its cost; or it has been held for
  240 bars.
- **Cooldown:** after every exit the bot waits 12 bars before it may enter
  again, so a whipsaw cannot make it buy back the same minute it sold.
- **Sizing:** the whole cash balance, up to the weight cap. One position at most.

Everything is deterministic: plain float64 arithmetic on the bars, no clock,
no environment, no randomness. The same bars always give the same orders.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript).
- `vendor/makefun-bars.ts` — the kit's `agent-fun/bars-replay/v1` shim, copied
  byte for byte from the kit.
- `LICENSE` — MIT.

## Verify

Grade it on the kit's dev window the way the server does:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
