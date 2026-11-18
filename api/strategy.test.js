'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findSweep, calculateFib, candleTouches, findHourlySweep, validateActiveHourlySweep, findM5Entries, findHistoricalM5Entries, findDailyBias, dailyConfirmation, analyzeStrategy, isInsideThreeBullish, isInsideThreeBearish, assessMarketDataFreshness, gateStrategyOnFreshness } = require('./strategy');
const { PIP_SIZES, addSignalTrades, resolveTrades, summarizeTrades } = require('../public/trade-stats');
const { DEFAULT_SYMBOL, SUPPORTED_SYMBOLS, normalizeSymbol } = require('./markets');
const { buildSeriesUrl, parseSiftingBars, buildFiveMinuteBarsFromOneMinute, mergeFiveMinuteBars, buildHourlyBarsFromOneMinute, mergeHourlyBars, buildLatestBarTimes, assessH1DataFreshness, describeSeries, marketDataFreshForEntries } = require('./server');

function c(time, open, high, low, close) {
  return { time: Date.parse(time + 'Z'), open, high, low, close, volume: 1 };
}

test('browser UI and Android APK UI stay identical and expose manual D1 bias and bar countdown', () => {
  const browserUi = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const androidUi = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');
  assert.equal(androidUi, browserUi);
  assert.ok(browserUi.includes('id="symbolLabel">XAUUSD'));
  assert.ok(browserUi.includes('GOLD ONLY'));
  assert.ok(browserUi.includes('id="manualD1Bias"'));
  assert.ok(browserUi.includes('MANUAL BULLISH'));
  assert.ok(browserUi.includes('MANUAL BEARISH'));
  assert.ok(browserUi.includes('MANUAL_D1_BIAS_KEY'));
  assert.ok(browserUi.includes('id="manualH1Bias"'));
  assert.ok(browserUi.includes('MANUAL_H1_BIAS_KEY'));
  assert.ok(browserUi.includes('H1 CONFIRMATION MODE'));
  assert.ok(browserUi.includes('Manual H1 confirmation applied'));
  assert.ok(browserUi.includes('Fibonacci rolls forward to the latest completed H1 candle'));
  assert.ok(browserUi.includes('immediately previous completed H1 candle'));
  assert.ok(browserUi.includes('older M5 candles are ignored'));
  assert.doesNotMatch(browserUi, /demoConfirmations|DEMO ONLY|DEMO TEST ONLY|Run fake H1/);
  assert.ok(browserUi.includes('STALE H1 DATA'));
  assert.ok(browserUi.includes('PAUSED — STALE DATA'));
  assert.ok(browserUi.includes('latest completed M5 candle closed at'));
  assert.ok(browserUi.includes('whose candle closes after '));
  assert.ok(browserUi.includes('h1BarsChecked'));
  assert.ok(browserUi.includes('id="barCountdownValue"'));
  assert.ok(browserUi.includes('AUTO_H1_CONFIRMATION_KEY'));
  assert.ok(browserUi.includes('activeH1='));
  assert.ok(browserUi.includes('saveActiveAutoH1Sweep'));
  assert.ok(browserUi.includes('const ledgerEntries ='));
  assert.ok(browserUi.includes('.concat(Array.isArray(s.entries) ? s.entries : [])'));
  assert.ok(browserUi.includes('class="chart-stage"'));
  assert.ok(browserUi.includes('class="bar-countdown-overlay is-paused"'));
  assert.ok(browserUi.indexOf('id="barCountdown"') > browserUi.indexOf('id="tv_chart"'));
  assert.ok(browserUi.indexOf('id="barCountdown"') < browserUi.indexOf('Chart source: TradingView'));
  assert.ok(browserUi.includes('.bar-countdown-overlay{position:absolute;'));
  assert.ok(browserUi.includes("el('barCountdownState').textContent = 'LIVE'"));
  assert.ok(browserUi.includes("el('barCountdownState').textContent = 'CLOCK'"));
  assert.ok(browserUi.includes('counting to the next UTC H1 boundary'));
  assert.ok(browserUi.includes('Strategy entries remain paused until verified fresh H1 data arrives.'));
  assert.ok(browserUi.includes('.bar-countdown-overlay.is-clock'));
  assert.ok(browserUi.includes('payload.barTimes'));
  assert.ok(browserUi.includes('latestDataFreshness.stale'));
  assert.ok(browserUi.includes('timestampSource'));
  assert.ok(browserUi.includes('last verified completed H1 candle timestamp'));
  assert.ok(browserUi.includes("interval.key === 'H1'"));
  assert.ok(browserUi.includes("interval.key === 'M5'"));
  assert.ok(browserUi.includes('The countdown will not invent a candle or close time.'));
  assert.doesNotMatch(browserUi, /XAGUSD|USOIL|id="symbol"/);
});

test('API supports Gold only and defaults safely to XAUUSD', () => {
  assert.deepEqual(Object.keys(SUPPORTED_SYMBOLS), ['XAUUSD']);
  assert.equal(DEFAULT_SYMBOL, 'XAUUSD');
  assert.equal(normalizeSymbol(null), 'XAUUSD');
  assert.equal(normalizeSymbol(''), 'XAUUSD');
  assert.equal(normalizeSymbol('xauusd'), 'XAUUSD');
  assert.equal(normalizeSymbol('XAGUSD'), null);
  assert.equal(normalizeSymbol('USOIL'), null);
  assert.equal(normalizeSymbol('EURUSD'), null);
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

test('trade statistics accept Gold only and ignore legacy Silver/Oil rows', () => {
  assert.deepEqual(Object.keys(PIP_SIZES), ['XAUUSD']);
  const entries = [
    { type: 'FIRST_ENTRY', direction: 'BUY', time: 1000, entry: 100, stopLoss: 99.8, takeProfit: 101, setupValid: true }
  ];
  assert.equal(addSignalTrades([], 'XAGUSD', entries, 5000).length, 0);
  assert.equal(addSignalTrades([], 'USOIL', entries, 5000).length, 0);
  const legacy = [
    { symbol: 'XAGUSD', status: 'TP', pipsWon: 20 },
    { symbol: 'USOIL', status: 'SL', pipsLost: 30 }
  ];
  assert.deepEqual(resolveTrades(legacy, 'XAGUSD', []).map(row => row.status), ['TP', 'SL']);
  assert.equal(summarizeTrades(legacy, 'XAGUSD').total, 0);
  assert.equal(summarizeTrades(legacy, 'USOIL').total, 0);
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

test('Gold SELL trade counts stop-loss pips using the Gold pip size', () => {
  const trade = addSignalTrades([], 'XAUUSD', [
    { type: 'SECOND_ENTRY', direction: 'SELL', time: 1000, entry: 25, stopLoss: 25.5, takeProfit: 24.5, setupValid: true }
  ], 5000);
  const resolved = resolveTrades(trade, 'XAUUSD', [
    { time: 301000, high: 25.6, low: 24.9 }
  ]);
  assert.equal(resolved[0].status, 'SL');
  assert.equal(resolved[0].pipsLost, 5);
  assert.equal(resolved[0].pipsWon, 0);
});

test('ambiguous Gold candle touching both TP and SL is conservatively counted as SL', () => {
  const trade = addSignalTrades([], 'XAUUSD', [
    { type: 'FIRST_ENTRY', direction: 'BUY', time: 1000, entry: 70, stopLoss: 69, takeProfit: 72, setupValid: true }
  ], 5000);
  const resolved = resolveTrades(trade, 'XAUUSD', [
    { time: 301000, high: 72.5, low: 68.5 }
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
  assert.equal(summarizeTrades(ledger, 'USOIL').total, 0);
});

test('historical M5 replay reuses the strategy first and second entry rules', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const bars = [
    c('2026-11-10T05:00:00', 111, 111, 109, 110.5),
    c('2026-11-10T05:05:00', 110.5, 111, 110.1, 110.5),
    c('2026-11-10T05:10:00', 112.5, 113, 111, 112)
  ];
  const entries = findHistoricalM5Entries(bars, 'bearish', bars[0].time, fib);
  assert.equal(entries.filter(entry => entry.type === 'FIRST_ENTRY').length, 1);
  assert.equal(entries.filter(entry => entry.type === 'SECOND_ENTRY').length, 1);
  assert.equal(entries.find(entry => entry.type === 'SECOND_ENTRY').entry, 112);
  assert.equal(entries.find(entry => entry.type === 'SECOND_ENTRY').stopLoss, 113);
});

test('historical Gold second entries still obey the 4-pip stop cap', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const bars = [c('2026-11-10T05:10:00', 112.5, 113, 111, 112)];
  const gold = findHistoricalM5Entries(bars, 'bearish', bars[0].time, fib)
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

test('H1 confirmation uses the immediately previous completed candle as its sweep level', () => {
  const bars = [
    c('2026-11-10T01:00:00', 110, 112, 100, 108),
    c('2026-11-10T02:00:00', 108, 110, 104, 106),
    c('2026-11-10T03:00:00', 106, 109, 103, 103),
    c('2026-11-10T04:00:00', 105, 108, 98, 105)
  ];
  const result = findHourlySweep(bars, 'bullish', bars[0].time);
  assert.ok(result);
  assert.equal(result.level, bars[2].low);
  assert.equal(result.referenceCandleTime, bars[2].time);
  assert.equal(result.lookbackBars, 1);
  assert.equal(result.time, bars[3].time + 60 * 60 * 1000);
});

test('BUY second entry uses sweep candle close, wick-low stop, and Fib 0 target', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 107.7, 109, 107.63, 108)];
  const entries = findM5Entries(bars, 'bullish', bars[0].time, fib);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.entry, 108);
  assert.equal(second.stopLoss, 107.63);
  assert.equal(second.takeProfit, 120);
  assert.equal(second.stopValid, true);
  assert.equal(second.status, 'SETUP_DETECTED');
});

test('SELL second entry uses sweep candle close, wick-high stop, and Fib 0 target', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const bars = [c('2026-11-10T05:00:00', 112.3, 112.39, 111, 112)];
  const entries = findM5Entries(bars, 'bearish', bars[0].time, fib);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.entry, 112);
  assert.equal(second.stopLoss, 112.39);
  assert.equal(second.takeProfit, 100);
  assert.equal(second.stopValid, true);
  assert.equal(second.status, 'SETUP_DETECTED');
});

test('Gold-only second-entry strategy always enforces the 4-pip ($0.40) stop cap', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 107.8, 108.2, 107.2, 108)];
  const gold = findM5Entries(bars, 'bullish', bars[0].time, fib, bars).find(e => e.type === 'SECOND_ENTRY');
  assert.ok(Math.abs(gold.stopDistance - 0.8) < 1e-9);
  assert.equal(gold.maxStopDistance, 0.4);
  assert.equal(gold.stopValid, false);
  assert.equal(gold.status, 'BLOCKED_STOP_TOO_WIDE');
});

test('Gold second-entry stop at or below $0.40 is allowed', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 107.8, 108.1, 107.63, 108.03)];
  const gold = findM5Entries(bars, 'bullish', bars[0].time, fib, bars).find(e => e.type === 'SECOND_ENTRY');
  assert.ok(gold);
  assert.ok(Math.abs(gold.stopDistance - 0.4) < 1e-9);
  assert.equal(gold.stopValid, true);
});

test('manual bullish D1 bias bypasses D1 scan and starts H1 search at selection time', () => {
  const h1 = [
    c('2026-11-10T05:00:00', 102, 104, 100, 102),
    c('2026-11-10T06:00:00', 102, 103, 101, 102),
    c('2026-11-10T07:00:00', 102, 103, 99, 102)
  ];
  const result = analyzeStrategy({
    d1: [],
    h1,
    m5: [],
    manualBias: 'BULLISH',
    manualBiasSince: h1[2].time
  });
  assert.equal(result.bias, 'BULLISH');
  assert.equal(result.biasMode, 'MANUAL');
  assert.equal(result.h1Status, 'CONFIRMED');
  assert.equal(result.h1Sweep.candle.time, h1[2].time);
  assert.equal(result.entryStatus, 'WAITING_FOR_M5');
});

test('manual bearish D1 bias searches only matching H1 sweeps after selection', () => {
  const h1 = [
    c('2026-11-10T05:00:00', 102, 105, 100, 102),
    c('2026-11-10T06:00:00', 102, 104, 101, 102),
    c('2026-11-10T07:00:00', 104, 106, 103, 103.5)
  ];
  const result = analyzeStrategy({
    d1: [],
    h1,
    m5: [],
    manualBias: 'BEARISH',
    manualBiasSince: h1[2].time
  });
  assert.equal(result.bias, 'BEARISH');
  assert.equal(result.biasMode, 'MANUAL');
  assert.equal(result.h1Status, 'CONFIRMED');
  assert.equal(result.h1Sweep.candle.time, h1[2].time);
});

test('manual bias selected mid-hour accepts a matching sweep when that H1 candle later closes', () => {
  const h1 = [
    c('2026-11-16T10:00:00', 102, 104, 100, 102),
    c('2026-11-16T11:00:00', 102, 104, 99, 101),
    c('2026-11-16T12:00:00', 101, 103, 100, 102)
  ];
  const selectedAt = Date.parse('2026-11-16T11:03:14Z');
  const result = analyzeStrategy({
    d1: [],
    h1,
    m5: [],
    manualBias: 'BULLISH',
    manualBiasSince: selectedAt,
    now: selectedAt + 60 * 60 * 1000 + 60 * 1000
  });
  assert.equal(result.bias, 'BULLISH');
  assert.equal(result.biasMode, 'MANUAL');
  assert.equal(result.h1Status, 'CONFIRMED');
  assert.equal(result.h1Sweep.candle.time, h1[1].time);
  assert.equal(result.h1Sweep.time, h1[1].time + 60 * 60 * 1000);
});

test('manual bias excludes an H1 sweep candle that closed before selection', () => {
  const h1 = [
    c('2026-11-16T10:00:00', 102, 104, 100, 102),
    c('2026-11-16T11:00:00', 102, 104, 99, 101),
    c('2026-11-16T12:00:00', 101, 103, 100, 102)
  ];
  const selectedAfterClose = Date.parse('2026-11-16T12:00:01Z');
  const result = analyzeStrategy({
    d1: [],
    h1,
    m5: [],
    manualBias: 'BULLISH',
    manualBiasSince: selectedAfterClose
  });
  assert.equal(result.bias, 'BULLISH');
  assert.equal(result.biasMode, 'MANUAL');
  assert.equal(result.h1Status, 'WAITING_FOR_H1_SWEEP');
  assert.equal(result.h1BarsChecked, 1);
  assert.equal(result.h1SearchAfter, selectedAfterClose);
});

test('manual bias ignores an H1 sweep that occurred before the user selected it', () => {
  const h1 = [
    c('2026-11-10T05:00:00', 102, 104, 100, 102),
    c('2026-11-10T06:00:00', 102, 103, 99, 101),
    c('2026-11-10T07:00:00', 102, 103, 101, 102)
  ];
  const result = analyzeStrategy({
    d1: [],
    h1,
    m5: [],
    manualBias: 'BULLISH',
    manualBiasSince: h1[2].time
  });
  assert.equal(result.bias, 'BULLISH');
  assert.equal(result.biasMode, 'MANUAL');
  assert.equal(result.h1Status, 'WAITING_FOR_H1_SWEEP');
  assert.equal(result.h1Sweep, undefined);
});

test('invalid or incomplete manual bias metadata falls back to automatic D1 analysis', () => {
  const result = analyzeStrategy({d1: [],h1: [],m5: [],manualBias:'BULLISH'});
  assert.equal(result.bias, 'WAITING');
  assert.equal(result.biasMode, 'AUTO');
});

test('manual H1 confirmation uses the latest completed H1 candle as its Fib anchor and starts M5 after selection', () => {
  const h1 = [
    c('2026-11-16T08:00:00', 100, 104, 99, 103),
    c('2026-11-16T09:00:00', 103, 106, 102, 105),
    c('2026-11-16T10:00:00', 105, 107, 104, 106)
  ];
  const selectedAt = Date.parse('2026-11-16T11:30:00Z');
  const m5 = [
    c('2026-11-16T11:25:00', 105, 106, 103, 104),
    c('2026-11-16T11:30:00', 108, 110, 107, 109)
  ];
  const result = analyzeStrategy({
    d1: [], h1, m5, m5Closed: m5,
    manualBias: 'BULLISH',
    manualBiasSince: Date.parse('2026-11-16T08:00:00Z'),
    manualH1Bias: 'BULLISH',
    manualH1BiasSince: selectedAt,
    now: selectedAt
  });
  assert.equal(result.bias, 'BULLISH');
  assert.equal(result.h1Mode, 'MANUAL');
  assert.equal(result.h1Status, 'CONFIRMED');
  assert.equal(result.h1Sweep.manual, true);
  assert.equal(result.h1Sweep.candle.time, h1[2].time);
  assert.equal(result.h1Sweep.time, selectedAt);
  assert.equal(result.manualH1AnchorTime, h1[2].time);
  assert.deepEqual(result.fib, calculateFib(h1[2], 'bullish'));
  assert.equal(result.entries.length, 0, 'the M5 candle opened before H1 selection and must not trigger an entry');
});

test('manual H1 reference rolls forward to the latest completed candle instead of freezing the old selection candle', () => {
  const h1 = [
    c('2026-11-16T08:00:00', 100, 104, 99, 103),
    c('2026-11-16T09:00:00', 103, 106, 102, 105),
    c('2026-11-16T10:00:00', 105, 107, 104, 106),
    c('2026-11-16T11:00:00', 106, 108, 105, 107),
    c('2026-11-16T12:00:00', 107, 109, 106, 108)
  ];
  const selectedAt = Date.parse('2026-11-16T11:30:00Z');
  const evaluationTime = Date.parse('2026-11-16T13:30:00Z');
  const oldM5 = c('2026-11-16T12:55:00', 106, 110, 105, 109);
  const latestM5 = c('2026-11-16T13:00:00', 104, 105, 103, 104);
  const result = analyzeStrategy({
    d1: [], h1, m5: [oldM5, latestM5], m5Closed: [oldM5, latestM5],
    manualBias: 'BULLISH',
    manualBiasSince: Date.parse('2026-11-16T08:00:00Z'),
    manualH1Bias: 'BULLISH',
    manualH1BiasSince: selectedAt,
    now: evaluationTime
  });
  const latestReference = h1[4];
  const latestReferenceClose = latestReference.time + 60 * 60 * 1000;
  assert.equal(result.h1Status, 'CONFIRMED');
  assert.equal(result.manualH1AnchorTime, latestReference.time);
  assert.equal(result.manualH1AnchorCloseTime, latestReferenceClose);
  assert.equal(result.manualH1MonitoringSince, latestReferenceClose);
  assert.equal(result.h1Sweep.candle.time, latestReference.time);
  assert.equal(result.h1Sweep.time, latestReferenceClose);
  assert.deepEqual(result.fib, calculateFib(latestReference, 'bullish'));
  assert.equal(result.entries.some(entry => entry.time === oldM5.time), false);
});

test('manual H1 confirmation refuses a direction that conflicts with D1', () => {
  const h1 = [c('2026-11-16T09:00:00', 103, 106, 102, 105)];
  const result = analyzeStrategy({
    d1: [], h1, m5: [],
    manualBias: 'BULLISH',
    manualBiasSince: Date.parse('2026-11-16T08:00:00Z'),
    manualH1Bias: 'BEARISH',
    manualH1BiasSince: Date.parse('2026-11-16T10:30:00Z')
  });
  assert.equal(result.h1Status, 'MANUAL_H1_DIRECTION_MISMATCH');
  assert.equal(result.h1Mode, 'MANUAL');
  assert.equal(result.entries.length, 0);
  assert.equal(result.fib, null);
});

test('manual H1 confirmation requires a completed reference candle', () => {
  const h1 = [c('2026-11-16T10:00:00', 105, 107, 104, 106)];
  const selectedAt = Date.parse('2026-11-16T10:30:00Z');
  const result = analyzeStrategy({
    d1: [], h1, m5: [],
    manualBias: 'BULLISH',
    manualBiasSince: Date.parse('2026-11-16T08:00:00Z'),
    manualH1Bias: 'BULLISH',
    manualH1BiasSince: selectedAt,
    now: selectedAt
  });
  assert.equal(result.h1Status, 'WAITING_FOR_MANUAL_H1_CANDLE');
  assert.equal(result.fib, null);
  assert.equal(result.entries.length, 0);
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


test('AUTO H1 accepts only a previously captured and revalidated anchor after its H1 closes', () => {
  const start = Date.parse('2026-11-16T08:00:00Z');
  const previous = { time: start, open: 102, high: 105, low: 100, close: 103 };
  const sweep = { time: start + 3600000, open: 101, high: 104, low: 97, close: 101 };
  const newer = { time: start + 7200000, open: 101, high: 103, low: 99, close: 102 };
  const active = {
    bias: 'BULLISH', d1ConfirmationTime: start - 3600000,
    candleTime: sweep.time, closeTime: sweep.time + 3600000,
    referenceCandleTime: previous.time
  };
  const result = analyzeStrategy({
    d1: [], h1: [previous, sweep, newer], m5: [],
    manualBias: 'BULLISH', manualBiasSince: start - 3600000,
    activeH1: active, now: start + 3 * 3600000
  });
  assert.equal(result.h1Status, 'CONFIRMED');
  assert.equal(result.h1Mode, 'AUTO');
  assert.equal(result.h1ConfirmationSource, 'PERSISTED');
  assert.equal(result.h1Sweep.persisted, true);
  assert.equal(result.h1Sweep.candle.time, sweep.time);
});

test('AUTO H1 ignores an old historical sweep when the latest completed candle has no sweep', () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const bars = [{ time: start, open: 104, high: 106, low: 100, close: 104 }];
  bars.push({ time: start + 1 * 60 * 60 * 1000, open: 99.5, high: 102, low: 99, close: 100.5 });
  for (let i = 2; i <= 501; i++) {
    bars.push({ time: start + i * 60 * 60 * 1000, open: 101, high: 102, low: 100.5, close: 101.4 });
  }
  const now = start + 502 * 60 * 60 * 1000;
  assert.equal(findHourlySweep(bars, 'bullish', start, now), null);
});

test('AUTO H1 compares the latest candle only with the immediately preceding H1 candle', () => {
  const start = Date.parse('2026-11-16T08:00:00Z');
  const first = { time: start, open: 102, high: 105, low: 100, close: 103 };
  const previous = { time: start + 60 * 60 * 1000, open: 101, high: 103, low: 98, close: 102 };
  const oldLevelOnly = { time: start + 2 * 60 * 60 * 1000, open: 99.5, high: 102, low: 99, close: 100.5 };
  assert.equal(findHourlySweep([first, previous, oldLevelOnly], 'bullish', start, start + 3 * 60 * 60 * 1000), null);
  const immediateSweep = { ...oldLevelOnly, low: 97, close: 99 };
  const result = findHourlySweep([first, previous, immediateSweep], 'bullish', start, start + 3 * 60 * 60 * 1000);
  assert.ok(result);
  assert.equal(result.level, previous.low);
  assert.equal(result.candleTime, immediateSweep.time);
  assert.equal(result.referenceCandleTime, previous.time);
  assert.equal(result.lookbackBars, 1);
});

test('persisted AUTO H1 confirmation remains active after a newer H1 candle closes', () => {
  const start = Date.parse('2026-11-16T08:00:00Z');
  const previous = { time: start, open: 102, high: 105, low: 100, close: 103 };
  const sweep = { time: start + 3600000, open: 101, high: 104, low: 97, close: 101 };
  const newer = { time: start + 7200000, open: 101, high: 103, low: 99, close: 102 };
  const bars = [previous, sweep, newer];
  const d1ConfirmationTime = start - 3600000;
  const active = {
    bias: 'BULLISH', d1ConfirmationTime, candleTime: sweep.time,
    closeTime: sweep.time + 3600000, referenceCandleTime: previous.time
  };
  assert.equal(findHourlySweep(bars, 'bullish', d1ConfirmationTime, start + 3 * 3600000), null);
  const retained = validateActiveHourlySweep(bars, 'bullish', d1ConfirmationTime, active, start + 3 * 3600000);
  assert.ok(retained);
  assert.equal(retained.persisted, true);
  assert.equal(retained.candle.time, sweep.time);
  assert.equal(retained.referenceCandleTime, previous.time);
});

test('persisted AUTO H1 confirmation is rejected when its D1 key or candle details do not match', () => {
  const start = Date.parse('2026-11-16T08:00:00Z');
  const previous = { time: start, open: 102, high: 105, low: 100, close: 103 };
  const sweep = { time: start + 3600000, open: 101, high: 104, low: 97, close: 101 };
  const newer = { time: start + 7200000, open: 101, high: 103, low: 99, close: 102 };
  const bars = [previous, sweep, newer];
  const active = {
    bias: 'BULLISH', d1ConfirmationTime: start - 3600000,
    candleTime: sweep.time, closeTime: sweep.time + 3600000,
    referenceCandleTime: previous.time
  };
  assert.equal(validateActiveHourlySweep(bars, 'bullish', start, active, start + 3 * 3600000), null);
  assert.equal(validateActiveHourlySweep(bars, 'bearish', start - 3600000, active, start + 3 * 3600000), null);
  assert.equal(validateActiveHourlySweep(bars, 'bullish', start - 3600000,
    { ...active, referenceCandleTime: start - 3600000 }, start + 3 * 3600000), null);
});

test('AUTO H1 does not treat an unfinished H1 candle as the latest completed candle', () => {
  const start = Date.parse('2026-11-16T08:00:00Z');
  const previous = { time: start, open: 102, high: 105, low: 100, close: 103 };
  const candidate = { time: start + 60 * 60 * 1000, open: 101, high: 104, low: 100.5, close: 102 };
  const unfinished = { time: start + 2 * 60 * 60 * 1000, open: 100, high: 103, low: 97, close: 100.5 };
  const now = start + 2 * 60 * 60 * 1000 + 30 * 60 * 1000;
  assert.equal(findHourlySweep([previous, candidate, unfinished], 'bullish', start, now), null);
});

test('first M5 entry retains a recent Fib 0.5 touch for one following candle', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const oldTouch = c('2026-11-10T05:00:00', 109, 111, 108, 109);
  const latest = c('2026-11-10T05:05:00', 113, 114, 112, 113);
  const entries = findM5Entries([oldTouch, latest], 'bullish', oldTouch.time, fib, [], Date.parse('2026-11-10T05:10:30Z'));
  const first = entries.find(entry => entry.type === 'FIRST_ENTRY');
  assert.ok(first);
  assert.equal(first.time, oldTouch.time);
  assert.equal(first.entry, fib['0.5']);
});

test('first M5 entry is not re-signalled after a later candle already hits SL or TP', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const touch = c('2026-11-10T05:00:00', 109, 111, 108, 109);
  const resolved = c('2026-11-10T05:05:00', 112, 121, 111, 119);
  const latest = c('2026-11-10T05:10:00', 114, 115, 113, 114);
  const entries = findM5Entries([touch, resolved, latest], 'bullish', touch.time, fib, [], Date.parse('2026-11-10T05:15:00Z'));
  assert.equal(entries.some(entry => entry.type === 'FIRST_ENTRY'), false);
});

test('first M5 entry recent-bar fallback rejects a touch older than the live freshness window', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const touch = c('2026-11-10T05:00:00', 109, 111, 108, 109);
  const latest = c('2026-11-10T05:05:00', 113, 114, 112, 113);
  const entries = findM5Entries([touch, latest], 'bullish', touch.time, fib, [], Date.parse('2026-11-10T05:30:00Z'));
  assert.equal(entries.some(entry => entry.type === 'FIRST_ENTRY'), false);
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

test('H1 freshness uses completed H1 close times and marks old history stale', () => {
  const now = Date.parse('2026-11-16T15:30:00Z');
  const freshBars = [
    c('2026-11-16T14:00:00', 10, 11, 9, 10.5),
    c('2026-11-16T15:00:00', 10.5, 11.5, 10, 11)
  ];
  const fresh = assessH1DataFreshness(freshBars, now);
  assert.equal(fresh.status, 'FRESH');
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMinutes, 30);
  assert.equal(fresh.latestCandleAt, new Date(freshBars[0].time).toISOString());
  assert.equal(fresh.latestCandleCloseAt, new Date(freshBars[0].time + 60 * 60 * 1000).toISOString());

  const staleBars = [c('2026-11-16T12:59:00', 10, 11, 9, 10.5)];
  const stale = assessH1DataFreshness(staleBars, now);
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.stale, true);
  assert.equal(stale.ageMinutes, 91);
});

test('H1 freshness ignores a still-open H1 candle and reports missing completed data', () => {
  const now = Date.parse('2026-11-16T15:30:00Z');
  const onlyOpen = [c('2026-11-16T15:00:00', 10, 11, 9, 10.5)];
  const result = assessH1DataFreshness(onlyOpen, now);
  assert.equal(result.status, 'NO_DATA');
  assert.equal(result.stale, true);
  assert.equal(result.latestCandleCloseAt, null);
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
  const gated = gateStrategyOnFreshness(strategy, { status: 'STALE', stale: true }, { status: 'FRESH', stale: false });
  assert.equal(gated.entryStatus, 'WAITING_FOR_FRESH_M5_DATA');
  assert.deepEqual(gated.entries, []);
  assert.equal(gated.riskWarning, null);
  assert.equal(strategy.entries.length, 1);
});

test('fresh M5 data preserves the strategy result unchanged', () => {
  const strategy = { h1Status: 'CONFIRMED', entryStatus: 'ENTRY_DETECTED', entries: [{ type: 'FIRST_ENTRY' }] };
  const result = gateStrategyOnFreshness(strategy, { status: 'FRESH', stale: false }, { status: 'FRESH', stale: false });
  assert.equal(result, strategy);
});

test('stale or missing H1 data blocks M5 entries in AUTO and MANUAL H1 modes', () => {
  const m5Fresh = { status: 'FRESH', stale: false };
  for (const h1Mode of ['AUTO', 'MANUAL']) {
    const strategy = {
      h1Status: 'CONFIRMED',
      h1Mode,
      entryStatus: 'ENTRY_DETECTED',
      entries: [{ type: 'FIRST_ENTRY', setupValid: true }],
      riskWarning: 'obsolete risk warning'
    };
    const stale = gateStrategyOnFreshness(strategy, m5Fresh, { status: 'STALE', stale: true });
    assert.equal(stale.entryStatus, 'WAITING_FOR_FRESH_H1_DATA');
    assert.deepEqual(stale.entries, []);
    assert.equal(stale.riskWarning, null);

    const missing = gateStrategyOnFreshness(strategy, m5Fresh, { status: 'NO_DATA', stale: true });
    assert.equal(missing.entryStatus, 'WAITING_FOR_FRESH_H1_DATA');
    assert.deepEqual(missing.entries, []);
  }
});

test('when both feeds are stale, H1 freshness is reported as the primary blocker', () => {
  const strategy = { h1Status: 'CONFIRMED', entryStatus: 'ENTRY_DETECTED', entries: [{ type: 'SECOND_ENTRY' }] };
  const result = gateStrategyOnFreshness(
    strategy,
    { status: 'STALE', stale: true },
    { status: 'STALE', stale: true }
  );
  assert.equal(result.entryStatus, 'WAITING_FOR_FRESH_H1_DATA');
  assert.deepEqual(result.entries, []);
});


test('freshness state gates H1 and M5 UI statuses in both UIs', () => {
  for (const file of ['../public/index.html', '../app/src/main/assets/index.html']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const m5StateIndex = source.indexOf('const dataStale =');
    const h1StateIndex = source.indexOf('const h1Freshness = payload.h1Freshness');
    const h1StatusIndex = source.indexOf("setMetric('h1', h1DisplayState");
    const entryStatusIndex = source.indexOf("setMetric('entry', entriesPaused ? 'PAUSED — STALE DATA'");
    assert.ok(m5StateIndex >= 0 && h1StateIndex >= 0 && h1StateIndex < m5StateIndex);
    assert.ok(h1StatusIndex > h1StateIndex);
    assert.ok(entryStatusIndex > m5StateIndex);
    assert.ok(source.includes('STALE H1 DATA'));
    assert.ok(source.includes('PAUSED — STALE DATA'));
    assert.ok(source.includes('Missing data is not treated as proof that no sweep occurred.'));
    assert.ok(source.includes('H1 FIBONACCI — REFERENCE CANDLE RANGE'));
    assert.ok(source.includes('No M5 entry condition detected after H1 confirmation.'));
    assert.ok(source.includes('const h1EntryPaused = h1DataStale && s.h1Status === \'CONFIRMED\';'));
    const staleBlockStart = source.indexOf('if(h1DataStale){');
    const manualStaleBranch = source.indexOf(`if(isManualH1 && s.h1Status === 'CONFIRMED')`, staleBlockStart);
    const genericSweepHistory = source.indexOf('const sweepHistory =', staleBlockStart);
    assert.ok(manualStaleBranch > staleBlockStart);
    assert.ok(genericSweepHistory > manualStaleBranch);
    const manualBranchText = source.slice(manualStaleBranch, genericSweepHistory);
    assert.ok(manualBranchText.includes('NOT a detected H1 liquidity sweep'));
    assert.ok(manualBranchText.includes('M5 entries are PAUSED until fresh H1 data is available'));
    assert.ok(source.includes('Entries are not evaluated until fresh H1 data is available.') || source.includes('Entry conditions are not evaluated until fresh H1 data is available.'));
  }
});

test('historical entry events are suppressed unless both M5 and H1 feeds are fresh', () => {
  const freshM5 = { status: 'FRESH', stale: false };
  const freshH1 = { status: 'FRESH', stale: false };
  assert.equal(marketDataFreshForEntries(freshM5, freshH1), true);
  assert.equal(marketDataFreshForEntries(freshM5, { status: 'STALE', stale: true }), false);
  assert.equal(marketDataFreshForEntries({ status: 'STALE', stale: true }, freshH1), false);
  assert.equal(marketDataFreshForEntries(null, freshH1), false);
  assert.equal(marketDataFreshForEntries(freshM5, null), false);
});

test('SiftingIO history requests fetch a wide enough window and newest bars first', () => {
  const now = Date.parse('2026-11-15T14:34:00.000Z');
  const m5 = buildSeriesUrl('XAUUSD', '5m', 500, now);
  assert.equal(m5.searchParams.get('interval'), '5m');
  assert.equal(m5.searchParams.get('limit'), '500');
  assert.equal(m5.searchParams.get('order'), 'desc');
  assert.equal(Date.parse(m5.searchParams.get('end')), now);
  assert.equal(now - Date.parse(m5.searchParams.get('start')), 500 * 5 * 60 * 1000 * 20);
  assert.ok(now - Date.parse(m5.searchParams.get('start')) > 30 * 24 * 60 * 60 * 1000);

  const h1 = buildSeriesUrl('XAUUSD', '1h', 1000, now);
  assert.equal(h1.searchParams.get('order'), 'desc');
  assert.equal(now - Date.parse(h1.searchParams.get('start')), 1000 * 60 * 60 * 1000 * 4);

  const d1 = buildSeriesUrl('XAUUSD', '1d', 350, now);
  assert.equal(d1.searchParams.get('order'), 'desc');
  assert.equal(now - Date.parse(d1.searchParams.get('start')), 350 * 24 * 60 * 60 * 1000 * 2);
});


test('SiftingIO bar parser normalizes timestamps and retains provider freshness metadata', () => {
  const base = Date.parse('2026-11-17T06:00:00Z');
  const parsed = parseSiftingBars({
    data: [
      { t: base, o: 100, h: 101, l: 99, c: 100.5, v: 1 },
      { t: base / 1000 + 3600, o: 100.5, h: 102, l: 100, c: 101, v: 2 },
      { t: new Date(base + 7200000).toISOString(), o: 101, h: 103, l: 100.5, c: 102, v: 3 }
    ],
    meta: { symbol: 'XAUUSD', interval: '1h', as_of: '2026-11-17T08:59:00Z', next_cursor: 'cursor-token' }
  });
  assert.deepEqual(parsed.map(bar => bar.time), [base, base + 3600000, base + 7200000]);
  assert.equal(buildLatestBarTimes([], parsed, []).H1, new Date(base + 7200000).toISOString());
  assert.deepEqual(parsed.providerMeta, {
    symbol: 'XAUUSD', interval: '1h', asOf: '2026-11-17T08:59:00Z', hasNextPage: true
  });
});

test('provider diagnostics compare SiftingIO as-of time with the latest completed H1 bar', () => {
  const base = Date.parse('2026-11-17T06:00:00Z');
  const parsed = parseSiftingBars({
    data: [{ t: base, o: 100, h: 101, l: 99, c: 100.5, v: 1 }],
    meta: { symbol: 'XAUUSD', interval: '1h', as_of: '2026-11-17T07:59:00Z' }
  });
  const diagnostics = describeSeries(parsed, '1h', Date.parse('2026-11-17T07:30:00Z'));
  assert.equal(diagnostics.receivedBars, 1);
  assert.equal(diagnostics.providerAsOf, '2026-11-17T07:59:00Z');
  assert.equal(diagnostics.latestCompletedBarCloseAt, '2026-11-17T07:00:00.000Z');
  assert.equal(diagnostics.latestCompletedAgeMinutes, 30);
  assert.equal(diagnostics.hasNextPage, false);
});

test('bar countdown receives latest real D1, H1 and M5 timestamps and preserves missing data', () => {
  const d1 = [c('2026-11-14T21:00:00', 100, 101, 99, 100.5), c('2026-11-15T21:00:00', 100.5, 102, 100, 101)];
  const h1 = [c('2026-11-16T08:00:00', 101, 102, 100, 101.5), c('2026-11-16T09:00:00', 101.5, 103, 101, 102)];
  const m5 = [c('2026-11-16T09:05:00', 102, 102.5, 101.5, 102.2), c('2026-11-16T09:10:00', 102.2, 103, 102, 102.8)];
  assert.deepEqual(buildLatestBarTimes(d1, h1, m5), {
    D1: new Date(d1[1].time).toISOString(),
    H1: new Date(h1[1].time).toISOString(),
    M5: new Date(m5[1].time).toISOString()
  });
  assert.deepEqual(buildLatestBarTimes([], [], []), { D1: null, H1: null, M5: null });
});

test('SiftingIO history URL rejects unsupported intervals and invalid limits', () => {
  assert.throws(() => buildSeriesUrl('XAUUSD', '15m', 100, Date.now()), /Unsupported SiftingIO interval/);
  assert.throws(() => buildSeriesUrl('XAUUSD', '5m', 2500, Date.now()), /limit must be an integer/);
});

test('one-minute fallback rebuilds H1 only from 60 consecutive completed real minutes', () => {
  const start = Date.parse('2026-11-18T05:00:00Z');
  const minutes = Array.from({ length: 60 }, (_, index) => ({
    time: start + index * 60000,
    open: 2300 + index * 0.1,
    high: 2301 + index * 0.1,
    low: 2299 + index * 0.1,
    close: 2300.5 + index * 0.1,
    volume: 2
  }));
  const result = buildHourlyBarsFromOneMinute(minutes, start + 60 * 60000);
  assert.equal(result.length, 1);
  assert.equal(result[0].time, start);
  assert.equal(result[0].open, 2300);
  assert.equal(result[0].high, 2301 + 59 * 0.1);
  assert.equal(result[0].low, 2299);
  assert.equal(result[0].close, 2300.5 + 59 * 0.1);
  assert.equal(result[0].volume, 120);
  assert.equal(assessH1DataFreshness(result, start + 70 * 60000).stale, false);
});

test('H1 fallback rejects a missing minute and an unfinished hourly bucket', () => {
  const start = Date.parse('2026-11-18T05:00:00Z');
  const minutes = Array.from({ length: 60 }, (_, index) => ({
    time: start + index * 60000,
    open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index, volume: 1
  }));
  assert.equal(buildHourlyBarsFromOneMinute(minutes.filter((_, index) => index !== 31), start + 60 * 60000).length, 0);
  assert.equal(buildHourlyBarsFromOneMinute(minutes, start + 59 * 60000).length, 0);
  assert.equal(buildHourlyBarsFromOneMinute(minutes, start + 60 * 60000).length, 1);
});

test('H1 fallback adds newer real hourly buckets and preserves provider H1 bars', () => {
  const start = Date.parse('2026-11-18T05:00:00Z');
  const providerBar = { time: start - 3600000, open: 90, high: 95, low: 89, close: 94, volume: 8 };
  const minutes = Array.from({ length: 120 }, (_, index) => ({
    time: start + index * 60000,
    open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index, volume: 1
  }));
  const merged = mergeHourlyBars([providerBar], minutes, start + 120 * 60000);
  assert.equal(merged.added, 2);
  assert.equal(merged.bars.length, 3);
  assert.equal(merged.bars[0].close, 94);
  assert.equal(merged.bars[1].time, start);
  assert.equal(merged.bars[2].time, start + 3600000);
  assert.equal(assessH1DataFreshness(merged.bars, start + 130 * 60000).stale, false);
});

test('one-minute fallback creates an M5 candle only from five complete real minutes', () => {
  const start = Date.parse('2026-11-16T00:00:00Z');
  const minutes = [
    { time: start, open: 100, high: 102, low: 99, close: 101, volume: 2 },
    { time: start + 60000, open: 101, high: 104, low: 100, close: 103, volume: 3 },
    { time: start + 120000, open: 103, high: 105, low: 102, close: 104, volume: 4 },
    { time: start + 180000, open: 104, high: 104, low: 101, close: 102, volume: 1 },
    { time: start + 240000, open: 102, high: 103, low: 98, close: 99, volume: 5 }
  ];
  const result = buildFiveMinuteBarsFromOneMinute(minutes, start + 300000);
  assert.equal(result.length, 1);
  assert.equal(result[0].time, start);
  assert.equal(result[0].open, 100);
  assert.equal(result[0].high, 105);
  assert.equal(result[0].low, 98);
  assert.equal(result[0].close, 99);
  assert.equal(result[0].volume, 15);
});

test('one-minute fallback refuses missing minutes and an unfinished M5 bucket', () => {
  const start = Date.parse('2026-11-16T00:00:00Z');
  const fiveMinutes = Array.from({ length: 5 }, (_, index) => ({
    time: start + index * 60000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1
  }));
  assert.equal(buildFiveMinuteBarsFromOneMinute(fiveMinutes.filter((_, index) => index !== 2), start + 300000).length, 0);
  assert.equal(buildFiveMinuteBarsFromOneMinute(fiveMinutes, start + 299999).length, 0);
  assert.equal(buildFiveMinuteBarsFromOneMinute(fiveMinutes, start + 300000).length, 1);
});

test('one-minute fallback adds newer M5 bars without overwriting provider M5 candles', () => {
  const start = Date.parse('2026-11-16T00:00:00Z');
  const providerBar = { time: start, open: 90, high: 95, low: 89, close: 94, volume: 8 };
  const minuteBars = Array.from({ length: 10 }, (_, index) => ({
    time: start + index * 60000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1
  }));
  const merged = mergeFiveMinuteBars([providerBar], minuteBars, start + 600000);
  assert.equal(merged.added, 1);
  assert.equal(merged.bars.length, 2);
  assert.equal(merged.bars[0].close, 94);
  assert.equal(merged.bars[1].time, start + 300000);
  assert.equal(assessMarketDataFreshness(merged.bars, start + 600000).stale, false);
});

test('D1 pending sweep details are retained and distinguish sweep from confirmation', () => {
  const bars = [];
  for (let day = 1; day <= 7; day++) {
    bars.push(c('2026-11-' + String(day).padStart(2, '0') + 'T00:00:00', 105, 110, 100, 106));
  }
  bars.push(c('2026-11-08T00:00:00', 118, 120, 95, 115));
  const result = analyzeStrategy({ d1: bars, h1: [], m5: [] });
  assert.equal(result.bias, 'WAITING');
  assert.equal(result.h1Status, 'WAITING_FOR_D1');
  assert.equal(result.d1Sweep.side, 'bullish');
  assert.equal(result.d1Sweep.levelName, 'PDL');
  assert.equal(result.d1Sweep.time, bars[7].time);
  assert.equal(result.d1BarsAfterSweep, 0);
  assert.match(result.biasReason, /no confirmation yet/i);
});

test('D1 waiting UI explains the later completed-candle confirmation rule in both apps', () => {
  for (const file of ['../public/index.html', '../app/src/main/assets/index.html']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(source.includes('later completed D1 candle must close above the previous D1 high'));
    assert.ok(source.includes('The sweep candle itself cannot confirm its own sweep.'));
    assert.ok(source.includes('d1Sweep.levelName'));
    assert.ok(source.includes('No later completed D1 candle is available yet.'));
    assert.ok(source.includes("'SWEEP DETECTED'"));
  }
});
