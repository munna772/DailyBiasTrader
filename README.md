# DailyBiasTrader

Gold-only Android/browser strategy analysis app for XAUUSD.

## Deployments

- Browser preview: https://dailybiastrader-preview.onrender.com
- Strategy API: https://dailybiastrader-api.onrender.com
- Android APK workflow: manual dispatch only. No APK is built by normal commits.

## Market-data setup

The strategy API uses SiftingIO commodity historical bars. The API key is kept on the server and is never embedded in the browser or Android app.

Set this Render environment variable on the `dailybiastrader-api` service:

- `DAILY_BIAS_TRADER` (or `SIFTING_API_KEY` as a fallback)

The API maps XAUUSD directly to SiftingIO `XAUUSD`. No other instruments are enabled.

Health endpoint: `/api/health`
Strategy endpoint: `/api/strategy?symbol=XAUUSD` (XAUUSD / Gold only). Other symbols are rejected with HTTP 400.

The TradingView chart is a separate display feed and may not have identical candles or prices to the SiftingIO strategy feed.

## Strategy rules

- D1 liquidity sweeps: PDH/PDL, PWH/PWL, PMH/PML, EQH/EQL and confirmed major swing highs/lows. A D1 confirmation must occur after the sweep candle.
- A valid sweep pierces a level and closes back inside it.
- D1 confirmation: close beyond the previous D1 high/low, directional engulfing/rejection/displacement, or the specified three-candle inside-bar pattern.
- H1 confirmation: a matching sweep of an earlier H1 candle high/low after D1 confirmation, searching the available H1 history.
- Fibonacci is anchored to the entire H1 sweep candle high-low range. BUY: Fib 1 is the low and Fib 0 is the high. SELL: Fib 1 is the high and Fib 0 is the low.
- M5 first entry: touch of Fib 0.5; BUY stop at Fib 0.618 below entry, SELL stop at Fib 0.618 above entry; target Fib 0.
- M5 second entry: a completed M5 candle sweeps Fib 0.618 and closes back across it. Entry is at that candle close; BUY stop is that candle's low and SELL stop is its high; target Fib 0.
- The maximum 4-pip ($0.40 quoted-price) stop-distance restriction applies to all second entries because XAUUSD / Gold is the only supported instrument.
- Risk validation checks stop-loss side, target side and the Gold-only distance restriction. Blocked levels remain visible for review; the app does not send orders or guarantee that a setup is profitable.
- M5 data is considered stale when the latest candle has been closed for more than 15 minutes. While stale, the app displays a freshness warning and suppresses M5 entry signals rather than replaying old candles. Stale data may mean the market is closed or the provider is delayed; it is not treated as proof of an API failure.

## Development

Run the strategy tests:

```sh
node --test api/strategy.test.js
```

Start the API locally:

```sh
node api/server.js
```

The Android APK workflow is separate and is not automatically triggered by normal code commits. The browser UI in `public/index.html` is kept byte-for-byte identical to the packaged WebView UI in `app/src/main/assets/index.html`; the strategy test suite checks this.
