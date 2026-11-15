# DailyBiasTrader

Gold-only Android and browser trading-analysis app for XAUUSD.

The app requests only XAUUSD market data from SiftingIO. Its TradingView chart is fixed to Gold. The API rejects Silver, USOIL, and all other unsupported symbols. The Android APK workflow remains manual and is not triggered by normal code commits.

The Gold strategy rules remain unchanged: D1 liquidity sweep and confirmation, matching H1 sweep, Fibonacci levels anchored to the H1 sweep candle, first M5 entry at Fib 0.5, and second M5 entry on the completed 0.618 sweep-and-reclaim candle. Both entries target Fib 0. The second-entry stop is the sweep candle wick, with the existing maximum distance of 4 pips ($0.40).
