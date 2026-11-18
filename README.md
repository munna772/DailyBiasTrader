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

- Daily bias is selected manually by the user after checking the D1 chart. The strategy engine does not scan D1 liquidity levels, sweeps, candlestick patterns, or D1 confirmation rules.
- H1 AUTO confirmation checks only the latest completed H1 candle against the immediately preceding completed H1 candle, in the manually selected daily direction, and only when the H1 candle closes after the selection timestamp.
- H1 MANUAL confirmation remains available. The selected H1 direction must match the manually selected daily bias; Fibonacci uses the latest completed H1 candle as its reference.
- Fibonacci is anchored to the entire H1 reference/sweep candle high-low range. BUY: Fib 1 is the low and Fib 0 is the high. SELL: Fib 1 is the high and Fib 0 is the low.
- M5 first entry only: touch of Fib 0.5; BUY stop at Fib 0.618 below entry, SELL stop at Fib 0.618 above entry; target Fib 0.
- Risk validation checks stop-loss side and target side. Blocked levels remain visible for review; the app does not send orders or guarantee that a setup is profitable.
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
