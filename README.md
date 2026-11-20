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

Feed Recovery endpoint: `/api/recovery?symbol=XAUUSD`. It bypasses the short server cache for one direct SiftingIO recheck, reports M5/H1 freshness and provider diagnostics, and enforces a 60-second per-client cooldown. A stale response remains stale; no synthetic candles are created and strategy entries remain gated.

The TradingView chart is a separate display feed and may not have identical candles or prices to the SiftingIO strategy feed.

## Strategy rules

- D1 chart remains available for the user’s own analysis. Daily bias is optional reference information; H1 does not require D1 confirmation or a D1 direction.
- H1 AUTO confirmation independently checks the latest completed H1 candle against the immediately preceding completed H1 candle for either a bullish low sweep or a bearish high sweep. If one candle sweeps both sides, the app reports ambiguity and does not guess.
- H1 MANUAL confirmation remains available and is independent of any D1 direction. Fibonacci uses the latest completed H1 candle as its reference.
- Fibonacci is anchored to the entire H1 reference/sweep candle high-low range. BUY: Fib 1 is the low and Fib 0 is the high. SELL: Fib 1 is the high and Fib 0 is the low.
- M5 first entry only: the first touch of Fib 0.5 creates at most one trade signal for that H1 Fibonacci setup. Later touches of the same setup are ignored, even after SL or TP. BUY stop is Fib 0.618 below entry; SELL stop is Fib 0.618 above entry; target is Fib 0.
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
