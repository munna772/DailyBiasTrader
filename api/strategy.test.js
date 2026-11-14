'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findSweep, calculateFib, candleTouches, findHourlySweep, findM5Entries, isInsideThreeBullish, isInsideThreeBearish } = require('./strategy');

function c(time, open, high, low, close) {
  return { time: Date.parse(time + 'Z'), open, high, low, close, volume: 1 };
}

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

test('second entry preserves the specified candle-high stop for BUY and blocks its wrong side', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const bars = [c('2026-11-10T05:00:00', 108, 115, 106, 108)];
  const entries = findM5Entries(bars, 'bullish', bars[0].time, fib);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.stopLoss, 115);
  assert.equal(second.stopValid, false);
  assert.equal(second.status, 'BLOCKED_INVALID_STOP_SIDE');
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

test('second M5 entry reports the latest completed 0.618 sweep, not the oldest historical one', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const older = c('2026-11-10T05:00:00', 113, 115, 111, 113);
  const newer = c('2026-11-10T05:05:00', 108, 116, 106, 109);
  const entries = findM5Entries([older, newer], 'bullish', older.time, fib, [older, newer]);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.time, newer.time);
});


test('first BUY entry uses 0.618 below entry as stop and 1 as target', () => {
  const fib = { '0': 120, '0.5': 110, '0.618': 107.64, '1': 100 };
  const current = c('2026-11-10T06:00:00', 109, 111, 108, 109);
  const entries = findM5Entries([current], 'bullish', current.time, fib, []);
  const first = entries.find(e => e.type === 'FIRST_ENTRY');
  assert.ok(first);
  assert.equal(first.stopLoss, 107.64);
  assert.equal(first.takeProfit, 120);
  assert.equal(first.stopValid, true);
});

test('first SELL entry uses 0.618 above entry as stop and 1 as target', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const current = c('2026-11-10T06:00:00', 111, 112, 109, 111);
  const entries = findM5Entries([current], 'bearish', current.time, fib, []);
  const first = entries.find(e => e.type === 'FIRST_ENTRY');
  assert.ok(first);
  assert.equal(first.stopLoss, 112.36);
  assert.equal(first.takeProfit, 100);
  assert.equal(first.stopValid, true);
});
