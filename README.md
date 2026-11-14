# DailyBiasTrader

Android/browser multi-market strategy analysis app for XAUUSD, USOIL and XAGUSD.

## Deployments

- Browser preview: https://dailybiastrader-preview.onrender.com
- Strategy API: https://dailybiastrader-api.onrender.com
- Android APK workflow: manual dispatch only. No APK is built by normal commits.

## Market-data setup

The app keeps the strategy-data provider key on the API server. It is never embedded in the browser or Android app.

Set this Render environment variable on the \`dailybiastrader-api\` service:

- \`TWELVEDATA_API_KEY\`

The API maps:
- XAUUSD to Twelve Data \`XAU/USD\`
- XAGUSD to Twelve Data \`XAG/USD\`
- USOIL to Twelve Data \`WTI/USD\`

Twelve Data commodity intraday time-series access requires a plan that includes its commodity market data. A free key without this entitlement will not activate live strategy calculations.

Health endpoint: \`/health\`
Strategy endpoint: \`/api/strategy?symbol=XAUUSD\` (also \`USOIL\`, \`XAGUSD\`)

## Strategy rules

- D1 liquidity sweeps: PDH/PDL, PWH/PWL, PMH/PML, EQH/EQL and confirmed major swing highs/lows.
- A valid sweep must pierce a level and close back inside it.
- D1 confirmation: close beyond the previous D1 high/low, directional engulfing/rejection/displacement, or the specified three-candle inside-bar pattern.
- H1 confirmation: a matching sweep of an earlier H1 candle high/low after the D1 confirmation, searching all earlier bars in the provider's returned H1 history (up to the requested 1,000-bar response).
- Fibonacci is anchored to the entire H1 sweep candle high-low range, with the user's bullish/bearish 0 and 1 mapping.
- M5 first entry is an intrabar touch of 0.5 on the latest/current M5 candle; old touches are not replayed as fresh entries.
- M5 second entry requires a completed M5 candle to sweep 0.618 and close back across it; the most recent matching completed candle is reported.

Requested stop-loss placements are preserved, but the engine marks a setup blocked when its stop is on the wrong side of entry. It does not send orders or guarantee that a setup is profitable.

## Development

From the repository root:

\`\`\`sh
node --test api/strategy.test.js
node api/server.js
\`\`\`

The strategy tests also run in GitHub Actions. The Android APK workflow is separate and is not automatically triggered.
