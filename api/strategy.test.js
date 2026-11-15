'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findSweep, calculateFib, candleTouches, findHourlySweep, findM5Entries, findHistoricalM5Entries, findDailyBias, dailyConfirmation, isInsideThreeBullish, isInsideThreeBearish, assessMarketDataFreshness, gateStrategyOnFreshness } = require('./strategy');
const { addSignalTrades, resolveTrades, summarizeTrades } = require('../public/trade-stats');

function c(time, open, high, low, close) {
  return { time: Date.parse(time + 'Z'), open, high, low, close, volume: 1 };
}

test('browser UI and Android APK UI stay identical', () => {
  const browserUi = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const androidUi = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');
  assert.equal(androidUi, browserUi);
});

test('chart loading timeout is longer and network recovery is wired in both UIs', () => {
  for (const file of ['../public/index.html', '../app/src/main/assets/index.html']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(source.includes('}, 60000);'), 'chart timeout should allow 60 seconds');
    assert.ok(source.includes("window.addEventListener('offline'"));
    assert.ok(source.includes("window.addEventListener('online'"));
    assert.ok(source.includes('CHART EMBED LOADED'));
    assert.ok(source.includes('cross-origin chart itself'));
  }
});

test('browser and Android trade statistics modules stay identical', () => {
  const browserStats = fs.readFileSync(path.join(__dirname, '../public/trade-stats.js'), 'utf8');
  const androidStats = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/trade-stats.js'), 'utf8');
  assert.equal(androidStats, browserStats);
});

test('trade ledger records only valid setups and deduplicates repeated signals', () => {
  const entries = [
    { type: 'SECOND_ENTRY', direction: 'SELL', time: 1000, entry: 100, stopLoss: 100.3, takeProfit: 99, setupValid: true },
    { type: 'SECOND_ENTRY', direction: 'SELL', time: 1000, entry: 100, stopLoss: 100.3, takeProfit: 99, setupValid: true },
    { type: 'SECOND_ENTRY', direction: 'BUY', time: 2000, entry: 100, stopLoss: 101, takeProfit: 102, setupValid: false }
  ];
  const once = addSignalTrades([], 'XAUUSD', entries, 5000);
  const twice = addSignalTrades(once, 'XAUUSD', entries, 6000);
  assert.equal(once.length, 1);
  assert.equal(twice.length, 1);
  assert.equal(once[0].pipSize, 0.10);
  assert.equal(once[0].status, 'OPEN');
});

test('BUY trade is counted as TP only on a candle after the entry candle', () => {
  const trade = addSignalTrades([], 'XAUUSD', [
    { type: 'FIRST_ENTRY', direction: 'BUY', time: 1000, entry: 100, stopLoss: 99.8, takeProfit: 101.2, setupValid: true }
  ], 5000);
  const sameEntryCandle = { time: 1000, high: 101.5, low: 99.5 };
  const laterTargetCandle = { time: 301000, high: 101.3, low: 100.2 };
  const stillOpen = resolveTrades(trade, 'XAUUSD', [sameEntryCandle]);
  assert.equal(stillOpen[0].status, 'OPEN');
  const resolved = resolveTrades(stillOpen, 'XAUUSD', [sameEntryCandle, laterTargetCandle]);
  assert.equal(resolved[0].status, 'TP');
  assert.equal(resolved[0].pipsWon, 12);
  assert.equal(resolved[0].pipsLost, 0);
});

test('SELL trade counts stop-loss pips with the market pip size', () => {
  const trade = addSignalTrades([], 'XAGUSD', [
    { type: 'SECOND_ENTRY', direction: 'SELL', time: 1000, entry: 25, stopLoss: 25.05, takeProfit: 24.5, setupValid: true }
  ], 5000);
  const resolved = resolveTrades(trade, 'XAGUSD', [
    { time: 301000, high: 25.06, low: 24.9 }
  ]);
  assert.equal(resolved[0].status, 'SL');
  assert.equal(resolved[0].pipsLost, 5);
  assert.equal(resolved[0].pipsWon, 0);
});

test('ambiguous candle touching both TP and SL is conservatively counted as SL', () => {
  const trade = addSignalTrades([], 'USOIL', [
    { type: 'FIRST_ENTRY', direction: 'BUY', time: 1000, entry: 70, stopLoss: 69.9, takeProfit: 70.2, setupValid: true }
  ], 5000);
  const resolved = resolveTrades(trade, 'USOIL', [
    { time: 301000, high: 70.25, low: 69.85 }
  ]);
  assert.equal(resolved[0].status, 'SL');
  assert.equal(resolved[0].bothLevelsHitSameCandle, true);
  assert.equal(resolved[0].pipsLost, 10);
});

test('trade summary counts TP, SL, open trades and net pips per selected market', () => {
  const entries = [
    { type: 'FIRST_ENTRY', direction: 'BUY', time: 1000, entry: 100, stopLoss: 99.8, takeProfit: 101.2, setupValid: true },
    { type: 'SECOND_ENTRY', direction: 'SELL', time: 2000, entry: 100, stopLoss: 100.2, takeProfit: 99, setupValid: true }
  ];
  let ledger = addSignalTrades([], 'XAUUSD', entries, 5000);
  ledger = resolveTrades(ledger, 'XAUUSD', [
    { time: 301000, high: 101.3, low: 100.2 },
    { time: 601000, high: 100.25, low: 99.5 }
  ]);
  ledger = addSignalTrades(ledger, 'XAUUSD', [
    { type: 'FIRST_ENTRY', direction: 'BUY', time: 3000, entry: 100, stopLoss: 99.8, takeProfit: 101.2, setupValid: true }
  ], 7000);
  const summary = summarizeTrades(ledger, 'XAUUSD');
  assert.equal(summary.tpHits, 1);
  assert.equal(summary.slHits, 1);
  assert.equal(summary.openTrades, 1);
  assert.equal(summary.pipsWon, 12);
  assert.equal(summary.pipsLost, 2);
  assert.equal(summary.netPips, 10);
  assert.equal(summarizeTrades(ledger, 'XAGUSD').total, 0);
});

test('historical M5 replay reuses the strategy first and second entry rules', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const bars = [
    c('2026-11-10T05:00:00', 111, 111, 109, 110.5),
    c('2026-11-10T05:05:00', 110.5, 111, 110.1, 110.5),
    c('2026-11-10T05:10:00', 112.5, 113, 111, 112)
  ];
  const entries = findHistoricalM5Entries(bars, 'bearish', bars[0].time, fib, 'XAGUSD');
  assert.equal(entries.filter(entry => entry.type === 'FIRST_ENTRY').length, 1);
  assert.equal(entries.filter(entry => entry.type === 'SECOND_ENTRY').length, 1);
  assert.equal(entries.find(entry => entry.type === 'SECOND_ENTRY').entry, 112);
  assert.equal(entries.find(entry => entry.type === 'SECOND_ENTRY').stopLoss, 113);
});

test('historical Gold second entries still obey the 4-pip stop cap', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const bars = [c('2026-11-10T05:10:00', 112.5, 113, 111, 112)];
  const gold = findHistoricalM5Entries(bars, 'bearish', bars[0].time, fib, 'XAUUSD')
    .find(entry => entry.type === 'SECOND_ENTRY');
  assert.ok(gold);
  assert.equal(gold.setupValid, false);
  assert.equal(gold.status, 'BLOCKED_STOP_TOO_WIDE');
});

test('recognizes a low-level rejection as a bullish liquidity sweep', () => {
  const result = findSweep(c('2026-11-10T00:00:00', 102, 108, 95, 105), { lows: [{ price: 100, name: 'PDL' }], highs: [] });
  assert.equal(result.bullish.levelName, 'PDL');
  assert.equal(result.bullish.level, 100);
  assert.equal(result.bearish, null);
});

test('recognizes a high-level rejection as a bearish liquidity sweep', () => {
  const result = findSweep(c('2026-11-10T00:00:00', 98, 105, 90, 94), { lows: [], highs: [{ price: 100, name: 'PDH' }] });
  assert.equal(result.bearish.levelName, 'PDH');
  assert.equal(result.bearish.level, 100);
  assert.equal(result.bullish, null);
});

test('maps bullish and bearish Fibonacci anchors in the requested direction', () => {
  const candle = { high: 120, low: 100 };
  const bull = calculateFib(candle, 'bullish'), bear = calculateFib(candle, 'bearish');
  assert.equal(bull['0'], 120);
  assert.equal(bull['1'], 100);
  assert.equal(bull['0.5'], 110);
  assert.ok(Math.abs(bull['0.618'] - 107.64) < 1e-9);
  assert.equal(bear['0'], 100);
  assert.equal(bear['1'], 120);
  assert.ok(Math.abs(bear['0.618'] - 112.36) < 1e-9);
});

test('detects a touch when the candle range includes the entry level', () => {
  assert.equal(candleTouches({ high: 111, low: 109 }, 110), true);
  assert.equal(candleTouches({ high: 109.9, low: 108 }, 110), false);
});

test('H1 confirmation can sweep a low from more than the immediately previous candle', () => {
  const bars = [
    c('2026-11-10T01:00:00', 110, 112, 100, 108),
    c('2026-11-10T02:00:00', 108, 110, 104, 106),
    c('2026-11-10T03:00:00', 106, 109, 103, 103),
    c('2026-11-10T04:00:00', 105, 108, 98, 105)
  ];
  const result = findHourlySweep(bars, 'bullish', bars[0].time);
  assert.ok(result);
  assert.equal(result.level, 104);
  assert.equal(result.time, bars[3].time + 60 * 60 * 1000);
});

test('BUY second entry uses sweep candle close, wick-low stop, and Fib 0 target', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 107, 109, 106, 108)];
  const entries = findM5Entries(bars, 'bullish', bars[0].time, fib);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.entry, 108);
  assert.equal(second.stopLoss, 106);
  assert.equal(second.takeProfit, 120);
  assert.equal(second.stopValid, true);
  assert.equal(second.status, 'SETUP_DETECTED');
});

test('SELL second entry uses sweep candle close, wick-high stop, and Fib 0 target', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const bars = [c('2026-11-10T05:00:00', 113, 115, 111, 112)];
  const entries = findM5Entries(bars, 'bearish', bars[0].time, fib);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.entry, 112);
  assert.equal(second.stopLoss, 115);
  assert.equal(second.takeProfit, 100);
  assert.equal(second.stopValid, true);
  assert.equal(second.status, 'SETUP_DETECTED');
});

test('4-pip ($0.40) maximum applies to Gold second entries only', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 107.8, 108.2, 107.2, 108)];
  const gold = findM5Entries(bars, 'bullish', bars[0].time, fib, bars, 'XAUUSD').find(e => e.type === 'SECOND_ENTRY');
  const silver = findM5Entries(bars, 'bullish', bars[0].time, fib, bars, 'XAGUSD').find(e => e.type === 'SECOND_ENTRY');
  const oil = findM5Entries(bars, 'bullish', bars[0].time, fib, bars, 'USOIL').find(e => e.type === 'SECOND_ENTRY');
  assert.ok(Math.abs(gold.stopDistance - 0.8) < 1e-9);
  assert.equal(gold.maxStopDistance, 0.4);
  assert.equal(gold.stopValid, false);
  assert.equal(gold.status, 'BLOCKED_STOP_TOO_WIDE');
  assert.equal(silver.maxStopDistance, null);
  assert.equal(silver.stopValid, true);
  assert.equal(oil.maxStopDistance, null);
  assert.equal(oil.stopValid, true);
});

test('Gold second-entry stop at or below $0.40 is allowed', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 107.8, 108.1, 107.63, 108.03)];
  const gold = findM5Entries(bars, 'bullish', bars[0].time, fib, bars, 'XAUUSD').find(e => e.type === 'SECOND_ENTRY');
  assert.ok(gold);
  assert.ok(Math.abs(gold.stopDistance - 0.4) < 1e-9);
  assert.equal(gold.stopValid, true);
});

test('D1 confirmation must occur after the liquidity-sweep candle', () => {
  const bars = [];
  for (let day = 1; day <= 7; day++) {
    bars.push(c('2026-11-' + String(day).padStart(2, '0') + 'T00:00:00', 105, 110, 100, 106));
  }
  // This candle sweeps below the prior low and closes above the prior high.
  // It must not confirm its own sweep; a later D1 candle is required.
  bars.push(c('2026-11-08T00:00:00', 118, 120, 95, 115));
  assert.equal(findDailyBias(bars).bias, 'WAITING');

  bars.push(c('2026-11-09T00:00:00', 112, 123, 111, 122));
  assert.equal(findDailyBias(bars).bias, 'BULLISH');
});

test('second entry is blocked when Fib 0 target is already behind the entry', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 121, 130, 106, 125)];
  const second = findM5Entries(bars, 'bullish', bars[0].time, fib)
    .find(entry => entry.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.stopSideValid, true);
  assert.equal(second.takeProfitValid, false);
  assert.equal(second.setupValid, false);
  assert.equal(second.status, 'BLOCKED_INVALID_TARGET_SIDE');
});

test('recognizes the three-candle inside pattern in both directions', () => {
  const bullish = [
    c('2026-11-10T00:00:00', 10, 15, 9, 14),
    c('2026-11-11T00:00:00', 14, 14.5, 10, 11),
    c('2026-11-12T00:00:00', 11, 14, 10, 13)
  ];
  const bearish = [
    c('2026-11-10T00:00:00', 14, 15, 9, 10),
    c('2026-11-11T00:00:00', 11, 14, 10, 13),
    c('2026-11-12T00:00:00', 13, 14, 10, 11)
  ];
  assert.equal(isInsideThreeBullish(bullish, 2), true);
  assert.equal(isInsideThreeBearish(bearish, 2), true);
});


test('first M5 entry may trigger on the current intrabar candle', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const current = c('2026-11-10T05:00:00', 109, 111, 108, 109);
  const entries = findM5Entries([current], 'bullish', current.time, fib, []);
  assert.equal(entries.some(e => e.type === 'FIRST_ENTRY'), true);
  assert.equal(entries.some(e => e.type === 'SECOND_ENTRY'), false);
});

test('second M5 entry requires a completed sweep-and-close candle', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const current = c('2026-11-10T05:00:00', 113, 115, 111, 113);
  const entries = findM5Entries([current], 'bullish', current.time, fib, []);
  assert.equal(entries.some(e => e.type === 'SECOND_ENTRY'), false);
});


test('H1 sweep searches the full available history, including bars older than 500 candles', () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const bars = [{ time: start, open: 104, high: 106, low: 100, close: 104 }];
  for (let i = 1; i <= 500; i++) {
    bars.push({ time: start + i * 60 * 60 * 1000, open: 101, high: 102, low: 100.5, close: 101.4 });
  }
  bars.push({ time: start + 501 * 60 * 60 * 1000, open: 99.5, high: 102, low: 99, close: 100.25 });
  const result = findHourlySweep(bars, 'bullish', start);
  assert.ok(result);
  assert.equal(result.level, 100);
  assert.equal(result.lookbackBars, 501);
});

test('first M5 entry checks the latest intrabar candle instead of re-signalling an old touch', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const oldTouch = c('2026-11-10T05:00:00', 109, 111, 108, 109);
  const latest = c('2026-11-10T05:05:00', 113, 114, 112, 113);
  const entries = findM5Entries([oldTouch, latest], 'bullish', oldTouch.time, fib, []);
  assert.equal(entries.some(e => e.type === 'FIRST_ENTRY'), false);
});

test('second M5 entry reports the latest completed candle only', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const older = c('2026-11-10T05:00:00', 113, 115, 111, 113);
  const newer = c('2026-11-10T05:05:00', 108, 116, 106, 109);
  const entries = findM5Entries([older, newer], 'bullish', older.time, fib, [older, newer]);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.time, newer.time);
});


test('second M5 entry does not replay an old sweep after a newer completed candle', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const oldSweep = c('2026-11-10T05:00:00', 108, 116, 106, 109);
  const latestClosed = c('2026-11-10T05:05:00', 109, 112, 108, 111);
  const entries = findM5Entries([oldSweep, latestClosed], 'bullish', oldSweep.time, fib, [oldSweep, latestClosed]);
  assert.equal(entries.some(e => e.type === 'SECOND_ENTRY'), false);
});

test('three-candle D1 inside pattern must form entirely after the liquidity sweep', () => {
  const sweepAsFirst = [
    c('2026-11-10T00:00:00', 10, 15, 9, 14),
    c('2026-11-11T00:00:00', 14, 14.5, 10, 11),
    c('2026-11-12T00:00:00', 11, 14, 10, 13)
  ];
  assert.equal(dailyConfirmation(sweepAsFirst, 2, 'bullish', 0), null);

  const formedAfterSweep = [
    c('2026-11-10T00:00:00', 12, 13, 10, 11),
    c('2026-11-11T00:00:00', 10, 15, 9, 14),
    c('2026-11-12T00:00:00', 14, 14.5, 10, 11),
    c('2026-11-13T00:00:00', 11, 14, 10, 13)
  ];
  assert.equal(dailyConfirmation(formedAfterSweep, 3, 'bullish', 0), 'Bullish 3-candle inside-bar pattern');
});

test('first BUY entry uses 0.618 below entry as stop and 0 as target', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const current = c('2026-11-10T06:00:00', 109, 111, 108, 109);
  const entries = findM5Entries([current], 'bullish', current.time, fib, []);
  const first = entries.find(e => e.type === 'FIRST_ENTRY');
  assert.ok(first);
  assert.equal(first.stopLoss, 107.64);
  assert.equal(first.takeProfit, 120);
  assert.equal(first.stopValid, true);
});

test('first SELL entry uses 0.618 above entry as stop and 0 as target', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const current = c('2026-11-10T06:00:00', 111, 112, 109, 111);
  const entries = findM5Entries([current], 'bearish', current.time, fib, []);
  const first = entries.find(e => e.type === 'FIRST_ENTRY');
  assert.ok(first);
  assert.equal(first.stopLoss, 112.36);
  assert.equal(first.takeProfit, 100);
  assert.equal(first.stopValid, true);
});


test('M5 freshness is based on the latest candle close, not API fetch time', () => {
  const now = Date.parse('2026-11-14T15:10:00Z');
  const recent = [c('2026-11-14T15:00:00', 10, 11, 9, 10.5)];
  const stale = [c('2026-11-14T14:30:00', 10, 11, 9, 10.5)];
  const recentStatus = assessMarketDataFreshness(recent, now);
  const staleStatus = assessMarketDataFreshness(stale, now);
  assert.equal(recentStatus.status, 'FRESH');
  assert.equal(recentStatus.stale, false);
  assert.equal(recentStatus.ageMinutes, 5);
  assert.equal(staleStatus.status, 'STALE');
  assert.equal(staleStatus.stale, true);
  assert.equal(staleStatus.ageMinutes, 35);
});

test('no M5 candles are reported as missing data', () => {
  const result = assessMarketDataFreshness([], Date.parse('2026-11-14T15:10:00Z'));
  assert.equal(result.status, 'NO_DATA');
  assert.equal(result.stale, true);
  assert.equal(result.latestCandleAt, null);
});

test('stale M5 candles cannot produce actionable entry signals', () => {
  const strategy = {
    h1Status: 'CONFIRMED',
    entryStatus: 'ENTRY_DETECTED',
    entries: [{ type: 'SECOND_ENTRY', setupValid: true }],
    riskWarning: 'obsolete risk warning'
  };
  const gated = gateStrategyOnFreshness(strategy, { status: 'STALE', stale: true });
  assert.equal(gated.entryStatus, 'WAITING_FOR_FRESH_M5_DATA');
  assert.deepEqual(gated.entries, []);
  assert.equal(gated.riskWarning, null);
  assert.equal(strategy.entries.length, 1);
});

test('fresh M5 data preserves the strategy result unchanged', () => {
  const strategy = { h1Status: 'CONFIRMED', entryStatus: 'ENTRY_DETECTED', entries: [{ type: 'FIRST_ENTRY' }] };
  const result = gateStrategyOnFreshness(strategy, { status: 'FRESH', stale: false });
  assert.equal(result, strategy);
});


test('freshness state is initialized before entry detail reads it in both UIs', () => {
  for (const file of ['../public/index.html', '../app/src/main/assets/index.html']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const stateIndex = source.indexOf('const dataStale =');
    const readIndex = source.indexOf('dataStale && s.h1Status');
    assert.ok(stateIndex >= 0 && readIndex >= 0);
    assert.ok(stateIndex < readIndex, 'dataStale must be initialized before it is read');
  }
});
